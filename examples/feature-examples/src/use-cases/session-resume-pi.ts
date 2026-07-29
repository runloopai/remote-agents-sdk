import { isPiAssistantTextDeltaEvent } from "@runloop/remote-agents-sdk/pi";
import type { UseCase } from "../types.js";

const CODEWORD = "pineapple";
const MEMORY_PROMPT = `Remember this codeword: "${CODEWORD}". Reply with just OK.`;
const RECALL_PROMPT = "What is the codeword I asked you to remember? Reply with just the codeword.";

/**
 * Session resume: Pi persists each session as a transcript file on the devbox.
 * `getState()` reports its path as `sessionFile` — start a session, converse on
 * it, switch to a fresh session, then `switchSession()` back to the original
 * file and verify its context is intact.
 *
 * (Broker-driven resume after a devbox restart needs nothing from the client:
 * the broker replays the session file it owns under `--session-dir`. This
 * demonstrates client-driven resume of a known session path.)
 */
export default {
  name: "session-resume-pi",
  description: "Resume a persisted session by file path and verify context is preserved",
  protocols: ["pi"],
  timeoutMs: 60_000,

  async run(ctx) {
    if (!ctx.pi) {
      ctx.skip("Pi connection required");
      return;
    }
    const pi = ctx.pi;

    // Turn 1: establish context on the session the broker spawned Pi with.
    const firstState = await pi.getState();
    const firstSessionFile = firstState.sessionFile;
    if (!firstSessionFile) {
      throw new Error("get_state reported no sessionFile — cannot resume without one");
    }
    ctx.log(`Session A: ${firstState.sessionId} (${firstSessionFile})`);

    ctx.log(`Sending memory prompt: "${MEMORY_PROMPT}"`);
    await pi.send(MEMORY_PROMPT);
    for await (const _frame of pi.receiveTurn()) {
      // Drain until agent_settled.
    }

    // Switch to a fresh session — Pi now targets it, without the codeword.
    await pi.newSession();
    const secondState = await pi.getState();
    ctx.log(`Session B: ${secondState.sessionId} (${secondState.sessionFile})`);
    if (secondState.sessionId === firstState.sessionId) {
      throw new Error("new_session did not create a new session");
    }

    // Resume the first session by its file path.
    await pi.switchSession(firstSessionFile);
    const resumedState = await pi.getState();
    if (resumedState.sessionId !== firstState.sessionId) {
      throw new Error(
        `switch_session did not restore session A (got ${resumedState.sessionId}, want ${firstState.sessionId})`,
      );
    }
    ctx.log(`Resumed session A: ${resumedState.sessionId}`);

    // Turn 2 on the resumed session: the codeword must still be in context.
    let responseText = "";
    const unsubscribe = pi.onTimelineEvent((event) => {
      if (isPiAssistantTextDeltaEvent(event)) {
        responseText += event.data.assistantMessageEvent.delta;
      }
    });

    ctx.log(`Sending recall prompt: "${RECALL_PROMPT}"`);
    await pi.send(RECALL_PROMPT);
    for await (const _frame of pi.receiveTurn()) {
      // Drain until agent_settled.
    }
    unsubscribe();

    if (!responseText.toLowerCase().includes(CODEWORD)) {
      throw new Error(
        `Resumed session lost context — expected "${CODEWORD}" in response, got: ${responseText}`,
      );
    }

    ctx.log("Pass: Resumed session recalled the codeword from before the switch");
  },
} satisfies UseCase;

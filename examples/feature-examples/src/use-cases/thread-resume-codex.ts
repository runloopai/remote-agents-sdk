import { isCodexItemCompletedEvent } from "@runloop/remote-agents-sdk/codex";
import type { UseCase } from "../types.js";

const CODEWORD = "pineapple";
const MEMORY_PROMPT = `Remember this codeword: "${CODEWORD}". Reply with just OK.`;
const RECALL_PROMPT = "What is the codeword I asked you to remember? Reply with just the codeword.";

/**
 * Thread resume: Codex has real server-side threads. The connection tracks the
 * current thread id — start a thread, converse on it, switch to a fresh thread,
 * then `resumeThread()` the original and verify its context is intact.
 *
 * (Broker-driven resume after a devbox restart needs nothing from the client;
 * this demonstrates client-driven resume of a known thread id.)
 */
export default {
  name: "thread-resume-codex",
  description: "Resume a server-side thread by id and verify context is preserved",
  protocols: ["codex"],
  timeoutMs: 30_000,

  async run(ctx) {
    if (!ctx.codex) {
      ctx.skip("Codex connection required");
      return;
    }
    const codex = ctx.codex;

    // Turn 1: establish context on the first thread.
    const firstThreadId = await codex.startThread({ cwd: "/home/user" });
    ctx.log(`Thread A ready: ${firstThreadId}`);

    ctx.log(`Sending memory prompt: "${MEMORY_PROMPT}"`);
    await codex.send(MEMORY_PROMPT);
    for await (const _frame of codex.receiveTurn()) {
      // Drain until turn/completed.
    }

    // Switch to a fresh thread — the connection now targets it.
    const secondThreadId = await codex.startThread({ cwd: "/home/user" });
    ctx.log(`Thread B ready: ${secondThreadId}`);
    if (secondThreadId === firstThreadId) {
      throw new Error("Second startThread() did not create a new thread");
    }

    // Resume the first thread and verify the connection tracks it again.
    await codex.resumeThread(firstThreadId);
    if (codex.threadId !== firstThreadId) {
      throw new Error(
        `resumeThread did not update the tracked thread id (got ${codex.threadId})`,
      );
    }
    ctx.log(`Resumed thread A: ${firstThreadId}`);

    // Turn 2 on the resumed thread: the codeword must still be in context.
    let responseText = "";
    const unsubscribe = codex.onTimelineEvent((event) => {
      if (isCodexItemCompletedEvent(event) && event.data.params.item.type === "agentMessage") {
        responseText += event.data.params.item.text;
      }
    });

    ctx.log(`Sending recall prompt: "${RECALL_PROMPT}"`);
    await codex.send(RECALL_PROMPT);
    for await (const _frame of codex.receiveTurn()) {
      // Drain until turn/completed.
    }
    unsubscribe();

    if (!responseText.toLowerCase().includes(CODEWORD)) {
      throw new Error(
        `Resumed thread lost context — expected "${CODEWORD}" in response, got: ${responseText}`,
      );
    }

    ctx.log("Pass: Resumed thread recalled the codeword from before the switch");
  },
} satisfies UseCase;

import { isAgentTextChunk } from "@runloop/remote-agents-sdk/acp";
import { isClaudeAssistantTextEvent, isClaudeResultEvent } from "@runloop/remote-agents-sdk/claude";
import type { UseCase } from "../types.js";
import { waitFor } from "../validator.js";

const PROMPT = "Say hello world";
// prompt() can resolve *before* the broker flushes session/update
// notifications for this turn, so give chunks a grace window to arrive.
const ACP_CHUNK_WAIT_MS = 5_000;

const GEMINI_QUOTA_SKIP =
  "Untestable on this account: Gemini API quota exhausted (verified working with sufficient quota)";

/** Single-prompt: send one prompt, receive a text response. */
export default {
  name: "single-prompt",
  description: "Send one prompt, receive text response",
  protocols: ["acp", "claude"],
  timeoutMs: 30_000,

  skipForAgents: {
    "gemini-cli": GEMINI_QUOTA_SKIP,
  },

  async run(ctx) {
    if (ctx.acp) {
      ctx.log("Running ACP path...");

      const chunks: string[] = [];
      const unsub = ctx.acp.onSessionUpdate((_sessionId, update) => {
        if (isAgentTextChunk(update)) {
          chunks.push(update.content.text);
        }
      });

      ctx.log(`Sending prompt: "${PROMPT}"`);
      await ctx.acp.prompt({
        sessionId: ctx.sessionId!,
        prompt: [{ type: "text", text: PROMPT }],
      });

      const hasText = () => chunks.some((c) => c.trim().length > 0);
      await waitFor(hasText, ACP_CHUNK_WAIT_MS);
      unsub();

      ctx.log(`Received ${chunks.length} text chunks`);
      if (!hasText()) {
        throw new Error("Agent did not respond with any text");
      }

      ctx.log("Pass: Agent responded with text");
    } else if (ctx.claude) {
      ctx.log("Running Claude path...");

      let hasAssistantText = false;
      let resultError: string | undefined;
      let onResult: () => void;
      const resultReceived = new Promise<void>((resolve) => {
        onResult = resolve;
      });

      const unsub = ctx.claude.onTimelineEvent((event) => {
        if (isClaudeAssistantTextEvent(event)) {
          hasAssistantText = true;
        }
        if (isClaudeResultEvent(event)) {
          if (event.data.is_error) resultError = `Result was an error: ${event.data.subtype}`;
          onResult();
        }
      });

      ctx.log(`Sending prompt: "${PROMPT}"`);
      await ctx.claude.send(PROMPT);
      await resultReceived;
      unsub();

      if (resultError) throw new Error(resultError);
      if (!hasAssistantText) throw new Error("Assistant did not respond with any text");

      ctx.log("Pass: Agent responded with text");
    } else {
      ctx.skip("No connection available");
    }
  },
} satisfies UseCase;

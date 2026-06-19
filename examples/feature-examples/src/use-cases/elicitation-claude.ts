import type { UseCase } from "../types.js";

const PROMPT = "Ask me a question before proceeding with any task.";
const ANSWER = "My favorite color is blue.";

export default {
  name: "elicitation-claude",
  description: "Handle agent-initiated user input via Claude conversational flow",
  protocols: ["claude"],
  timeoutMs: 30_000,

  async run(ctx) {
    if (!ctx.claude) {
      ctx.skip("Claude connection required");
      return;
    }

    let turn1HasText = false;
    let turn1Error: string | undefined;
    let turn2HasText = false;
    let turn2Error: string | undefined;

    ctx.log(`Turn 1: Sending prompt to elicit a question: "${PROMPT}"`);
    await ctx.claude.send(PROMPT);

    for await (const msg of ctx.claude.receiveAgentResponse()) {
      if (msg.type === "assistant") {
        turn1HasText = true;
      }
      if (msg.type === "result") {
        if ((msg as { is_error?: boolean }).is_error) {
          turn1Error = (msg as { subtype?: string }).subtype ?? "unknown error";
        }
      }
    }

    if (turn1Error) throw new Error(`Turn 1 error: ${turn1Error}`);
    if (!turn1HasText) throw new Error("Turn 1: Agent did not produce any text (expected a question)");
    ctx.log("Turn 1 complete: Agent asked a question");

    ctx.log(`Turn 2: Sending answer: "${ANSWER}"`);
    await ctx.claude.send(ANSWER);

    for await (const msg of ctx.claude.receiveAgentResponse()) {
      if (msg.type === "assistant") {
        turn2HasText = true;
      }
      if (msg.type === "result") {
        if ((msg as { is_error?: boolean }).is_error) {
          turn2Error = (msg as { subtype?: string }).subtype ?? "unknown error";
        }
      }
    }

    if (turn2Error) throw new Error(`Turn 2 error: ${turn2Error}`);
    if (!turn2HasText) throw new Error("Turn 2: Agent did not produce any text after receiving answer");

    ctx.log("Pass: Two-turn elicitation completed (agent asked question, received answer, responded)");
  },
} satisfies UseCase;

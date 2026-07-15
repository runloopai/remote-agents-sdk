import type { UseCase } from "../types.js";

const PROMPT =
  "Create an empty file at /home/user/approval-test.txt using the shell, then confirm it exists.";

/**
 * Approval round-trip: start a thread that routes command execution through the
 * client, register `onApprovalRequest` handlers, and verify the server-initiated
 * approval request arrives and is answered before the turn completes.
 *
 * The thread is started with a read-only sandbox and `approvalPolicy: "on-request"`
 * so writing a file forces Codex to ask for approval. Without a handler the SDK
 * auto-approves (see `CodexAxonConnection.onApprovalRequest` docs); mounting with
 * `launch_args: ["-c", "approval_policy=never"]` skips approval traffic entirely.
 */
export default {
  name: "approval-codex",
  description: "Handle a server-initiated command approval round-trip via onApprovalRequest",
  protocols: ["codex"],
  timeoutMs: 30_000,

  async run(ctx) {
    if (!ctx.codex) {
      ctx.skip("Codex connection required");
      return;
    }

    ctx.log("Starting thread with read-only sandbox and on-request approvals...");
    const threadId = await ctx.codex.startThread({
      cwd: "/home/user",
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    ctx.log(`Thread ready: ${threadId}`);

    const approvedMethods: string[] = [];
    // Register both the current and legacy command approval methods — which one
    // the app-server sends depends on the Codex CLI version.
    const unsubscribes = [
      ctx.codex.onApprovalRequest("item/commandExecution/requestApproval", (request) => {
        approvedMethods.push(request.method);
        ctx.log(`Approving command execution (item ${request.params.itemId})`);
        return { decision: "accept" };
      }),
      ctx.codex.onApprovalRequest("execCommandApproval", (request) => {
        approvedMethods.push(request.method);
        ctx.log(`Approving command execution (legacy, call ${request.params.callId})`);
        return { decision: "approved" };
      }),
    ];

    ctx.log(`Sending prompt: "${PROMPT}"`);
    await ctx.codex.send(PROMPT);

    // Drain the turn — approval requests are answered by the handlers above
    // while notifications stream past; the generator ends on turn/completed.
    for await (const frame of ctx.codex.receiveTurn()) {
      if (frame.method === "error") {
        throw new Error(`Turn error: ${JSON.stringify(frame.params)}`);
      }
    }
    for (const unsubscribe of unsubscribes) unsubscribe();

    if (approvedMethods.length === 0) {
      throw new Error("Agent completed the turn without requesting command approval");
    }

    ctx.log(`Pass: Approval round-trip completed (${approvedMethods.join(", ")})`);
  },
} satisfies UseCase;

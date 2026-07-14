import type { Express } from "express";
import type { AgentRegistry } from "../agent-registry.ts";
import { asyncHandler, requireAgent } from "./helpers.ts";

export function registerCodexRoutes(app: Express, registry: AgentRegistry) {
  app.post(
    "/api/approval-response",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;
      if (entry.agentType !== "codex" || !entry.codexManager) {
        res.status(400).json({ error: "Not a Codex session" });
        return;
      }
      const { requestId, approve } = req.body;
      if (!requestId) {
        res.status(400).json({ error: "requestId is required" });
        return;
      }
      if (!entry.codexManager.resolveApproval(String(requestId), approve === true)) {
        res
          .status(404)
          .json({ error: `No pending approval request with id ${requestId}` });
        return;
      }
      res.json({ ok: true });
    }),
  );
}

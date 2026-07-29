import type { Express, Response } from "express";
import type { AgentEntry, AgentRegistry } from "../agent-registry.ts";
import type { PiConnectionManager } from "../pi-manager.ts";
import { asyncHandler, requireAgent } from "./helpers.ts";

function requirePiManager(entry: AgentEntry, res: Response): PiConnectionManager | null {
  if (entry.agentType !== "pi" || !entry.piManager) {
    res.status(400).json({ error: "Not a Pi session" });
    return null;
  }
  return entry.piManager;
}

export function registerPiRoutes(app: Express, registry: AgentRegistry) {
  // Pi's session snapshot. `sessionFile` is the transcript path the broker
  // persists, so this is how the UI shows that a resumed session is the same
  // one as before a suspend.
  app.post(
    "/api/pi/state",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;
      const manager = requirePiManager(entry, res);
      if (!manager) return;
      res.json({ state: await manager.getState() });
    }),
  );

  // Steer redirects the in-flight turn; follow-up queues a message for after it
  // settles. Both are distinct from /api/prompt, which starts a turn and which
  // Pi rejects while it is streaming.
  app.post(
    "/api/pi/queue",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;
      const manager = requirePiManager(entry, res);
      if (!manager) return;
      const { message, mode } = req.body;
      if (typeof message !== "string" || !message.trim()) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (mode !== "steer" && mode !== "follow_up") {
        res.status(400).json({ error: 'mode must be "steer" or "follow_up"' });
        return;
      }
      await manager.queue(message, mode);
      res.json({ ok: true });
    }),
  );
}

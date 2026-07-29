import type { Express } from "express";
import { ACPConnectionManager } from "../acp-manager.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { ClaudeConnectionManager } from "../claude-manager.ts";
import { CodexConnectionManager } from "../codex-manager.ts";
import { PiConnectionManager } from "../pi-manager.ts";
import type { WsBroadcaster } from "../ws.ts";
import { asyncHandler, requireAgent } from "./helpers.ts";

export function registerLifecycleRoutes(app: Express, registry: AgentRegistry, ws: WsBroadcaster) {
  app.get("/api/agents", (_req, res) => {
    res.json({ agents: registry.list() });
  });

  app.post(
    "/api/subscribe",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;

      if (entry.agentType === "claude" && entry.claudeManager) {
        await entry.claudeManager.subscribe();
      } else if (entry.agentType === "acp" && entry.acpManager) {
        await entry.acpManager.subscribe();
      } else if (entry.agentType === "codex" && entry.codexManager) {
        await entry.codexManager.subscribe();
      } else if (entry.agentType === "pi" && entry.piManager) {
        await entry.piManager.subscribe();
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/start",
    asyncHandler(async (req, res) => {
      const { agentType, ...config } = req.body;
      const agentId = registry.generateId();

      if (agentType === "claude") {
        const manager = new ClaudeConnectionManager(ws, agentId);
        const result = await manager.start(config);
        registry.add({
          id: agentId,
          agentType: "claude",
          name: config.blueprintName ?? "Claude Agent",
          axonId: result.axonId,
          devboxId: result.devboxId,
          createdAt: Date.now(),
          claudeManager: manager,
        });
        manager.connection
          ?.publish({
            event_type: "agent_started",
            origin: "EXTERNAL_EVENT",
            payload: JSON.stringify({ agentType: "claude", agentId, ...config }),
            source: "combined-app",
          })
          .catch((err: unknown) =>
            console.error("[agent_started] publish failed:", err),
          );
        res.json({ agentId, agentType: "claude", ...result });
      } else if (agentType === "codex") {
        const manager = new CodexConnectionManager(ws, agentId);
        const result = await manager.start(config);
        registry.add({
          id: agentId,
          agentType: "codex",
          name: config.blueprintName ?? "Codex Agent",
          axonId: result.axonId,
          devboxId: result.devboxId,
          createdAt: Date.now(),
          codexManager: manager,
        });
        manager.connection
          ?.publish({
            event_type: "agent_started",
            origin: "EXTERNAL_EVENT",
            payload: JSON.stringify({ agentType: "codex", agentId, ...config }),
            source: "combined-app",
          })
          .catch((err: unknown) =>
            console.error("[agent_started] publish failed:", err),
          );
        res.json({ agentId, agentType: "codex", ...result });
      } else if (agentType === "pi") {
        const manager = new PiConnectionManager(ws, agentId);
        const result = await manager.start(config);
        registry.add({
          id: agentId,
          agentType: "pi",
          name: config.blueprintName ?? "Pi Agent",
          axonId: result.axonId,
          devboxId: result.devboxId,
          createdAt: Date.now(),
          piManager: manager,
        });
        manager.connection
          ?.publish({
            event_type: "agent_started",
            origin: "EXTERNAL_EVENT",
            payload: JSON.stringify({ agentType: "pi", agentId, ...config }),
            source: "combined-app",
          })
          .catch((err: unknown) =>
            console.error("[agent_started] publish failed:", err),
          );
        res.json({ agentId, agentType: "pi", ...result });
      } else {
        const manager = new ACPConnectionManager(ws, agentId);
        const result = await manager.start(config);
        registry.add({
          id: agentId,
          agentType: "acp",
          name: config.agentBinary ?? "ACP Agent",
          axonId: result.axonId,
          devboxId: result.devboxId,
          createdAt: Date.now(),
          acpManager: manager,
        });
        manager.connection
          ?.publish({
            event_type: "agent_started",
            origin: "EXTERNAL_EVENT",
            payload: JSON.stringify({ agentType: "acp", agentId, ...config }),
            source: "combined-app",
          })
          .catch((err: unknown) =>
            console.error("[agent_started] publish failed:", err),
          );
        res.json({ agentId, agentType: "acp", ...result });
      }
    }),
  );

  app.post(
    "/api/shutdown",
    asyncHandler(async (req, res) => {
      const { agentId } = req.body;
      if (!agentId) {
        await registry.shutdownAll();
        res.json({ ok: true });
        return;
      }
      await registry.shutdown(agentId);
      res.json({ ok: true });
    }),
  );
}

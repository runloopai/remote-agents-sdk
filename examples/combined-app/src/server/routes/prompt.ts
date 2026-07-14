import type { Express } from "express";
import type { AgentRegistry } from "../agent-registry.ts";
import type { WsBroadcaster } from "../ws.ts";
import { asyncHandler, requireAgent } from "./helpers.ts";

export function registerPromptRoutes(app: Express, registry: AgentRegistry, ws: WsBroadcaster) {
  app.post(
    "/api/prompt",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;

      if (entry.agentType === "claude") {
        const manager = entry.claudeManager!;
        if (!manager.connection) {
          res.status(400).json({ error: "Not connected" });
          return;
        }
        const { content, text } = req.body;

        let prompt: string | Record<string, unknown>;

        if (
          Array.isArray(content) &&
          content.some((c: Record<string, unknown>) => c.type !== "text")
        ) {
          const blocks: unknown[] = content.map(
            (item: Record<string, unknown>) => {
              switch (item.type) {
                case "image":
                  return {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: item.mimeType,
                      data: item.data,
                    },
                  };
                case "file":
                  return {
                    type: "text",
                    text: `--- ${item.name} ---\n${item.text}`,
                  };
                default:
                  return { type: "text", text: item.text ?? "" };
              }
            },
          );
          prompt = {
            type: "user",
            message: { role: "user", content: blocks },
            parent_tool_use_id: null,
          };
        } else {
          prompt = text ?? content?.[0]?.text ?? "";
        }

        manager.send(prompt).catch((err: unknown) => {
          ws.broadcast({
            type: "turn_error",
            agentId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        res.json({ ok: true });
      } else if (entry.agentType === "codex") {
        const manager = entry.codexManager!;
        if (!manager.connection) {
          res.status(400).json({ error: "Not connected" });
          return;
        }
        const { content, text } = req.body;

        const contentItems: Record<string, unknown>[] = Array.isArray(content)
          ? content
          : [{ type: "text", text }];

        // Map attachments onto Codex UserInput items. Images ride along as
        // data URLs; file attachments are flattened into text.
        const prompt = contentItems.map((item) => {
          switch (item.type) {
            case "image":
              return {
                type: "image" as const,
                url: `data:${item.mimeType};base64,${item.data}`,
              };
            case "file":
              return {
                type: "text" as const,
                text: `--- ${item.name} ---\n${item.text}`,
                text_elements: [],
              };
            default:
              return {
                type: "text" as const,
                text: (item.text ?? "") as string,
                text_elements: [],
              };
          }
        });

        manager.send(prompt).catch((err: unknown) => {
          ws.broadcast({
            type: "turn_error",
            agentId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        res.json({ ok: true });
      } else {
        const manager = entry.acpManager!;
        const connection = manager.requireConnection();
        const sessionId = manager.activeSessionId;
        if (!sessionId) {
          res.status(400).json({ error: "No active session" });
          return;
        }
        const { content, text } = req.body;

        const contentItems: Record<string, unknown>[] = Array.isArray(content)
          ? content
          : [{ type: "text", text }];

        const prompt = contentItems.map((item) => {
          switch (item.type) {
            case "image":
              return {
                type: "image" as const,
                data: item.data as string,
                mimeType: item.mimeType as string,
              };
            case "file":
              return {
                type: "resource" as const,
                resource: {
                  uri: `file:///${item.name}`,
                  text: item.text as string,
                  mimeType: item.mimeType as string,
                },
              };
            default:
              return { type: "text" as const, text: (item.text ?? "") as string };
          }
        });

        connection
          .prompt({ sessionId, prompt })
          .then((resp) => {
            console.log("[prompt] turn complete, stopReason:", resp.stopReason);
          })
          .catch((err) => {
            console.error("[prompt] turn error:", err);
            ws.broadcast({
              type: "turn_error",
              agentId: entry.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });

        res.json({ ok: true });
      }
    }),
  );

  app.post(
    "/api/cancel",
    asyncHandler(async (req, res) => {
      const entry = requireAgent(req, res, registry);
      if (!entry) return;

      if (entry.agentType === "claude") {
        await entry.claudeManager!.interrupt();
      } else if (entry.agentType === "codex") {
        await entry.codexManager!.interrupt();
      } else {
        const { connection, sessionId } = entry.acpManager!.requireSession();
        await connection.cancel({ sessionId });
      }
      res.json({ ok: true });
    }),
  );
}

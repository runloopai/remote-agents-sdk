import express from "express";
import { createServer } from "node:http";
import { AgentRegistry } from "./agent-registry.ts";
import { registerACPRoutes } from "./routes/acp.ts";
import { registerClaudeRoutes } from "./routes/claude.ts";
import { registerCodexRoutes } from "./routes/codex.ts";
import { registerDebugRoutes } from "./routes/debug.ts";
import { registerLifecycleRoutes } from "./routes/lifecycle.ts";
import { registerPiRoutes } from "./routes/pi.ts";
import { registerPromptRoutes } from "./routes/prompt.ts";
import { WsBroadcaster } from "./ws.ts";

const app = express();
app.use(express.json());

const server = createServer(app);
const ws = new WsBroadcaster(server);
const registry = new AgentRegistry();

registerLifecycleRoutes(app, registry, ws);
registerPromptRoutes(app, registry, ws);
registerClaudeRoutes(app, registry);
registerACPRoutes(app, registry);
registerCodexRoutes(app, registry);
registerPiRoutes(app, registry);
registerDebugRoutes(app, registry);

const PORT = process.env.PORT ?? 3003;
server.listen(PORT, () => {
  console.log(`Combined App server listening on http://localhost:${PORT}`);
  console.log(`Open the app at http://localhost:5176 (Vite dev server)`);
  console.log(
    `RUNLOOP_API_KEY: ${process.env.RUNLOOP_API_KEY ? "set" : "NOT SET"}`,
  );
  console.log(
    `ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}`,
  );
  console.log(
    `OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "set" : "NOT SET"}, CODEX_AUTH_JSON: ${process.env.CODEX_AUTH_JSON ? "set" : "NOT SET"} (Codex agents need one of these)`,
  );
  console.log(
    `NEBIUS_API_KEY: ${process.env.NEBIUS_API_KEY ? "set" : "NOT SET"}, NEBIUS_BASE_URL: ${process.env.NEBIUS_BASE_URL ? "set" : "NOT SET"} (Pi agents need both)`,
  );
});

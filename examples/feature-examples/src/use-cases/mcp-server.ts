import type { McpServer } from "@agentclientprotocol/sdk";
import { isToolCall, isToolCallProgress } from "@runloop/remote-agents-sdk/acp";
import {
  isClaudeResultEvent,
  isClaudeSystemInitEvent,
} from "@runloop/remote-agents-sdk/claude";
import { DEFAULT_USER_HOME } from "../scaffold.js";
import type { UseCase } from "../types.js";
import { waitFor } from "../validator.js";

/**
 * MCP server: attach a public HTTP MCP server (DeepWiki) to a session and
 * verify the agent can see/use it.
 *
 * Why DeepWiki:
 * - Public, no auth, HTTP transport — works identically for ACP `mcpServers`
 *   and Claude `--mcp-config`.
 * - Avoids on-devbox install latency (no `npx` cold start).
 *
 * ACP success criterion: the agent emits a `tool_call` (or `tool_call_update`)
 * whose identifier fields (`title`, `rawInput`, `_meta`) reference the
 * deepwiki MCP server. Different ACP agents serialize MCP tool identity
 * differently (e.g. opencode uses `title: "deepwiki_ask_question"`,
 * codex-acp uses `rawInput.server: "deepwiki"`, qwen uses
 * `_meta.toolName: "mcp__deepwiki__ask_question"`), so we walk known
 * identifier fields rather than regex over the JSON blob.
 *
 * Claude success criterion: the per-turn `system/init` payload from the broker
 * lists `deepwiki` in `mcp_servers` — confirming the CLI loaded the MCP config
 * without needing to wait on the model to invoke the tool.
 *
 * gemini-cli note: gemini-cli does not honour ACP `newSession.mcpServers`.
 * Instead it discovers MCP servers from `~/.gemini/settings.json` at startup,
 * so we mount that file via `extraMountsByAgent` so it is on disk before the
 * broker eagerly spawns gemini at devbox boot (gemini reads its config exactly
 * once on startup, so writing after `devbox.create()` returns is too late).
 * The `--skip-trust` launch flag (so MCP tools are exposed in untrusted
 * workspaces) lives in the base gemini-cli config in `agents.ts`.
 */

const MCP_NAME = "deepwiki";
const MCP_URL = "https://mcp.deepwiki.com/mcp";

// We point DeepWiki at our own repo so the test target can't disappear out
// from under us — we own this repo so it's certain to exist.
const DEEPWIKI_REPO = "runloopai/remote-agents-sdk";

const PROMPT =
  `Use the ${MCP_NAME} MCP server to call its ask_question tool with ` +
  `repo "${DEEPWIKI_REPO}" and question "What is this repo about?". ` +
  `Reply with one short sentence summarising the answer.`;

const ACP_MCP_SERVERS: McpServer[] = [
  { type: "http", name: MCP_NAME, url: MCP_URL, headers: [] },
];

const CLAUDE_MCP_LAUNCH_ARGS = [
  "--dangerously-skip-permissions",
  "--mcp-config",
  JSON.stringify({
    mcpServers: { [MCP_NAME]: { type: "http", url: MCP_URL } },
  }),
];

const GEMINI_SETTINGS_TARGET = `${DEFAULT_USER_HOME}/.gemini/settings.json`;
const GEMINI_SETTINGS_CONTENT = JSON.stringify(
  {
    mcpServers: {
      [MCP_NAME]: { httpUrl: MCP_URL, trust: true },
    },
  },
  null,
  2,
);

const ACP_TOOL_CALL_WAIT_MS = 20_000;

/**
 * Returns true if any identifier field of the session update references the
 * given MCP server name. We only inspect fields that identify the *tool*
 * (title, rawInput, _meta) and never message content — otherwise stray
 * mentions of the server name in the model's prose would create false
 * positives.
 */
function toolCallReferencesMcp(update: unknown, name: string): boolean {
  if (!update || typeof update !== "object") return false;
  const lower = name.toLowerCase();
  const containsName = (v: unknown): boolean => {
    if (typeof v === "string") return v.toLowerCase().includes(lower);
    if (Array.isArray(v)) return v.some(containsName);
    if (v && typeof v === "object") return Object.values(v).some(containsName);
    return false;
  };
  const u = update as { title?: unknown; rawInput?: unknown; _meta?: unknown };
  return (
    containsName(u.title) || containsName(u.rawInput) || containsName(u._meta)
  );
}

const GEMINI_QUOTA_SKIP =
  "Cannot verify on this account: Gemini API quota exhausted (verified working with sufficient quota)";

export default {
  name: "mcp-server",
  description: "Attach an MCP server to a session and exercise an MCP tool",
  protocols: ["acp", "claude"],
  timeoutMs: 30_000,

  acpMcpServers: ACP_MCP_SERVERS,

  skipForAgents: {
    "gemini-cli": GEMINI_QUOTA_SKIP,
  },

  provisionOverridesByAgent: {
    "claude-code": { brokerMount: { launchArgs: CLAUDE_MCP_LAUNCH_ARGS } },
  },

  extraMountsByAgent: {
    // gemini-cli ignores ACP `newSession.mcpServers`; it loads MCP servers
    // from `~/.gemini/settings.json` at startup. Mount the config inline so
    // it's on disk when the broker eagerly spawns gemini at devbox boot.
    "gemini-cli": [
      {
        type: "file_mount",
        target: GEMINI_SETTINGS_TARGET,
        content: GEMINI_SETTINGS_CONTENT,
      },
    ],
  },

  async run(ctx) {
    if (ctx.acp) {
      ctx.log("Running ACP path...");

      let sawMcpToolCall = false;
      const unsub = ctx.acp.onSessionUpdate((_sid, update) => {
        if (!isToolCall(update) && !isToolCallProgress(update)) return;
        if (toolCallReferencesMcp(update, MCP_NAME)) {
          sawMcpToolCall = true;
        }
      });

      ctx.log(`Sending prompt: "${PROMPT}"`);
      await ctx.acp.prompt({
        sessionId: ctx.sessionId!,
        prompt: [{ type: "text", text: PROMPT }],
      });

      const sawTool = await waitFor(() => sawMcpToolCall, ACP_TOOL_CALL_WAIT_MS);
      unsub();

      if (!sawTool) {
        throw new Error(
          `Agent did not invoke an MCP tool from "${MCP_NAME}" within ${ACP_TOOL_CALL_WAIT_MS}ms`,
        );
      }
      ctx.log(`Pass: ACP agent invoked an MCP tool from "${MCP_NAME}"`);
    } else if (ctx.claude) {
      ctx.log("Running Claude path...");

      let mcpAttached = false;
      let resultError: string | undefined;
      let onResult!: () => void;
      const resultReceived = new Promise<void>((resolve) => {
        onResult = resolve;
      });

      const unsub = ctx.claude.onTimelineEvent((event) => {
        if (isClaudeSystemInitEvent(event)) {
          if (event.data.mcp_servers.some((s) => s.name === MCP_NAME)) {
            mcpAttached = true;
          }
        }
        if (isClaudeResultEvent(event)) {
          if (event.data.is_error) {
            resultError = `Result was an error: ${event.data.subtype}`;
          }
          onResult();
        }
      });

      ctx.log(`Sending prompt: "${PROMPT}"`);
      await ctx.claude.send(PROMPT);
      await resultReceived;
      unsub();

      if (resultError) throw new Error(resultError);
      if (!mcpAttached) {
        throw new Error(
          `MCP server "${MCP_NAME}" was not listed in Claude system/init mcp_servers`,
        );
      }
      ctx.log(`Pass: Claude system/init listed "${MCP_NAME}" in mcp_servers`);
    } else {
      ctx.skip("No connection available");
    }
  },
} satisfies UseCase;

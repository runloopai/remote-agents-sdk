import type { Runloop } from "@runloop/api-client";
import type { ACPAxonConnection } from "@runloop/remote-agents-sdk/acp";
import type { ClaudeAxonConnection } from "@runloop/remote-agents-sdk/claude";
import type { Client, Agent, McpServer } from "@agentclientprotocol/sdk";

/**
 * Inline `file_mount` shape from the Runloop API. The file is in place when
 * the devbox boots, before the broker spawns the agent process — use it for
 * agent config that must exist on startup (e.g. gemini-cli's
 * `~/.gemini/settings.json`).
 * Note: Use file_mounts ONLY for tiny configuration files, use object_mounts for larger files.
 *
 * Derived from `@runloop/api-client`'s `Mount` union so the shape can't drift
 * from the upstream API.
 */
export type FileMount = Extract<Runloop.Mount, { type: "file_mount" }>;

/**
 * `object_mount` shape from the Runloop API for pre-uploaded storage objects.
 * Derived from `@runloop/api-client`'s `Mount` union so the shape can't drift
 * from the upstream API.
 */
export type ObjectMount = Extract<Runloop.Mount, { type: "object_mount" }>;

/**
 * Extra devbox mounts a use case can request per-agent. Restricted to
 * supplemental-config mount kinds; `agent_mount` and `broker_mount` are
 * managed by scaffold.ts and must not be duplicated here.
 */
export type ExtraMount = FileMount | ObjectMount;

/**
 * How the agent gets installed on the devbox.
 *
 * - **agent-mount**: Use a starter blueprint + Runloop agent mount. Adds an `agent_mount`
 *   entry to the devbox so the agent is installed at provision time.
 * - **blueprint**: Agent is pre-baked into a custom blueprint. No `agent_mount` needed;
 *   the broker mount points directly at the binary path.
 */
export type InstallStrategy =
  | { kind: "agent-mount"; agentName: string; blueprint: string }
  | { kind: "blueprint"; blueprint: string };

/**
 * Broker mount configuration — wires Axon to the agent process.
 * Maps directly to the Runloop `broker_mount` API shape.
 */
export interface BrokerMount {
  /** Broker protocol: "acp" for ACP agents, "claude_json" for Claude Code. */
  protocol: "acp" | "claude_json";
  /** Path or name of the agent binary. */
  agentBinary?: string;
  /** CLI args passed to the agent binary. */
  launchArgs?: string[];
  /** Working directory for the agent process (also used as ACP session cwd). */
  workingDirectory?: string;
}

/**
 * Defines how to provision a specific agent.
 */
export interface AgentConfig {
  /** Unique identifier (e.g., "opencode", "claude-code"). */
  name: string;

  /** Which protocol this agent uses (client-side). */
  protocol: "acp" | "claude";

  /** How to install the agent on the devbox. */
  install: InstallStrategy;

  /** Broker mount configuration — wires Axon to the agent process. */
  brokerMount: BrokerMount;

  /**
   * ACP auth method ID to negotiate with `authenticate()` after `initialize()`.
   * Required by agents that enforce auth before `newSession()` (e.g. codex-acp).
   * Must match one of the `authMethods` advertised by the agent during initialize.
   */
  acpAuthMethodId?: string;

  /** Non-secret env vars only. Use sdk.secret for API keys (see scaffold.ts). */
  env?: Record<string, string>;

  /** Map of devbox env var name -> local env var to source the value from. */
  secrets?: Record<string, string>;

  /** If false, agent is skipped in compatibility runs. Defaults to true. */
  enabled?: boolean;
}

/**
 * Factory function that creates a Client implementation.
 * Matches the SDK's CreateClientFn signature directly.
 */
export type CreateClientFn = (agent: Agent) => Client;

/**
 * Overrides for agent provisioning. Use-cases can specify a different install
 * strategy and/or broker mount settings per-agent.
 *
 * - `install` replaces the entire install strategy when provided.
 * - `brokerMount` is shallow-merged with the base config.
 * - Other fields (`secrets`, `env`, `acpAuthMethodId`) are shallow-merged or replaced.
 */
export interface AgentConfigOverride {
  install?: InstallStrategy;
  brokerMount?: Partial<BrokerMount>;
  acpAuthMethodId?: string;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
}

/**
 * Defines a single compatibility test / use case.
 */
export interface UseCase {
  /** Unique identifier, matches filename without extension. */
  name: string;

  /** Human-readable description for llms.txt and matrix output. */
  description: string;

  /** Which protocols this use case applies to. */
  protocols: Array<"acp" | "claude">;

  /** Per-use-case timeout in ms. Overrides the default. */
  timeoutMs?: number;

  /** Optional provisioning overrides for special cases (applies to all agents). */
  provisionOverrides?: AgentConfigOverride;

  /**
   * Per-agent provisioning overrides, keyed by agent name.
   * Applied after provisionOverrides for agent-specific configuration.
   * E.g., to use a different blueprint or binary path for specific agents.
   */
  provisionOverridesByAgent?: Record<string, AgentConfigOverride>;

  /**
   * For ACP use cases that need the full Client interface (e.g., elicitation),
   * provide a factory that creates a custom Client implementation.
   */
  createClient?: CreateClientFn;

  /**
   * Client capabilities to advertise during ACP initialize.
   * E.g., `{ elicitation: { form: {} } }` to enable elicitation.
   */
  clientCapabilities?: Record<string, unknown>;

  /**
   * MCP servers attached to the ACP `newSession()` call. Ignored for Claude
   * paths (Claude reads MCP config from `--mcp-config` launch args instead).
   */
  acpMcpServers?: McpServer[];

  /**
   * Extra devbox mounts to add at provision time, keyed by agent name. Use
   * this for agent-specific config that must be on disk *before* the broker
   * spawns the agent process — e.g. gemini-cli's `~/.gemini/settings.json`,
   * since gemini-cli reads MCP config from settings.json at startup and does
   * not honour ACP `newSession.mcpServers`.
   *
   * Mounts here are appended to the standard `agent_mount` / `broker_mount`
   * pair built by scaffold.ts. Inline `file_mount` is the simplest option;
   * `object_mount` is available for pre-uploaded storage objects.
   */
  extraMountsByAgent?: Record<string, ExtraMount[]>;

  /**
   * Per-agent expected failures (with reason), keyed by agent name.
   * Results will show as "xfail" instead of "fail" and won't cause exit code 1.
   * Use this for protocol/feature-level limitations the agent genuinely
   * doesn't implement (e.g. ACP elicitation not advertised).
   * E.g., `{ opencode: "Elicitation not yet supported" }`.
   */
  expectedFailures?: Record<string, string>;

  /**
   * Per-agent skip reasons, keyed by agent name. Skipped *before* setup so no
   * devbox is provisioned. Use this for environmental limitations that prevent
   * verifying the use case on the current machine/account (e.g. an exhausted
   * API quota on a shared key) — distinct from `expectedFailures`, which
   * documents a protocol/agent that genuinely lacks the feature.
   * E.g., `{ "gemini-cli": "Cannot verify on this account: API quota exhausted" }`.
   */
  skipForAgents?: Record<string, string>;

  /**
   * The test body. Receives a fully initialized RunContext.
   * Throw to indicate failure. Return cleanly to indicate pass.
   * Call ctx.skip(reason) to skip.
   */
  run: (ctx: RunContext) => Promise<void>;
}

/**
 * Provided to useCase.run() with an initialized connection.
 */
export interface RunContext {
  /** The agent config used for this run. */
  agent: AgentConfig;

  /** ACP connection, or null if this is a Claude run. */
  acp: ACPAxonConnection | null;

  /** Claude connection, or null if this is an ACP run. */
  claude: ClaudeAxonConnection | null;

  /** ACP session ID, or null for Claude (implicit session). */
  sessionId: string | null;

  /** Log a message (appears in run output). */
  log: (msg: string) => void;

  /** Skip this use case with a reason. Throws a SkipError internally. */
  skip: (reason: string) => never;

  /**
   * Cleanup callback that shuts down the devbox.
   * Separated from connection disconnect so runner can timeout each phase independently.
   */
  cleanup: () => Promise<void>;
}

/**
 * Captures the outcome of a single (agent, use case) run.
 */
export interface RunResult {
  /** Agent name (e.g., "opencode"). */
  agent: string;

  /** Use case name (e.g., "single-prompt"). */
  useCase: string;

  /** Protocol used (e.g., "acp"). */
  protocol: "acp" | "claude";

  /** Outcome. */
  status: "pass" | "fail" | "skip" | "xfail" | "xpass";

  /** Error message if status is "fail" or "xfail". */
  error?: string;

  /** Skip reason if status is "skip", or note if status is "xpass". */
  reason?: string;

  /** Why this failure was expected (only set when status is "xfail"). */
  xfailReason?: string;

  /** Time taken in milliseconds. */
  durationMs: number;
}

/**
 * Error thrown when a use case is skipped.
 */
export class SkipError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Skipped: ${reason}`);
    this.name = "SkipError";
    this.reason = reason;
  }
}

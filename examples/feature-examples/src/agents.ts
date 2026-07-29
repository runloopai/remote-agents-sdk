import type { AgentConfig } from "./types.js";

/**
 * Default agent configurations.
 *
 * Every agent except `pi` uses the "agent-mount" install strategy: a starter
 * blueprint + agent mount to install the agent at provision time. `pi` has no
 * catalog mount and comes pre-baked in the `axon-agents` blueprint. API keys
 * are injected via secrets in scaffold.ts, not here.
 */
export const AGENTS: AgentConfig[] = [
  {
    name: "opencode",
    protocol: "acp",
    install: {
      kind: "agent-mount",
      agentName: "opencode",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "acp",
      agentBinary: "opencode",
      launchArgs: ["acp"],
    },
  },
  {
    name: "codex-acp",
    protocol: "acp",
    install: {
      kind: "agent-mount",
      agentName: "codex-acp",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "acp",
      agentBinary: "codex-acp",
      workingDirectory: "/home/user",
    },
    secrets: { OPENAI_API_KEY: "OPENAI_API_KEY" },
    acpAuthMethodId: "openai-api-key",
  },
  {
    name: "codex",
    protocol: "codex",
    install: {
      kind: "agent-mount",
      agentName: "codex",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "codex_json",
      agentBinary: "codex",
      workingDirectory: "/home/user",
    },
    secrets: { OPENAI_API_KEY: "OPENAI_API_KEY" },
  },
  {
    name: "qwen",
    protocol: "acp",
    install: {
      kind: "agent-mount",
      agentName: "qwen",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "acp",
      agentBinary: "qwen",
      launchArgs: ["--auth-type", "openai", "--acp"],
    },
    secrets: {
      OPENAI_API_KEY: "DASHSCOPE_API_KEY",
      OPENAI_BASE_URL: "DASHSCOPE_BASE_URL",
    },
  },
  {
    name: "gemini-cli",
    protocol: "acp",
    install: {
      kind: "agent-mount",
      agentName: "gemini-cli",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "acp",
      agentBinary: "gemini",
      launchArgs: ["--experimental-acp", "--yolo"],
    },
    secrets: { GEMINI_API_KEY: "GEMINI_API_KEY" },
  },
  {
    name: "pi",
    protocol: "pi",
    // Pi has no catalog agent mount, so it comes from the `axon-agents`
    // blueprint (see examples/blueprint/Dockerfile, which pins 0.82.1).
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      protocol: "pi_json",
      agentBinary: "pi",
      workingDirectory: "/home/user",
      // `--mode rpc` and `--session-dir` are broker-owned: the broker appends
      // both, and `--session-dir` must point at the durable state root for
      // resume to survive devbox snapshots. Never set either here.
      launchArgs: ["--model", "nebius/glm-5.2"],
    },
    // NEBIUS_BASE_URL is Runloop's dedicated endpoint, not a public URL, so it
    // travels through the secret mechanism too — that keeps it out of the repo
    // and makes a missing value a clean skip instead of a confusing failure.
    secrets: {
      NEBIUS_API_KEY: "NEBIUS_API_KEY",
      NEBIUS_BASE_URL: "NEBIUS_BASE_URL",
    },
  },
  {
    name: "claude-code",
    protocol: "claude",
    install: {
      kind: "agent-mount",
      agentName: "claude-code",
      blueprint: "runloop/starter-x86_64",
    },
    brokerMount: {
      protocol: "claude_json",
      agentBinary: "claude",
      launchArgs: ["--dangerously-skip-permissions"],
    },
    secrets: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" },
  },
];

import type { AgentConfig } from "./types.js";

/**
 * Default agent configurations.
 *
 * All agents use the "agent-mount" install strategy: a starter blueprint +
 * agent mount to install the agent at provision time. API keys are injected
 * via secrets in scaffold.ts, not here.
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
      launchArgs: ["--acp", "--yolo", "--skip-trust"],
    },
    secrets: { GEMINI_API_KEY: "GEMINI_API_KEY" },
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

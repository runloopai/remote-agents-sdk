import type { AgentConfigOverride, UseCase } from "../types.js";
import singlePrompt from "./single-prompt.js";

/**
 * Demonstrates using a pre-built blueprint (`axon-agents`) with agents baked in.
 *
 * This use case demonstrates how to use `provisionOverridesByAgent` to switch
 * from the default install using agent_mounts to a blueprint install for specific agents.
 * It is not an exhaustive example: the same general approach should work for all agents. To
 * change the agents being tested, modify BLUEPRINT_OVERRIDES
 *
 * The test body is identical to single-prompt — the interesting part is the
 * provisioning configuration, not the prompt logic.
 *
 * Prerequisites: The `axon-agents` blueprint must exist on your Runloop account.
 * Run `bun run build-blueprint` from the repo root to create it.
 */

const BLUEPRINT_OVERRIDES: Record<string, AgentConfigOverride> = {
  opencode: {
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      agentBinary: "/home/user/.opencode/bin/opencode",
      launchArgs: ["acp"],
    },
  },
  "codex-acp": {
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      agentBinary: "/usr/local/bin/codex-acp",
      workingDirectory: "/home/user",
    },
  },
  codex: {
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      agentBinary: "/home/user/.local/bin/codex",
      workingDirectory: "/home/user",
    },
  },
  pi: {
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      agentBinary: "/usr/local/bin/pi",
      workingDirectory: "/home/user",
    },
  },
  "claude-code": {
    install: { kind: "blueprint", blueprint: "axon-agents" },
    brokerMount: {
      agentBinary: "/home/user/.local/bin/claude",
      launchArgs: ["--dangerously-skip-permissions"],
    },
  },
};

export default {
  name: "agent-via-blueprint",
  description: "Use pre-built blueprint with agents baked in",
  protocols: ["acp", "claude", "codex", "pi"],
  timeoutMs: 30_000,

  provisionOverridesByAgent: BLUEPRINT_OVERRIDES,

  run(ctx) {
    if (!(ctx.agent.name in BLUEPRINT_OVERRIDES)) {
      ctx.skip(
        `No blueprint override defined for ${ctx.agent.name} — ` +
          `add an entry to BLUEPRINT_OVERRIDES to test this agent via blueprint`,
      );
    }
    return singlePrompt.run(ctx);
  },
} satisfies UseCase;

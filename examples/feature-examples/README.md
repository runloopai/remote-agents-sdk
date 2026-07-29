# feature-examples

Runnable SDK recipes demonstrating individual features of `@runloop/remote-agents-sdk`. **Primary audience: agents** (LLM code generators looking for working examples).

## Prerequisites

Most use cases run against `runloop/starter-x86_64` using the **agent-mount** install strategy. The `agent-via-blueprint` use case demonstrates the **blueprint** install strategy where agents are pre-baked into a custom image, and the `pi` agent always uses it (Pi has no catalog agent mount). Build the shared `axon-agents` blueprint once before running the full suite:

```bash
bun run build-blueprint
```

See [`../blueprint`](../blueprint/) for details.

## Install strategies

Agents can be installed on a devbox in two ways:

| Strategy | How it works | Devbox mounts |
|----------|--------------|---------------|
| **agent-mount** | Start from a starter blueprint + install agent via `agent_mount` at provision time | `agent_mount` + `broker_mount` |
| **blueprint** | Agent is pre-baked into a custom blueprint | `broker_mount` only |

The `install` field in `AgentConfig` (see [`src/types.ts`](src/types.ts)) controls which strategy is used.

## Layout

- [`src/scaffold.ts`](src/scaffold.ts) — Devbox provisioning and connection setup. Read this first to understand how agents are launched.
- [`src/types.ts`](src/types.ts) — Type definitions: `AgentConfig`, `InstallStrategy`, `BrokerMount`, and `AgentConfigOverride`.
- [`src/agents.ts`](src/agents.ts) — Agent configurations (install strategy, broker mount, secrets).
- [`src/use-cases/`](src/use-cases/) — Individual feature demonstrations (one file per use case).
- [`compatibility.md`](compatibility.md) — Generated compatibility matrix (protocol × agent × feature).

## Running

```bash
bun run feature-compat              # Run all use cases, regenerate compatibility.md and llms.txt
bun run feature-compat --agent opencode   # Run only with opencode
bun run feature-compat --use-case single-prompt  # Run only single-prompt
bun run feature-compat --validate   # Validate generated files without running tests
```

## Per-agent overrides

Use cases can specify `provisionOverridesByAgent` to switch install strategy or adjust broker mount settings per agent. See [`agent-via-blueprint.ts`](src/use-cases/agent-via-blueprint.ts) for an example that switches from agent-mount to blueprint install.

## Use-case index

See [`llms.txt`](../../llms.txt) at the repo root for the canonical index of use cases with links.

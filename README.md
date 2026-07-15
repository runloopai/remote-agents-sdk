# @runloop/remote-agents-sdk

[![CI](https://github.com/runloopai/remote-agents-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/runloopai/remote-agents-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@runloop/remote-agents-sdk)](https://www.npmjs.com/package/@runloop/remote-agents-sdk)
[![Docs](https://img.shields.io/badge/docs-TypeDoc-blue)](https://runloopai.github.io/remote-agents-sdk/)
[![codecov](https://codecov.io/gh/runloopai/remote-agents-sdk/branch/main/graph/badge.svg)](https://codecov.io/gh/runloopai/remote-agents-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for connecting applications to Runloop-hosted remote agents (Claude Code, OpenCode, etc.) via the Axon event bus.

## Key Concepts

Before getting started, it's helpful to understand these core concepts:

- **Runloop** — A cloud platform that provides on-demand development environments (devboxes) where coding agents can run.
- **Devbox** — An isolated Linux container/environment running in Runloop's cloud where coding agents execute. It has a filesystem, can run commands, and persists for the duration of your session.
- **Axon** — A bidirectional message bus that enables real-time communication between your application and an agent running in a Runloop devbox. Think of it as a WebSocket-like channel for agent control.
- **Broker Mount** — A devbox configuration that connects an Axon channel to an agent binary, specifying which agent to run (opencode, claude, etc.), the protocol to use (acp, claude_json), and launch arguments.

In short: **Runloop** hosts **devboxes** where agents run; a **broker mount** connects that agent to **Axon**; and **Axon** is the message bus your app uses to control it.

## Prerequisites

- [Node.js](https://nodejs.org) >= 22.0.0
- A [Runloop](https://runloop.ai) API key
  - Sign up for free at [platform.runloop.ai](https://platform.runloop.ai) (includes $50 in credits)
  - Navigate to [Settings](https://platform.runloop.ai/settings) → API Keys
  - Create an API key (starts with `ak`\_)
  - Set environment variable: `export RUNLOOP_API_KEY=ak_your_key`
- An [Anthropic](https://console.anthropic.com) API key (**only required for Claude module examples**)
  - Sign up at [console.anthropic.com](https://console.anthropic.com)
  - Go to API Keys section
  - Create new key (starts with `sk-ant-`)
  - Set environment variable: `export ANTHROPIC_API_KEY=sk-ant-your_key`

## Installation

```bash
npm install @runloop/remote-agents-sdk @runloop/api-client
```

`@runloop/api-client` is a required peer dependency — it provides the `RunloopSDK` instance and Axon types used by both modules.

If you're using the Claude module, also install:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Status & Roadmap

### Supported Features by Protocol

| Capability                                   | Claude | ACP |
| -------------------------------------------- | ------ | --- |
| Send prompts / messages                      | ✅     | ✅  |
| Streaming responses                          | ✅     | ✅  |
| Tool use / tool results                      | ✅     | ✅  |
| Cancel / interrupt turns                     | ✅     | ✅  |
| Permission / control requests (auto-approve) | ✅     | ✅  |

\*Auto-approve only for now, permission request flow pending

### Coming Soon

| Status     | Description                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🚧 Planned | **Devbox state-transition events** — expose transitional lifecycle states (`suspending`, `resuming`, `creating`) as first-class Axon events (terminal states like `running`, `suspended`, `shutdown`, `failed` are already supported) |
| 🚧 Planned | **Axon subscribe over WebSockets** — WebSocket transport for Axon subscriptions, enabling browser clients without a backend proxy                               |

## Modules

The SDK has two independent modules — pick the one that matches your agent's protocol:

| Module     | Import path                         | Protocol                                                                | Use when                                        |
| ---------- | ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| **ACP**    | `@runloop/remote-agents-sdk/acp`    | [Agent Client Protocol](https://agentclientprotocol.com) (JSON-RPC 2.0) | Using OpenCode, or Claude via ACP               |
| **Claude** | `@runloop/remote-agents-sdk/claude` | Claude Code SDK wire format                                             | Using Claude Code with native SDK message types |

### Which module should I use?

**Use the ACP module when:**

- You want agent-agnostic code that works with multiple agents (OpenCode, Claude via ACP, future agents)
- You need a standardized JSON-RPC 2.0 protocol
- You want maximum compatibility and flexibility

**Use the Claude module when:**

- You're specifically using Claude Code
- You want native Claude SDK message types
- You need Claude-specific features

**Note:** The modules have different APIs and are not directly interchangeable. Choose based on your agent and requirements.

## Usage

### ACP module

```typescript
import {
  ACPAxonConnection,
  PROTOCOL_VERSION,
  isAgentMessageChunk,
} from "@runloop/remote-agents-sdk/acp";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

const axon = await sdk.axon.create({ name: "acp-transport" });
const devbox = await sdk.devbox.create({
  mounts: [
    {
      type: "broker_mount",
      axon_id: axon.id,
      protocol: "acp",
      agent_binary: "opencode",
      launch_args: ["acp"],
    },
  ],
});
const agent = new ACPAxonConnection(axon, devbox, {
  onDisconnect: async () => {
    await devbox.shutdown();
  },
});

await agent.connect();
await agent.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "my-app", version: "1.0.0" },
});

agent.onSessionUpdate((sessionId, update) => {
  if (isAgentMessageChunk(update)) process.stdout.write(update.message);
});

const session = await agent.newSession({ cwd: "/home/user", mcpServers: [] });
await agent.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello!" }],
});

await agent.disconnect();
```

### Claude module

```typescript
import { ClaudeAxonConnection } from "@runloop/remote-agents-sdk/claude";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

const axon = await sdk.axon.create({ name: "claude-transport" });
const devbox = await sdk.devbox.create({
  mounts: [
    {
      type: "broker_mount",
      axon_id: axon.id,
      protocol: "claude_json",
      agent_binary: "claude",
    },
  ],
});

const conn = new ClaudeAxonConnection(axon, devbox, {
  model: "claude-sonnet-4-5",
});
await conn.connect();
await conn.initialize();

await conn.send("What files are in this directory?");

for await (const msg of conn.receiveAgentResponse()) {
  console.log(msg.type, msg);
}

await conn.disconnect();
```

### Timeline events

Both modules provide a unified timeline event stream — the recommended way to build chat UIs that need a single chronological view of protocol messages, system events (turn start/end), and custom events.

Every timeline event has `{ kind, data, axonEvent }` where `kind` is a discriminant (`"acp_protocol"` / `"claude_protocol"`, `"system"`, or `"unknown"`), `data` is the typed payload, and `axonEvent` is the raw Axon event with full metadata.

**ACP — handling protocol events:**

```typescript
import { SYSTEM_EVENT_TYPES } from "@runloop/remote-agents-sdk/shared";
import {
  isAgentMessageChunk,
  isToolCall,
  isToolCallProgress,
} from "@runloop/remote-agents-sdk/acp";

agent.onTimelineEvent((event) => {
  switch (event.kind) {
    case "acp_protocol":
      if (event.eventType === "session/update") {
        const update = event.data.update;
        if (isAgentMessageChunk(update)) {
          process.stdout.write(update.text);
        } else if (isToolCall(update)) {
          console.log(`Tool: ${update.name} (${update.status})`);
        } else if (isToolCallProgress(update)) {
          console.log(`Tool output: ${update.content}`);
        }
      }
      break;
    case "unknown":
      console.log(
        `Unrecognized event: ${event.axonEvent.event_type}`,
        event.axonEvent.payload,
      );
      break;
  }
});
```

**Claude:**

```typescript
conn.onTimelineEvent((event) => {
  switch (event.kind) {
    case "claude_protocol":
      if (event.eventType === "assistant") {
        process.stdout.write(event.data.content);
      } else if (event.eventType === "result") {
        console.log("Result:", event.data.content);
      }
      break;
    case "unknown":
      break;
  }
});
```

**Custom events** — use `publish()` to push your own events to the channel. They arrive as `kind: "unknown"` timeline events:

```typescript
import { tryParseTimelinePayload } from "@runloop/remote-agents-sdk/acp";

// Publish a custom event
await conn.publish({
  event_type: "build_status",
  origin: "EXTERNAL_EVENT",
  source: "ci-pipeline",
  payload: JSON.stringify({ step: "compile", progress: 75 }),
});

// Consume it on the other side
conn.onTimelineEvent((event) => {
  if (
    event.kind === "unknown" &&
    event.axonEvent.event_type === "build_status"
  ) {
    const status = tryParseTimelinePayload<{ step: string; progress: number }>(
      event,
    );
    if (status) console.log(`${status.step}: ${status.progress}%`);
  }
});
```

Both modules also support pull-based consumption via an async generator:

```typescript
for await (const event of agent.receiveTimelineEvents()) {
  console.log(event.kind, event.data);
}
```

See the [SDK documentation](sdk/README.md#custom-events-via-publish-and-tryparsetimelinepayload) for more on custom events, and the [full timeline API reference](sdk/README.md#timeline-events) for replay behavior and `afterSequence`.

See the [SDK documentation](sdk/README.md) for the full API reference, or browse the [hosted API docs](https://runloopai.github.io/remote-agents-sdk/).

## Getting Agents onto the Devbox

There are two ways to ensure your agent binary is available on the devbox before execution starts:

- **Agent mounts (late-binding)** — Install the agent at devbox creation time via a mount. The agent lands on the box just before the broker mount connects it to Axon. This works with any standard Runloop image, so you can pick or customize the base environment independently from the agent.
- **Blueprints (pre-baked)** — Bake the agent (and any other tooling) directly into a custom devbox image. Subsequent devbox creations skip the install step entirely, giving you the fastest cold-start and a reproducible, versioned environment.

The standalone examples (hello-world, CLI, combined-app) use a pre-baked **blueprint** for the fastest cold-start; the [feature-examples](examples/feature-examples/) default to **agent mounts** so they work with any standard image. Pick whichever fits your workflow — for example, blueprints when you want reproducible images, or mounts when you need to swap agent versions frequently or avoid maintaining custom images.

## Repository Structure

```
sdk/                      → @runloop/remote-agents-sdk (the published npm package)
examples/
  blueprint/              → Builds the shared `axon-agents` blueprint (run this first)
  acp-hello-world/        → Minimal ACP single-prompt script
  acp-cli/                → Interactive ACP REPL
  claude-hello-world/     → Minimal Claude single-prompt script
  claude-cli/             → Interactive Claude REPL
  combined-app/           → Full-stack combined demo (Claude + Codex + ACP, Express + React)
  feature-examples/       → Runnable SDK recipes (single-prompt, elicitation, etc.)
```

### Running the examples

> **Run the blueprint example first.** Every other example creates a devbox with `blueprint_name: "axon-agents"`. That blueprint is built by [`examples/blueprint`](examples/blueprint/) and must exist on your Runloop account before any other example will succeed.
>
> ```bash
> bun install
> bun run build
> bun run build-blueprint   # one-time — builds the axon-agents blueprint
> ```
>
> After the blueprint reports `build_complete`, you can run any of the other examples. See [`examples/blueprint/README.md`](examples/blueprint/README.md) for details and [`examples/README.md`](examples/README.md) for the full example index.

## Development

**Prerequisites:**

- [Node.js](https://nodejs.org) >= 22.0.0
- [Bun](https://bun.sh) (package manager and task runner)

```bash
bun install
bun run build
bun run test
bun run check    # lint + format verification
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, commit conventions, and PR guidelines.

## License

[MIT](LICENSE)

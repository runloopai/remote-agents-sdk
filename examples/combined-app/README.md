# @runloop/example-combined-app

> **Alpha — subject to change.** This example uses an SDK in early development. APIs and behavior may change without notice between versions.

A full-stack demo that supports both ACP and Claude Code agents running in Runloop devboxes. An Express backend manages agent connections (one per protocol) and fans out SDK timeline events to a React frontend over a single WebSocket. Multiple agents can run concurrently.

## Prerequisites

- Node.js 22+
- A [Runloop](https://runloop.ai) API key
- An [Anthropic](https://anthropic.com) API key (required for Claude agents)
- The `@runloop/remote-agents-sdk` SDK built locally (`cd ../../sdk && bun run build`)

## Setup

```bash
# From the monorepo root
bun install && bun run build

# Configure your API keys
cd examples/combined-app
cp .env.example .env
```

Add your keys to `.env`:

```
RUNLOOP_API_KEY=your_runloop_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### Build the shared blueprint (one-time, required)

This example provisions devboxes with `blueprint_name: "axon-agents"` (see [`src/server/acp-manager.ts`](src/server/acp-manager.ts) and [`src/server/claude-manager.ts`](src/server/claude-manager.ts)). That blueprint must exist on your Runloop account before starting an agent from the UI — otherwise `POST /api/start` will fail when creating the devbox.

From the monorepo root:

```bash
bun run build-blueprint
```

See [`../blueprint`](../blueprint/) for details. You only need to run it once per Runloop account.

## Running

```bash
bun run dev
```

This starts both processes in one terminal: the Express server (port 3003) and the Vite dev server (port 5176), with prefixed output. Stopping it (Ctrl-C) shuts down both.

To run them individually, use `bun run dev:server` and `bun run dev:client` in separate terminals.

Open http://localhost:5176. The Vite dev server proxies `/api/*` and `/ws` to the Express backend.

## How It Works

1. **Start an agent** — the setup card lets you choose ACP or Claude, configure the agent binary / blueprint, and optionally set a system prompt. `POST /api/start` provisions an Axon channel and devbox, then opens the appropriate SDK connection (`ACPAxonConnection` or `ClaudeAxonConnection`).
2. **Send a prompt** — `POST /api/prompt` dispatches to the active connection's `prompt()` (ACP) or `send()` (Claude) and returns immediately.
3. **Stream events** — the SDK's `onTimelineEvent` callback fires for every classified event (protocol messages, system turns, unknowns). The server broadcasts each event over WebSocket with an `agentId` tag.
4. **Render blocks** — the React client filters events by `agentId`, builds incremental turn blocks (`useBlockManager`), and renders them through `AssistantTurn` / `TurnBlocks`.

## Project Structure

```
src/
├── shared/
│   └── ws-events.ts        WebSocket event types (shared by server + client)
├── server/
│   ├── index.ts             Express server and REST endpoints
│   ├── ws.ts                WebSocket broadcaster
│   ├── acp-manager.ts       ACP connection lifecycle
│   ├── acp-client.ts        ACP Client implementation (permissions, elicitation)
│   ├── claude-manager.ts    Claude connection lifecycle
│   └── agent-registry.ts    Multi-agent bookkeeping
└── client/
    ├── main.tsx             React entry point
    ├── App.tsx              Main UI shell
    ├── types.ts             Shared client types
    ├── hooks/
    │   ├── useAgent.ts      Unified hook (delegates to protocol-specific hooks)
    │   ├── useACPAgent.ts   ACP event handling and state
    │   ├── useClaudeAgent.ts Claude event handling and state
    │   ├── useBlockManager.ts Turn block accumulation
    │   ├── useAgentList.ts  Agent list polling
    │   ├── useAttachments.ts File/image attachment handling
    │   ├── api.ts           Fetch helper
    │   └── parsers.ts       Block ID generation, tool kind inference
    └── components/
        ├── AssistantTurn.tsx    Turn-level block grouping and rendering
        ├── TurnBlocks.tsx       Individual block views (text, tool, thinking, etc.)
        ├── TurnBlocksInspector.tsx  Activity sidebar
        ├── TimelineEventItem.tsx    Timeline sidebar
        ├── AxonEventItem.tsx        Raw axon event sidebar
        └── ...                      Setup, controls, permissions, elicitation
```

## License

MIT — part of the [`remote-agents-sdk`](https://github.com/runloopai/remote-agents-sdk) workspace.

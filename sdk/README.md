# @runloop/remote-agents-sdk

> **Alpha — subject to change.** This SDK is in early development. APIs, interfaces, and behavior may change without notice between versions.

TypeScript client for connecting applications to Runloop-hosted remote agents via the Axon event bus.

This package provides two protocol modules and a shared utilities module:

| Module | Import path | Protocol | Use case |
|--------|-------------|----------|----------|
| **ACP** | `@runloop/remote-agents-sdk/acp` | [Agent Client Protocol](https://agentclientprotocol.com) (JSON-RPC 2.0) | Any ACP-compatible agent (OpenCode, Claude via ACP, etc.) |
| **Claude** | `@runloop/remote-agents-sdk/claude` | Claude Code SDK wire format | Claude Code with native SDK message types |
| **Shared** | `@runloop/remote-agents-sdk/shared` | — | Common types (`BaseConnectionOptions`, `AxonEventView`, `AxonEventListener`) and utilities |

Both protocol modules communicate over Runloop Axon channels. Pick the one that matches your agent's protocol. Shared types are also re-exported from each protocol module for convenience.

## Installation

```bash
npm install @runloop/remote-agents-sdk @runloop/api-client
```

`@runloop/api-client` is a peer dependency — you provide the Runloop SDK instance.

If using the Claude module, you also need:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Imports

```typescript
// Subpath imports (recommended — tree-shakable)
import { ACPAxonConnection, PROTOCOL_VERSION } from "@runloop/remote-agents-sdk/acp";
import { ClaudeAxonConnection } from "@runloop/remote-agents-sdk/claude";
import type { BaseConnectionOptions, AxonEventView } from "@runloop/remote-agents-sdk/shared";

// Namespaced root import (all modules at once)
import { acp, claude, shared } from "@runloop/remote-agents-sdk";
```

## Getting Started

### ACP Agent

```typescript
import {
  ACPAxonConnection,
  isAgentMessageChunk,
  PROTOCOL_VERSION,
} from "@runloop/remote-agents-sdk/acp";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

// Create an Axon channel and a devbox with an ACP broker mount.
// The broker launches the agent binary (e.g. OpenCode) inside the devbox.
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

// Wrap the Axon channel in a high-level ACP connection and negotiate capabilities
const conn = new ACPAxonConnection(axon, devbox);
await conn.connect();
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "my-app", version: "1.0.0" },
});

// Stream agent responses as they arrive — use type guards to narrow update variants
conn.onSessionUpdate((sessionId, update) => {
  if (isAgentMessageChunk(update)) {
    process.stdout.write(update.message);
  }
});

// Timeline events provide a unified, classified stream of all Axon activity —
// protocol messages, system events (turn start/end), and custom events.
// This is the recommended approach for building chat UIs. See "Timeline Events" below.
conn.onTimelineEvent((event) => {
  switch (event.kind) {
    case "acp_protocol":
      // Typed ACP payload — narrow further with event.eventType
      break;
    case "system":
      // event.data: { type: "turn.started" | "turn.completed" | "turn.failed", turnId, ... }
      break;
    case "unknown":
      break;
  }
});

// Start a session and send a prompt (prompt() resolves when the turn ends,
// but onSessionUpdate may still receive trailing content — see Known Limitations)
const session = await conn.newSession({ cwd: "/home/user", mcpServers: [] });
await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello!" }],
});

await conn.disconnect();
```

### Claude Code Agent

```typescript
import { ClaudeAxonConnection, tryParseTimelinePayload } from "@runloop/remote-agents-sdk/claude";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

// Create an Axon channel and a devbox with a Claude broker mount.
// Uses "claude_json" protocol for native Claude SDK wire format.
const axon = await sdk.axon.create({ name: "claude-transport" });
const devbox = await sdk.devbox.create({
  mounts: [{
    type: "broker_mount",
    axon_id: axon.id,
    protocol: "claude_json",
    agent_binary: "claude",
  }],
});

// Connect to Claude Code and set the model
const conn = new ClaudeAxonConnection(axon, devbox, { model: "claude-sonnet-4-5" });
await conn.connect();
await conn.initialize();

// Timeline events classify every Axon event into a typed union — the recommended
// way to build chat UIs. See "Timeline Events" below for the full API.
conn.onTimelineEvent((event) => {
  switch (event.kind) {
    case "claude_protocol":
      // event.data is SDKMessage (assistant, result, system, etc.)
      console.log(event.data.type, event.data);
      break;
    case "unknown":
      // Custom events arrive here — match on event_type and parse the payload
      if (event.axonEvent.event_type === "build_status") {
        const status = tryParseTimelinePayload<{ step: string; progress: number }>(event);
        if (status) console.log(`${status.step}: ${status.progress}%`);
      }
      break;
  }
});

// Send a prompt and iterate over response messages until a "result" message arrives
await conn.send("What files are in this directory?");
for await (const msg of conn.receiveAgentResponse()) {
  console.log(msg.type, msg);
}

// Publish a custom event — it will appear as kind: "unknown" in the timeline
await conn.publish({
  event_type: "build_status",
  origin: "EXTERNAL_EVENT",
  source: "ci-pipeline",
  payload: JSON.stringify({ step: "compile", progress: 100 }),
});

await conn.disconnect();
```

---

## ACP Module

### `ACPAxonConnection`

Higher-level wrapper that manages an `axonStream`, an `AbortController`, and the ACP `ClientSideConnection`.

**Constructor**: `new ACPAxonConnection(axon, devbox, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `axon` | `Axon` | Axon channel from `@runloop/api-client` |
| `devbox` | `Devbox` | Runloop devbox from `@runloop/api-client` |

**Options** (`ACPAxonConnectionOptions`):

| Field | Type | Description |
|-------|------|-------------|
| `verbose` | `boolean` | Emit verbose logs to stderr |
| `requestPermission` | `(params) => Promise<Response>` | Custom permission handler (defaults to auto-approve) |
| `onError` | `(error: unknown) => void` | Error callback (defaults to `console.error`) |
| `onDisconnect` | `() => void \| Promise<void>` | Teardown callback invoked by `disconnect()` (e.g. devbox shutdown) |
| `afterSequence` | `number` | Resume from this Axon sequence number — only events after it are delivered. **Mutually exclusive with `replay`.** |
| `replay` | `boolean` | When `true` (the default), replays historical events without dispatching to session/permission handlers until replay completes; timeline listeners still receive events. Set to `false` for legacy behavior (handlers run for every replayed event). **Mutually exclusive with `afterSequence`.** |

**ACP Methods** (proxied from `ClientSideConnection`):

| Method | Description |
|--------|-------------|
| `initialize(params)` | ACP handshake and capability negotiation (requires `connect()` first) |
| `newSession(params)` | Creates a new conversation session |
| `loadSession(params)` | Loads an existing session |
| `listSessions(params)` | Lists existing sessions |
| `prompt(params)` | Sends a prompt and processes the agent's turn |
| `cancel(params)` | Cancels an ongoing prompt turn |
| `authenticate(params)` | Authenticates using an advertised method |
| `setSessionMode(params)` | Sets session mode (e.g. "ask", "code") |
| `setSessionConfigOption(params)` | Sets a session config option |
| `extMethod(method, params)` | Extension request |
| `extNotification(method, params)` | Extension notification |

**Listeners & Lifecycle**:

| Property / Method | Description |
|---|---|
| `connect()` | Open the Axon SSE stream and wire the `ClientSideConnection` (call before `initialize()`) |
| `protocol: ClientSideConnection` | Escape hatch for experimental/unstable ACP methods (available after `connect()`) |
| `axonId: string` | The Axon channel ID |
| `devboxId: string` | The Runloop devbox ID |
| `signal: AbortSignal` | Fires when the connection closes |
| `closed: Promise<void>` | Resolves when the connection closes |
| `onSessionUpdate(listener)` | Register a session update listener. Returns unsubscribe function. |
| `onAxonEvent(listener)` | Register an Axon event listener. Returns unsubscribe function. |
| `onTimelineEvent(listener)` | Register a classified timeline event listener. Returns unsubscribe function. |
| `receiveTimelineEvents()` | Async generator yielding classified `ACPTimelineEvent`s |
| `abortStream()` | Abort the SSE stream without clearing listeners (useful for testing / reconnect) |
| `disconnect()` | Abort the stream, clear all listeners, and run the `onDisconnect` callback |

### Provisioning Axon + devbox

Create an Axon channel, attach a devbox `broker_mount` with `protocol: "acp"`, then pass `axon` and `devboxId` into `ACPAxonConnection`:

```typescript
import { ACPAxonConnection, PROTOCOL_VERSION } from "@runloop/remote-agents-sdk/acp";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });
const axon = await sdk.axon.create({ name: "my-channel" });
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

// Configure connection with lifecycle hooks and a custom permission handler.
// By default, permissions are auto-approved — override requestPermission to prompt the user.
const conn = new ACPAxonConnection(axon, devbox, {
  onDisconnect: async () => {
    await devbox.shutdown();
  },
  requestPermission: async (params) => {
    const option = params.options[0];
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  },
  onError: (err) => console.warn("transport error:", err),
});

// Register listeners before connect() / initialize() so no events are missed
conn.onSessionUpdate((sessionId, update) => {
  console.log(sessionId, update);
});

await conn.connect();
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "my-app", version: "1.0.0" },
});
```

### `axonStream(options): Stream`

Low-level function that creates an ACP-compatible duplex stream backed by an `Axon` channel from `@runloop/api-client`. Uses `axon.subscribeSse()` for inbound events and `axon.publish()` for outbound messages.

**Parameters** (`AxonStreamOptions`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `axon` | `Axon` | Yes | Axon channel from `@runloop/api-client` |
| `signal` | `AbortSignal` | No | Cancellation signal |
| `onAxonEvent` | `(event: AxonEventView) => void` | No | Callback for every Axon event |
| `onError` | `(error: unknown) => void` | No | Callback for swallowed parse errors |
| `afterSequence` | `number` | No | Resume from this sequence — only events after it are delivered. Mutually exclusive with `replayTargetSequence`. On `ACPAxonConnection`, the connection-level `replay` option (default `true`) is mutually exclusive with `afterSequence` — see Event replay section. |
| `replayTargetSequence` | `number` | No | Marks the end of the historical replay window for buffered agent requests. Set by `ACPAxonConnection` when `replay` is enabled. Mutually exclusive with `afterSequence`. |

**Returns**: `{ readable: ReadableStream<AnyMessage>; writable: WritableStream<AnyMessage> }`

The stream handles JSON-RPC ID correlation internally — Axon's wire format doesn't carry IDs, so the transport layer maintains mapping tables to synthesize and restore them.

### Session Update Type Guards

Narrowing helpers for discriminating `SessionUpdate` variants:

```typescript
import {
  isUserMessageChunk,
  isAgentMessageChunk,
  isToolCall,
  isUsageUpdate,
  // ...
} from "@runloop/remote-agents-sdk/acp";

// SessionUpdate is a union type — use type guards to narrow and handle each variant
conn.onSessionUpdate((sessionId, update) => {
  if (isAgentMessageChunk(update)) {
    process.stdout.write(update.message);
  } else if (isToolCall(update)) {
    console.log(`Tool: ${update.toolName}`);
  }
});
```

Available guards: `isUserMessageChunk`, `isAgentMessageChunk`, `isAgentThoughtChunk`, `isToolCall`, `isToolCallProgress`, `isPlan`, `isAvailableCommandsUpdate`, `isCurrentModeUpdate`, `isConfigOptionUpdate`, `isSessionInfoUpdate`, `isUsageUpdate`.

### Re-exported ACP Types

All types from `@agentclientprotocol/sdk` are re-exported for convenience:

```typescript
import type {
  SessionUpdate,
  SessionNotification,
  ToolCall,
  ContentBlock,
  // ... etc.
} from "@runloop/remote-agents-sdk/acp";
```

---

## Claude Module

### Re-exported Claude SDK Types

All types from `@anthropic-ai/claude-agent-sdk` are re-exported. The most commonly used message types are explicitly named for discoverability:

```typescript
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKStatusMessage,
  SDKUserMessage,
  SDKControlRequest,
  SDKControlResponse,
  SDKToolProgressMessage,
  PermissionMode,
  // ... etc.
} from "@runloop/remote-agents-sdk/claude";
```

### `ClaudeAxonConnection`

Bidirectional, interactive client for Claude Code via Axon. Messages are yielded as `SDKMessage` from `@anthropic-ai/claude-agent-sdk` — the exact types the Claude Code CLI emits.

**Constructor**: `new ClaudeAxonConnection(axon, devbox, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `axon` | `Axon` | Axon channel from `@runloop/api-client` |
| `devbox` | `Devbox` | Runloop devbox from `@runloop/api-client` |

**Options** (`ClaudeAxonConnectionOptions`):

| Field | Type | Description |
|-------|------|-------------|
| `verbose` | `boolean` | Emit verbose logs to stderr |
| `systemPrompt` | `string` | Override the system prompt |
| `appendSystemPrompt` | `string` | Append to the default system prompt |
| `model` | `string` | Model ID (e.g. `"claude-sonnet-4-5"`) — set after initialization |
| `onError` | `(error: unknown) => void` | Error callback (defaults to `console.error`) |
| `onDisconnect` | `() => void \| Promise<void>` | Teardown callback invoked by `disconnect()` (e.g. devbox shutdown) |
| `afterSequence` | `number` | Resume from this Axon sequence number — only events after it are delivered. **Mutually exclusive with `replay`.** |
| `replay` | `boolean` | When `true` (the default), replays historical events without dispatching protocol handlers until replay completes; timeline listeners still receive events. Set to `false` for legacy behavior. **Mutually exclusive with `afterSequence`.** |

**Listeners & Lifecycle**:

| Property / Method | Description |
|---|---|
| `axonId: string` | The Axon channel ID |
| `devboxId: string` | The Runloop devbox ID |
| `connect()` | Open the transport and start the background read loop |
| `initialize()` | Protocol handshake + optional model set (requires `connect()` first) |
| `disconnect()` | Close the transport, fail pending requests, and run `onDisconnect` if provided |
| `abortStream()` | Abort the SSE stream without clearing listeners |

**Messaging**:

| Method | Description |
|--------|-------------|
| `send(prompt)` | Send a user message. Accepts a `string` or `SDKUserMessage`. |
| `receiveAgentEvents()` | Async iterator yielding all `SDKMessage`s indefinitely |
| `receiveAgentResponse()` | Async iterator yielding messages until (and including) a `result` message |
| `receiveMessages()` | **Deprecated** — use `receiveAgentEvents()` |
| `receiveResponse()` | **Deprecated** — use `receiveAgentResponse()` |

**Control**:

| Method | Description |
|--------|-------------|
| `interrupt()` | Interrupt the current conversation turn |
| `setPermissionMode(mode)` | Change the permission mode |
| `setModel(model)` | Change the AI model |

**Listeners**:

| Method | Description |
|--------|-------------|
| `onAxonEvent(listener)` | Register an Axon event listener. Returns unsubscribe function. |
| `onTimelineEvent(listener)` | Register a classified timeline event listener. Returns unsubscribe function. |
| `receiveTimelineEvents()` | Async generator yielding classified `ClaudeTimelineEvent`s |
| `onControlRequest(subtype, handler)` | Register a handler for incoming control requests (e.g. `"can_use_tool"`) |

### `AxonTransport`

Lower-level transport that implements the `Transport` interface using Runloop Axon. Used internally by `ClaudeAxonConnection` but available for custom integrations.

```typescript
import { AxonTransport, type Transport } from "@runloop/remote-agents-sdk/claude";

// AxonTransport gives direct access to the Claude wire protocol over Axon —
// use this if you need custom message handling beyond what ClaudeAxonConnection provides
const transport = new AxonTransport(axon, { verbose: true });
await transport.connect();

// Messages are raw Claude SDK JSON — you manage serialization yourself
await transport.write(JSON.stringify({ type: "user", message: { role: "user", content: "Hello" } }));

for await (const msg of transport.readMessages()) {
  console.log(msg);
}

await transport.close();
```

**`Transport` interface**:

| Method | Description |
|--------|-------------|
| `connect()` | Open the underlying connection |
| `write(data: string)` | Send a JSON message string |
| `readMessages()` | Async iterable of parsed inbound messages |
| `abortStream()` | Abort the SSE stream without closing the transport |
| `reconnect()` | Abort the current SSE stream and re-subscribe |
| `close()` | Close the transport |
| `isReady()` | Whether the transport is connected and not closed |

---

## Timeline Events

Both modules provide a unified timeline event stream that classifies every Axon event into a typed discriminated union. This is the recommended way to build chat UIs that interleave protocol events, system events (turn start/end), and custom events in a single chronological view.

### Event structure

Every timeline event has three fields:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `string` | Discriminant: `"acp_protocol"`, `"claude_protocol"`, `"system"`, or `"unknown"` |
| `data` | varies | Parsed typed payload (`SessionUpdate`, `SDKMessage`, `SystemEvent`, or `null`) |
| `axonEvent` | `AxonEventView` | The raw Axon event with full metadata (origin, event_type, payload, sequence) |

### ACP timeline events (`ACPTimelineEvent`)

```typescript
import type { ACPTimelineEvent } from "@runloop/remote-agents-sdk/acp";
import { tryParseTimelinePayload } from "@runloop/remote-agents-sdk/acp";

conn.onTimelineEvent((event: ACPTimelineEvent) => {
  switch (event.kind) {
    case "acp_protocol":
      // event.eventType narrows the data type (e.g. "session/update" -> SessionNotification, "initialize" -> InitializeRequest | InitializeResponse)
      // Use isFromAgent(event) / isFromUser(event) to check direction (or event.axonEvent.origin directly)
      break;
    case "system":
      // event.data is SystemEvent: { type: "turn.started", turnId } | { type: "turn.completed", turnId, stopReason? } | { type: "turn.failed", turnId, error, stopReason? } | { type: "broker.error", message }
      break;
    case "unknown":
      // event.data is null — use axonEvent to identify and parse the event yourself
      if (event.axonEvent.event_type === "my_custom_event") {
        const payload = tryParseTimelinePayload<{ progress: number }>(event);
        if (payload) console.log(`Progress: ${payload.progress}%`);
      }
      break;
  }
});
```

### Claude timeline events (`ClaudeTimelineEvent`)

```typescript
import type { ClaudeTimelineEvent } from "@runloop/remote-agents-sdk/claude";
import { tryParseTimelinePayload } from "@runloop/remote-agents-sdk/claude";

conn.onTimelineEvent((event: ClaudeTimelineEvent) => {
  switch (event.kind) {
    case "claude_protocol":
      // event.data is SDKMessage (assistant, result, system, etc.)
      break;
    case "system":
      // event.data is SystemEvent
      break;
    case "unknown":
      // event.data is null — check event.axonEvent.event_type and parse the payload
      const payload = tryParseTimelinePayload<{ progress: number }>(event);
      if (payload) console.log(payload.progress);
      break;
  }
});
```

### Async generator pattern

Both connections also provide `receiveTimelineEvents()` for pull-based consumption:

```typescript
for await (const event of conn.receiveTimelineEvents()) {
  console.log(event.kind, event.data);
}
```

### Custom events via `publish()` and `tryParseTimelinePayload`

Both `ACPAxonConnection` and `ClaudeAxonConnection` expose a `publish()` method for pushing custom events to the Axon channel. These arrive in the timeline as `kind: "unknown"` events that you can match on `event_type` and parse with `tryParseTimelinePayload`.

**Publishing a custom event:**

```typescript
await conn.publish({
  event_type: "build_status",
  origin: "EXTERNAL_EVENT",
  source: "ci-pipeline",
  payload: JSON.stringify({ step: "compile", progress: 75, logs: ["..."] }),
});
```

**Consuming it on the other side:**

```typescript
import { tryParseTimelinePayload } from "@runloop/remote-agents-sdk/acp";

interface BuildStatus {
  step: string;
  progress: number;
  logs: string[];
}

conn.onTimelineEvent((event) => {
  if (event.kind === "unknown" && event.axonEvent.event_type === "build_status") {
    const status = tryParseTimelinePayload<BuildStatus>(event);
    if (status) console.log(`${status.step}: ${status.progress}%`);
  }
});
```

`tryParseTimelinePayload` safely JSON-parses `axonEvent.payload` into your expected type, returning `null` if parsing fails or the payload is empty.

### Event replay, `replay`, and `afterSequence`

Both modules subscribe to the Axon SSE stream. By default, `replay` is **`true`**: the connection queries the channel head and replays all events up to that point **without** dispatching to session updates, permission handlers, or (Claude) control handlers — timeline listeners still receive every event. Unresolved permission/control work is flushed after replay completes.

Set **`replay: false`** to restore the previous behavior: every replayed event invokes handlers immediately (useful if you rely on side effects during history replay).

**`replay` and `afterSequence` are mutually exclusive** — you cannot set both on the same connection.

Pass **`afterSequence`** to subscribe starting **after** a known sequence number (skips earlier events entirely — no full replay from the beginning):

```typescript
// ACP — skip events 0–42, receive 43+
const conn = new ACPAxonConnection(axon, devbox, { afterSequence: 42 });
await conn.connect();

// Claude — same option
const conn = new ClaudeAxonConnection(axon, devbox, { afterSequence: 42 });
await conn.connect();
```

Track the cursor by persisting `AxonEventView.sequence` from `onAxonEvent`:

```typescript
let lastSeq: number | undefined;
conn.onAxonEvent((ev) => { lastSeq = ev.sequence; });
// Later, reconnect from where you left off:
const conn2 = new ACPAxonConnection(axon, devbox, { afterSequence: lastSeq });
await conn2.connect();
```

---

## Architecture

Both modules communicate over Runloop Axon channels but use different wire formats:

```
ACP Module                                    Claude Module

┌─────────────────┐                           ┌─────────────────┐
│  axonStream()   │                           │  AxonTransport   │
│  (Axon SDK)     │                           │  (Axon SDK)      │
│       ↕         │                           │       ↕          │
│  JSON-RPC 2.0   │         Axon Bus          │  Claude SDK      │
│  translation    │◄───────────────────────►  │  wire format     │
│       ↕         │       (SSE + publish)     │       ↕          │
│  ACPAxon        │                           │  ClaudeAxon      │
│  Connection     │                           │  Connection      │
└─────────────────┘                           └─────────────────┘
        ↕                                             ↕
   ACP Agent                                   Claude Code
   (in devbox)                                 (in devbox)
```

| | ACP Module | Claude Module |
|---|---|---|
| Wire format | JSON-RPC 2.0 via Axon events | Claude SDK messages via Axon events |
| Transport | `@runloop/api-client` Axon SDK | `@runloop/api-client` Axon SDK |
| Agent protocol | `@agentclientprotocol/sdk` | `@anthropic-ai/claude-agent-sdk` |
| ID tracking | Synthetic (transport maps IDs) | Native (SDK handles correlation) |

## Shared Types

Shared types are available from `@runloop/remote-agents-sdk/shared` or re-exported from each protocol module.

### `BaseConnectionOptions`

Common options accepted by both `ACPAxonConnection` and `ClaudeAxonConnection`:

| Field | Type | Description |
|-------|------|-------------|
| `verbose` | `boolean` | Emit verbose logs to stderr |
| `onError` | `(error: unknown) => void` | Error callback (defaults to `console.error`) |
| `onDisconnect` | `() => void \| Promise<void>` | Teardown callback invoked by `disconnect()` |
| `afterSequence` | `number` | Resume from this Axon sequence number — only events after it are delivered. If omitted and `replay` is `false`, **all events from the beginning of the Axon channel are delivered to handlers**, replaying the entire session history. **Mutually exclusive with `replay`.** |
| `replay` | `boolean` | When `true` (the default), `connect()` replays all events from the beginning of the Axon channel without dispatching to session/protocol handlers (timeline listeners still receive events). Unresolved permission/control requests are delivered after replay. Set `false` to process the full history with handlers firing for every event. **Mutually exclusive with `afterSequence`.** |

### `AxonEventView`

Raw event from the Axon event bus (re-exported from `@runloop/api-client`):

```typescript
interface AxonEventView {
  axon_id: string;
  event_type: string;
  origin: "EXTERNAL_EVENT" | "AGENT_EVENT" | "USER_EVENT" | "SYSTEM_EVENT";
  payload: string;
  sequence: number;
  source: string;
  timestamp_ms: number;
}
```

Use `isFromAgent(event)` / `isFromUser(event)` to check the origin instead of comparing strings directly. These helpers accept both `AxonEventView` and timeline events.

### `AxonEventListener`

Callback type for raw Axon event listeners:

```typescript
type AxonEventListener = (event: AxonEventView) => void;
```

### `SystemEvent`

Typed representation of recognized broker system events:

```typescript
type SystemEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string; stopReason?: string }
  | { type: "turn.failed"; turnId: string; error: string; stopReason?: string }
  | { type: "broker.error"; message: string };
```

`turn.failed` is emitted when the broker terminates an in-flight turn (for
example, on a model error). The Axon stream layer also rejects any pending
ACP JSON-RPC request with a JSON-RPC error (`code: -32000`, `message: error`),
keeping the SSE stream alive so subsequent prompts can still flow.

### `WireData` (Claude module)

Generic JSON wire format used by the Claude transport:

```typescript
type WireData = Record<string, any>;
```

## Known Limitations

- **Explicit `connect()` required** (ACP & Claude): Both `ACPAxonConnection` and `ClaudeAxonConnection` require an explicit `await conn.connect()` call before `initialize()`. The constructor is lightweight and synchronous.
- **Automatic reconnection (single retry)**: If an SSE stream drops unexpectedly, the SDK re-subscribes once and logs a `console.warn`. If the retry also fails, the connection is terminal — create a new instance.
- **Permission handling** (Claude): The `ClaudeAxonConnection` auto-approves all tool use by default. Register a `"can_use_tool"` handler via `onControlRequest()` to customize.

### ACP: `prompt()` resolves before all session updates arrive

The Axon broker delivers events in this order for a given turn:

1. `session/prompt` response — resolves the `prompt()` promise (`stopReason: "end_turn"`)
2. `turn.completed` system event
3. `session/update` notifications — thought chunks, message chunks, etc.

This means **`await conn.prompt(...)` returns before the agent's response text has been delivered via `onSessionUpdate`**. If you need to know when all content for a turn has arrived, use one of these strategies:

- **Use `onTimelineEvent` to watch for `system` events** (recommended). These bracket all content for a turn. Use a `switch` on `event.kind` and the exported `SYSTEM_EVENT_TYPES` constants for exhaustive, type-safe matching:

  ```typescript
  import { SYSTEM_EVENT_TYPES } from "@runloop/remote-agents-sdk/shared";

  conn.onTimelineEvent((event) => {
    switch (event.kind) {
      case "system":
        switch (event.data.type) {
          case SYSTEM_EVENT_TYPES.TURN_STARTED:
            // Agent turn began — disable input, show cancel button
            break;
          case SYSTEM_EVENT_TYPES.TURN_COMPLETED:
            // All content for this turn has been delivered
            break;
          case SYSTEM_EVENT_TYPES.TURN_FAILED:
            // Turn was terminated by the broker (e.g. model error) —
            // surface event.data.error to the user
            break;
        }
        break;
      case "acp_protocol":
        // Protocol event — event.data is the session update payload
        break;
      case "unknown":
        // Unrecognized event — inspect event.axonEvent for raw data
        break;
    }
  });
  ```

- **Debounce after `prompt()` resolves** — wait a short period (e.g. 200ms) for trailing `session/update` events. This is a heuristic and may drop events on slow connections.

## License

[MIT](../LICENSE)

# AGENTS.md — @runloop/remote-agents-sdk

> AI-agent quick reference for using this SDK. For full docs see `README.md`.

## What this package does

Connects applications to Runloop-hosted remote agents (Claude Code, Codex,
OpenCode, etc.) via the Axon event bus. Three protocol modules plus shared
utilities.

## Choose your module

| Module | Import | When to use |
|--------|--------|-------------|
| **ACP** | `@runloop/remote-agents-sdk/acp` | Any ACP-compatible agent (OpenCode, Claude via ACP) |
| **Claude** | `@runloop/remote-agents-sdk/claude` | Claude Code with native SDK message types |
| **Codex** | `@runloop/remote-agents-sdk/codex` | Codex CLI with native app-server message types |
| **Shared** | `@runloop/remote-agents-sdk/shared` | Common types (`BaseConnectionOptions`, `AxonEventView`, `AxonEventListener`) and utilities |

Each module pairs with a devbox `broker_mount` `protocol`: `"acp"` for the ACP
module, `"claude_json"` for the Claude module, `"codex_json"` for the Codex module.

## Required dependencies

```bash
# Always required
npm install @runloop/remote-agents-sdk @runloop/api-client

# Only for the Claude module
npm install @anthropic-ai/claude-agent-sdk

# The Codex module needs no extra dependency (protocol types are vendored)
```

## ACP module — quick start

```typescript
import { ACPAxonConnection, PROTOCOL_VERSION } from "@runloop/remote-agents-sdk/acp";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

// 1. Provision Axon + devbox with ACP broker mount
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
// Constructor is lightweight (no SSE until connect)
const conn = new ACPAxonConnection(axon, devbox, {
  onDisconnect: async () => {
    await devbox.shutdown();
  },
});

// connect() opens the SSE stream and replays all events from the beginning
// of the Axon channel by default (replay: true). Pass afterSequence to skip
// already-seen events, or replay: false to process the full history with
// handlers firing for every event.
await conn.connect();

// 2. Initialize
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "my-app", version: "1.0.0" },
});

// 3. Listen for updates
conn.onSessionUpdate((sessionId, update) => {
  console.log(sessionId, update);
});

// 4. Create session and prompt
const session = await conn.newSession({ cwd: "/home/user", mcpServers: [] });
await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello!" }],
});

// 5. Clean up
await conn.disconnect();
```

### ACP — narrowing session updates

```typescript
import {
  isAgentMessageChunk,
  isToolCall,
  isUsageUpdate,
} from "@runloop/remote-agents-sdk/acp";

conn.onSessionUpdate((sessionId, update) => {
  if (isAgentMessageChunk(update)) process.stdout.write(update.message);
  else if (isToolCall(update)) console.log(`Tool: ${update.toolName}`);
  else if (isUsageUpdate(update)) console.log("Tokens:", update);
});
```

Available guards: `isUserMessageChunk`, `isAgentMessageChunk`,
`isAgentThoughtChunk`, `isToolCall`, `isToolCallProgress`, `isPlan`,
`isAvailableCommandsUpdate`, `isCurrentModeUpdate`, `isConfigOptionUpdate`,
`isSessionInfoUpdate`, `isUsageUpdate`.

### ACP — key methods on `ACPAxonConnection`

| Method | Purpose |
|--------|---------|
| `connect()` | Open the SSE subscription and underlying client; must be called before `initialize()` |
| `initialize(params)` | Negotiate capabilities (call after `connect()`) |
| `newSession(params)` | Create a conversation session |
| `prompt(params)` | Send a prompt |
| `cancel(params)` | Cancel an in-progress turn |
| `onSessionUpdate(listener)` | Subscribe to session updates (returns unsubscribe fn) |
| `onAxonEvent(listener)` | Subscribe to all Axon events (returns unsubscribe fn) |
| `onTimelineEvent(listener)` | Subscribe to classified timeline events (returns unsubscribe fn) |
| `receiveTimelineEvents()` | Async generator yielding classified timeline events |
| `abortStream()` | Abort the SSE stream without clearing listeners |
| `disconnect()` | Close the connection and run `onDisconnect` callback |

## Claude module — quick start

```typescript
import { ClaudeAxonConnection } from "@runloop/remote-agents-sdk/claude";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

// 1. Provision infrastructure
const axon = await sdk.axon.create({ name: "claude-transport" });
const devbox = await sdk.devbox.create({
  mounts: [{
    type: "broker_mount",
    axon_id: axon.id,
    protocol: "claude_json",
    agent_binary: "claude",
  }],
});

// 2. Connect and initialize (replays all Axon events; pass afterSequence to resume)
const conn = new ClaudeAxonConnection(axon, devbox, { model: "claude-sonnet-4-5" });
await conn.connect();      // open transport + start read loop (replays events from beginning)
await conn.initialize();   // protocol handshake + set model

// 3. Send and receive
await conn.send("What files are in this directory?");
for await (const msg of conn.receiveAgentResponse()) {
  console.log(msg.type, msg);
}

// 4. Clean up
await conn.disconnect();
```

### Claude — key methods on `ClaudeAxonConnection`

| Method | Purpose |
|--------|---------|
| `connect()` | Open transport and start the read loop; replays all events unless `afterSequence` was set |
| `initialize()` | Protocol handshake + optional model set (requires `connect()` first) |
| `send(prompt)` | Send a user message (`string` or `SDKUserMessage`) |
| `receiveAgentResponse()` | Async iterator yielding messages until `result` |
| `receiveAgentEvents()` | Async iterator yielding all messages indefinitely |
| `receiveMessages()` | **Deprecated** — use `receiveAgentEvents()` |
| `receiveResponse()` | **Deprecated** — use `receiveAgentResponse()` |
| `interrupt()` | Cancel the current turn |
| `onAxonEvent(listener)` | Subscribe to all Axon events (returns unsubscribe fn) |
| `onTimelineEvent(listener)` | Subscribe to classified timeline events (returns unsubscribe fn) |
| `receiveTimelineEvents()` | Async generator yielding classified timeline events |
| `abortStream()` | Abort the SSE stream without clearing listeners |
| `disconnect()` | Close transport + run `onDisconnect` callback |

## Codex module — quick start

```typescript
import { CodexAxonConnection } from "@runloop/remote-agents-sdk/codex";
import { RunloopSDK } from "@runloop/api-client";

const sdk = new RunloopSDK({ bearerToken: process.env.RUNLOOP_API_KEY });

// 1. Provision infrastructure — the broker spawns `codex app-server`.
//    Codex authenticates via ~/.codex/auth.json (not the OPENAI_API_KEY env
//    var), so a launch command writes the file first. Set CODEX_AUTH_JSON to
//    your local ~/.codex/auth.json contents for ChatGPT-plan auth.
const codexAuthJson =
  process.env.CODEX_AUTH_JSON ??
  JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: process.env.OPENAI_API_KEY! });

const axon = await sdk.axon.create({ name: "codex-transport" });
const devbox = await sdk.devbox.create({
  mounts: [{
    type: "broker_mount",
    axon_id: axon.id,
    protocol: "codex_json",
    agent_binary: "codex",
  }],
  environment_variables: { CODEX_AUTH_JSON: codexAuthJson },
  launch_parameters: {
    launch_commands: [
      'mkdir -p "$HOME/.codex" && umask 077 && printf \'%s\' "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"',
    ],
  },
});

// 2. Connect, then run the app-server initialize handshake
const conn = new CodexAxonConnection(axon, devbox);
await conn.connect();
await conn.initialize();

// 3. Send and receive — the first send() starts a server-side thread automatically
await conn.send("What files are in this directory?");
for await (const frame of conn.receiveTurn()) {
  console.log(frame.method, frame.params);
}

// 4. Clean up
await conn.disconnect();
```

### Codex — key methods on `CodexAxonConnection`

| Method | Purpose |
|--------|---------|
| `connect()` | Open transport and start the read loop; call `initialize()` next |
| `initialize(params?)` | App-server handshake (`initialize` request + `initialized` notification); required after `connect()` |
| `send(prompt)` | Send a prompt (`string` or `InputItem[]`); auto-starts a thread on first call |
| `startThread(params?)` | Start a server-side thread (cwd, model, `sandbox`, `approvalPolicy`, …) and return its id |
| `resumeThread(threadId)` | Resume a known server-side thread and make it current |
| `receiveTurn()` | Async iterator yielding app-server frames until `turn/completed` |
| `receiveAgentEvents()` | Async iterator yielding all agent frames indefinitely |
| `interrupt()` | Cancel the current turn (the broker supplies the live turn id) |
| `steer(prompt)` | Steer the current in-flight turn |
| `request(method, params?)` | Send any app-server request (e.g. `model/list`) and await its response |
| `onApprovalRequest(method, handler)` | Handle server-initiated approval requests (returns unsubscribe fn) |
| `threadId` | The active thread id (`string \| undefined`) |
| `onAxonEvent(listener)` | Subscribe to all Axon events (returns unsubscribe fn) |
| `onTimelineEvent(listener)` | Subscribe to classified timeline events (returns unsubscribe fn) |
| `receiveTimelineEvents()` | Async generator yielding classified timeline events |
| `abortStream()` | Abort the SSE stream without clearing listeners |
| `disconnect()` | Close transport + run `onDisconnect` callback |

## Timeline Events

All protocol modules provide a unified timeline event stream that classifies
every Axon event into a typed discriminated union. This is the recommended way
to build chat UIs that interleave protocol events, system events, and custom
events.

### Timeline event kinds

| Kind | Data type | When |
|------|-----------|------|
| `acp_protocol` | `SessionUpdate \| unknown` | Known ACP protocol event (agent or client method) |
| `claude_protocol` | `SDKMessage` | Known Claude protocol event |
| `codex_protocol` | Typed app-server frame | Known Codex app-server event (narrow with `event.eventType` or the `isCodex*` guards) |
| `system` | `SystemEvent` | Broker system event (`turn.started`, `turn.completed`, `turn.failed`, `broker.error`) |
| `unknown` | `null` | Anything else — inspect `axonEvent` for details |

Every timeline event has `{ kind, data, axonEvent }` where `axonEvent` is the
raw `AxonEventView` for full access to origin, event_type, payload, and sequence.

### Consuming timeline events

```typescript
// Callback-based (push)
conn.onTimelineEvent((event) => {
  switch (event.kind) {
    case "acp_protocol":
      // event.data is SessionUpdate | unknown
      break;
    case "system":
      // event.data is SystemEvent ({ type: "turn.started" | "turn.completed" | "turn.failed", turnId, ... })
      break;
    case "unknown":
      // event.data is null — check event.axonEvent for raw data
      break;
  }
});

// Generator-based (pull)
for await (const event of conn.receiveTimelineEvents()) {
  console.log(event.kind, event.data);
}
```

### Utility: `tryParseTimelinePayload`

```typescript
import { tryParseTimelinePayload } from "@runloop/remote-agents-sdk/acp";

conn.onTimelineEvent((event) => {
  if (event.kind === "unknown") {
    const payload = tryParseTimelinePayload<MyCustomEvent>(event);
    if (payload) { /* handle custom event */ }
  }
});
```

## Event replay and `afterSequence`

> **Important:** Calling `connect()` subscribes to the Axon SSE stream, which
> **replays every event from the very beginning of the channel** by default.
> This effectively replays the entire session — every prompt, response, tool
> call, and system event is re-delivered to your listeners in order. This is
> useful for rebuilding UI state from scratch (e.g. after a page refresh), but
> can be expensive on long-lived channels with many events. Use `afterSequence`
> or `replay: false` to control this behavior (see below).

### Skipping already-seen events

Pass `afterSequence` in the connection options to start the SSE subscription
**after** a known sequence number. Only events with `sequence > afterSequence`
are delivered.

**`replay` (default `true`):** When enabled, `connect()` queries the axon for the
current head sequence and replays events up to that point **without** dispatching
to session/protocol handlers (timeline listeners still receive events). Unresolved
permission or control requests are delivered to handlers after replay finishes.
Set `replay: false` to process the full history with handlers firing for every
event (legacy-style). **`replay` and `afterSequence` are mutually exclusive** —
passing both throws.

**Claude:**

```typescript
const conn = new ClaudeAxonConnection(axon, devbox, {
  afterSequence: 42, // skip events 0–42, receive 43+
});
await conn.connect();
```

**ACP:**

```typescript
const conn = new ACPAxonConnection(axon, devbox, {
  afterSequence: 42,
});
await conn.connect();
```

**Low-level `axonStream`:**

```typescript
const stream = axonStream({
  axon,
  afterSequence: 42,
});
```

### Tracking the sequence cursor

Every event delivered via `onAxonEvent` includes a `sequence` number
(`AxonEventView.sequence`). Persist the last sequence you processed and pass it
as `afterSequence` on the next connection to avoid replaying old events.

```typescript
let lastSeq: number | undefined;
conn.onAxonEvent((ev) => {
  lastSeq = ev.sequence;
});
// ... later, reconnect from where you left off:
const conn2 = new ACPAxonConnection(axon, devbox, { afterSequence: lastSeq });
await conn2.connect();
```

### Automatic reconnect

If the SSE stream drops mid-session, the SDK automatically re-subscribes
**once** using the last-seen sequence number — no events are lost during a
transient disconnect. If the retry also fails, the connection is terminal;
create a new instance.

## Constraints and gotchas

- **Auto-reconnect (single retry).** If an SSE stream drops unexpectedly, the SDK re-subscribes once. ACP logs a `console.warn`; Claude logs only when `verbose: true` is set. If the retry also fails, the connection is terminal — create a new instance.
- **ACP permissions default to auto-approve** (`allow_always` > `allow_once` > first option). Pass `requestPermission` to customize.
- **Claude permissions also auto-approve** all tool use. Register a `"can_use_tool"` handler via `onControlRequest()` to customize.
- **Codex approvals also auto-approve** by default. Register handlers via `onApprovalRequest()` to customize, or mount with `launch_args: ["-c", "approval_policy=never"]` for headless full-auto (no approval traffic at all).
- **Explicit `connect()` required:** All connections require `await conn.connect()` first, followed by `initialize()` — ACP, Claude, and Codex alike.
- **Node >= 22** required.
- **`@runloop/api-client`** is a peer dep — you must install it yourself.
- **`@anthropic-ai/claude-agent-sdk`** is an optional peer dep — only needed for the Claude module. The Codex module has no extra dependency.
- **`prompt()` resolves before all session updates arrive.** The broker sends the prompt response and `turn.completed` system event *before* flushing thought/message chunks as `session/update` notifications. Use `onAxonEvent` to watch for `turn.started` / `turn.completed` system events to accurately bracket turn content. See the SDK README for details.

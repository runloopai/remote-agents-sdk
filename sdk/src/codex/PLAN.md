# Codex Connection Plan

Add a native OpenAI Codex connection (`@runloop/remote-agents-sdk/codex`) that
talks to the runloop broker's new non-ACP codex adapter
(runloopai/runloop #10185–#10188). Model the public API on the Claude
connection (`sdk/src/claude/`), and type the wire protocol with official
OpenAI Codex app-server protocol types, the way the Claude module is typed
with `@anthropic-ai/claude-agent-sdk`.

## Background: the broker wire contract

The broker's codex adapter (`runloop//rust/broker/src/adapter/codex/`) spawns
`codex app-server` and is a thin JSON proxy over the Axon event bus, mounted
with `broker_mount: { protocol: "codex", agent_binary: "codex" }`
(`BrokerMountProtocol.codex`, `AXON_ATTACH_PROTOCOL_CODEX = 5`). The
app-server speaks newline-delimited JSON-RPC over stdio (no `"jsonrpc":"2.0"`
field). Everything the SDK needs to know:

- **Client → broker**: publish Axon events whose `event_type` is the JSON-RPC
  method and whose `payload` is the **complete raw JSON-RPC frame** (id
  included). The broker forwards payloads to the process verbatim. This
  differs from the ACP module's `axonStream`, where payloads are params-only
  and frames are reconstructed — do not reuse `axonStream`.
  - `thread/start` request → new session.
  - `turn/start` request → prompt: `{ threadId, input: [{ type: "text", text }] }`.
  - `turn/interrupt` request → cancel. The adapter discards the client's
    params and issues the real interrupt from its tracked thread/turn ids, so
    the client does not need to know the live turn id.
  - Any other JSON-RPC frame (approval responses, `thread/name/set`,
    `model/list`, config writes, …) is forwarded as a generic control frame —
    the protocol is extensible without broker changes.
  - The client must **not** send `initialize`/`initialized` — the adapter
    performs the handshake itself before processing input.
  - Client request ids must not use the reserved `runloop-broker-` prefix.
- **Broker → client**: every app-server frame is forwarded verbatim as an
  `AGENT_EVENT` whose `event_type` is the frame's `method`; JSON-RPC
  response/error frames (which carry no method) arrive as `event_type:
  "response"` and are correlated by request id.
  - The new thread id is delivered via the `thread/started` notification at
    `params.thread.id` (responses to `thread/start` are plain `"response"`
    frames).
  - Server-initiated **approval requests** arrive as JSON-RPC requests
    (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
    `item/tool/requestUserInput`, `item/permissions/requestApproval`,
    `execCommandApproval`, `applyPatchApproval`, …). The client answers by
    publishing a raw JSON-RPC response frame with the matching id.
  - Turn lifecycle also surfaces as broker SYSTEM_EVENTs (`turn.started`,
    `turn.completed`, `turn.failed`) exactly as for Claude/ACP — the shared
    `tryParseSystemEvent` machinery applies unchanged.
- **Resume**: the broker persists the codex thread id and issues
  `thread/resume` itself on broker resume. Client-side reconnect uses the
  same `afterSequence`/`replay` SSE cursor mechanism as Claude.

Protocol source of truth: JSON Schemas in the Codex CLI repo
(`openai/codex`, `codex-rs/app-server-protocol/schema/json`). The broker's
vendored `codex-codes` crate is pinned to v0.143.1 (tested against Codex CLI
0.143.0) — keep the SDK's types in the same version band.

## Design decisions

- **Module shape**: new `sdk/src/codex/` subpath module, mirroring
  `sdk/src/claude/` file-for-file where the analogy holds. Same published
  package (`@runloop/remote-agents-sdk`), new `./codex` export — no
  release-please changes.
- **Official types**: there is no published npm package for the app-server
  protocol (`@openai/codex-sdk` only ships the exec-level Thread/Turn/Item
  types; `@openai/codex` is the CLI binary). The official path is the CLI's
  own generator: `codex app-server generate-ts`. Vendor its output under
  `sdk/src/codex/protocol/generated/` with a codegen script
  (`scripts/generate-codex-protocol.ts`, `@openai/codex` as a devDependency
  pinned to the broker's version band) and a provenance header (CLI version +
  date). This mirrors the broker vendoring `codex-codes`. Hand-written code
  imports from a thin `protocol/index.ts` that re-exports the generated types
  plus method-name constants.
- **Claude-style API, codex-native sessions**: Codex has real server-side
  threads (closer to ACP), but the connection should feel like Claude: the
  connection tracks the current thread id internally so `send()` "just works",
  while still exposing thread control for callers that want it.
- **Transport**: a codex-specific `CodexAxonTransport` modeled on the Claude
  `AxonTransport` (publish/SSE, replay buffering, `isFromAgent` filtering) —
  but frames pass through whole; the only mapping is `method → event_type`
  outbound. Request/response correlation uses real JSON-RPC ids
  (`Map<id, resolver>`), not the ACP one-in-flight-per-method scheme.

## Steps

### 1. Protocol types + classification — `sdk/src/codex/protocol/`, `classify-codex-axon-event.ts`

Pure addition; no connection yet.

- Vendor generated types (`protocol/generated/`), codegen script, and
  `protocol/index.ts` barrel with method constants (`THREAD_START =
  "thread/start"`, notification and approval-request method sets, and the
  `RESPONSE_EVENT_TYPE = "response"` and reserved `runloop-broker-` id-prefix
  constants).
- `types.ts`: `CodexTimelineEvent` discriminated union over the frames we
  classify — thread lifecycle (`thread/started`), turn lifecycle
  (`turn/started`, `turn/completed`), item events (`item/started`,
  `item/completed`, `item/agentMessage/delta`,
  `item/commandExecution/outputDelta`, `item/reasoning/*`), approval
  requests, `error`, `response`, plus shared
  `SystemTimelineEvent`/`UnknownTimelineEvent`.
- `classify-codex-axon-event.ts` via the shared `createClassifier` factory
  (`shared/timeline.ts`), plus `isCodexProtocolEventType`.
- `timeline-event-guards.ts`: codex-specific guards
  (`isCodexAgentMessageDeltaEvent`, `isCodexItemCompletedEvent`,
  `isCodexApprovalRequestEvent`, …) re-exporting the shared system guards.
- Unit tests with wire-correct fixture frames (crib payload shapes from the
  broker's `test_fixtures/src/model_factory.rs::make_codex_event` and the
  vendored schemas).

### 2. Transport + connection — `transport.ts`, `connection.ts`, exports

- `CodexAxonTransport`: `connect`/`reconnect` over `axon.subscribeSse`,
  `write(frame)` → `axon.publish({ event_type: method-or-"response", origin:
  "USER_EVENT", payload, source: "codex-sdk-client" })`, `readMessages()`
  generator yielding parsed frames from `AGENT_EVENT`s, `SystemError` on
  `broker.error`. Replay handling mirrors Claude's: during replay, buffer
  server-initiated approval requests keyed by JSON-RPC id, drop those already
  answered (matching USER_EVENT response frames appear in the replay window),
  and flush only unresolved ones.
- `CodexAxonConnection` (options extend `BaseConnectionOptions`; add
  `threadStartParams` — cwd, model, sandbox/approval policy — and
  `approvalHandlers`):
  - `connect()` — replay resolution + SSE + read loop with single
    auto-reconnect, same skeleton as Claude. No initialize step (the broker
    owns the handshake).
  - `startThread(params?)` → send `thread/start`, resolve on the
    `thread/started` notification, record `threadId`, return it.
  - `send(prompt: string | InputItem[])` → `turn/start` against the tracked
    thread (auto-`startThread` on first send, so the Claude-style
    connect-then-send flow works).
  - `interrupt()` → `turn/interrupt`.
  - `resumeThread(threadId)` → `thread/resume` (for client-driven resume of a
    known thread; broker-driven resume needs nothing from us).
  - `request(method, params)` — typed escape hatch for any other app-server
    method (model list, thread rename, config), correlated by id; the codex
    analogue of Claude's `sendControlRequest` / ACP's `extMethod`.
  - `onApprovalRequest(method, handler)` with safe defaults mirroring the
    Claude/ACP modules' auto-approve behavior; unanswered = declined after
    timeout. Note the launch-args alternative: mounting with
    `launch_args: ["-c", "approval_policy=never"]` (full-auto) skips the flow
    entirely — document both.
  - Event surfaces identical to Claude: `onAxonEvent`, `onTimelineEvent`,
    `receiveTimelineEvents()`, `nextMessage()`/`receiveAgentEvents()`, and
    `receiveTurn()` (Claude's `receiveAgentResponse` analogue, terminating on
    `turn/completed`).
- Wire-up: `sdk/src/index.ts` (`export * as codex`), `sdk/package.json`
  `exports["./codex"]`, barrel `sdk/src/codex/index.ts` re-exporting the
  protocol types (`export type * from "./protocol/index.js"`).
- Unit tests on `__test-utils__/mock-axon.ts`: lifecycle, thread start id
  capture, send/interrupt frame shapes, id correlation, approval round-trip,
  replay buffering, system-error fatality.

### 3. Examples + docs

- `examples/feature-examples/src/agents.ts`: add a native `codex` agent
  (`broker_mount: { protocol: "codex", agent_binary: "codex" }`,
  `OPENAI_API_KEY` secret); keep `codex-acp` until downstream consumers
  migrate, then retire it. Blueprint installs `@openai/codex`.
- New use-case examples where codex-native behavior differs (approval
  round-trip, thread resume); regenerate `compatibility.md`.
- `sdk/README.md` + `sdk/AGENTS.md`: module table, broker `protocol` docs,
  quickstart snippet.

## Downstream consumer requirements (reflex/agentflow)

The first consumer replaces `@reflex/plugin-agent-codex`'s `ACPAxonConnection`
usage with this connection. Its provider layer needs, concretely:

- `onAxonEvent` / `onTimelineEvent` listener surfaces identical to Claude's
  (it pumps raw events into its stream service and maps
  `agent.error`/`broker.error` timeline events to error reporting).
- Cold-restart thread-id recovery: after a server restart the provider
  rebuilds the connection and re-derives the thread id by replaying the axon
  log and waiting for the `thread/started` notification (today it keys on the
  ACP `session/new` echo). `startThread()`'s notification-waiting logic must
  therefore also work in replay mode, or the connection should expose the
  last-seen thread id from replayed events.
- Compatibility with a supervisor that health-checks the transport
  (abort-signal or `isConnected`/`isDisconnected` hints — mirror whatever
  `ClaudeAxonConnection`/`AxonTransport` expose).
- Approval requests surfaced as first-class handler events (its Claude
  provider parks `can_use_tool` on user input; codex approvals should be
  parkable the same way even though headless use will run
  `approval_policy=never`).

## Sequencing (one PR each)

1. `feat(sdk): vendor codex app-server protocol types and event classification`
   — step 1; pure addition, independently reviewable against the schemas.
2. `feat(sdk): add CodexAxonConnection and transport` — step 2; the behavioral
   core, reviewed against the broker adapter's contract.
3. `docs(sdk): codex examples, compatibility matrix, and module docs` — step 3;
   needs a devbox image with the codex CLI and an OpenAI credential to run the
   compat matrix.

## Open items

- **Version pinning**: broker vendored 0.143.x; npm `@openai/codex` latest is
  0.144.x. Confirm the app-server schema is compatible across that band (the
  broker adapter is forward-tolerant by design; the SDK generator should pin
  to the broker's band until proven otherwise).
- **Approval defaults**: auto-approve in the SDK (matching ACP module
  behavior) vs. full-auto via launch args (`approval_policy=never`) as the
  documented default for headless use. Lean: SDK default auto-approve +
  document launch-args full-auto.
- **`turn/steer`**: codex supports steering an in-flight turn; expose as
  `steer()` in PR 2 if the broker forwards it cleanly (it classifies as
  Control, so it should), otherwise defer.
- **`@openai/codex-sdk` item types**: the exec-level Thread/Turn/Item types
  overlap with app-server items but are a different surface; do not mix them
  in. Generated app-server types only.

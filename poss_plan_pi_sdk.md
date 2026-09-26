# Pi Connect — SDK Sub-Plan (`runloopai/remote-agents-sdk`)

Sub-plan for adding a native **Pi** connection (`@runloop/remote-agents-sdk/pi`) to this
SDK, so Reflex can drive Pi on Runloop devboxes the same way it drives Claude and Codex.

Companion to the broker-side work in `runloopai/runloop`:

| PR | State | What it lands |
|----|-------|---------------|
| [#10238](https://github.com/runloopai/runloop/pull/10238) | merged | `java/rust/broker/clients/pi-codes` — Rust serde types for Pi's native JSONL wire protocol |
| [#10243](https://github.com/runloopai/runloop/pull/10243) | open | the Pi adapter (`src/adapter/pi/`) — input classification, output translation, turn settlement, resume state |
| [#10256](https://github.com/runloopai/runloop/pull/10256) | open (draft) | protocol plumbing — proto `AXON_ATTACH_PROTOCOL_PI = 6`, Java translator, OpenAPI wire name **`pi_json`**, broker-owned `--session-dir` |

The wire name the SDK must speak is **`pi_json`**.

---

## 1. The broker contract, as the SDK sees it

Read off `pi_protocol.rs::classify_input` / `output_event_type` and `pi_adapter.rs::handle_input`
in #10243, plus `bootstrap.rs` in #10256. This is the whole contract — everything below is
derived from it.

### 1.1 Client → broker (`USER_EVENT` publishes)

The Pi adapter is a **translating** proxy, not the verbatim JSON-RPC proxy Codex is. The
`event_type` selects the adapter's behaviour; the `payload` is a raw Pi command frame.

| `event_type` | adapter behaviour | payload |
|---|---|---|
| `turn/start` | `AdapterInput::TurnInput` — writes the payload to Pi's stdin **as-is**, stamps `id` if absent, marks a broker turn open, then issues its own `get_state` | a Pi command frame, in practice `{"type":"prompt", …}` |
| `cancel` | `AdapterInput::Cancel` — records cancel, writes `{"type":"abort"}` | ignored |
| `initialize` | `AdapterInput::Initialize` — writes `{"type":"get_state"}` (no `id`) | ignored |
| anything else whose payload is a JSON object with a string `type` | `AdapterInput::Control` — forwarded to Pi's stdin verbatim | any Pi command frame |
| anything else | `AdapterInput::Ignore` | — |

Two consequences that shape the design:

- **The SDK owns prompt correlation.** `prepare_prompt` keeps a non-empty string `id` the
  client already put on the frame and uses *that* as the turn's `prompt_id`. So if the SDK
  stamps its own `id`, it gets a correlatable ack **and** the broker still settles the turn
  correctly (`is_active_prompt_ack` compares against the id it kept).
- **`broker-N` is a reserved id space.** The adapter's own commands use `format!("broker-{n}")`.
  The SDK must never emit an id with that prefix — directly analogous to Codex's
  `RESERVED_REQUEST_ID_PREFIX = "runloop-broker-"`.

### 1.2 Broker → client (`AGENT_EVENT`s)

Every Pi stdout line is forwarded verbatim as the payload, with `event_type` from
`output_event_type`:

`response` · `agent_start` · `message_start` · `message_update` · `message_end` ·
`tool_execution_start` · `tool_execution_update` · `tool_execution_end` · `turn_start` ·
`turn_end` · `agent_end` · `agent_settled`

Frames Pi emits that `pi-codes` does not model (`queue_update`, `compaction_start`/`_end`,
`auto_retry_start`/`_end`, `summarization_retry_*`, `bash_execution_update`,
`extension_ui_request`, `extension_error`) go through `translate_unrecognized`: still
forwarded verbatim, `event_type` taken from the payload's own `type` field (or `"unknown"`).

Note the **casing asymmetry**: inbound Pi event types are `snake_case`
(`turn_start`), outbound broker control names are slash-style (`turn/start`). They do not
collide, but they are one typo apart — hence constants, never literals (§3.1).

### 1.3 Turn lifecycle

- A `prompt` ack (`{"type":"response","command":"prompt","success":true}`) means **accepted**,
  not complete. `send()` must resolve on acceptance and say so loudly.
- An **accepted** turn completes at **`agent_settled`** — never at `agent_end`, which can be
  followed by an auto-retry (`willRetry`) or a queued continuation.
- A **rejected** prompt (`success:false`, id matching the open turn) completes the broker turn
  immediately with `StopReason::Error` and the ack's `error` string.
- Stop reasons: `stop`→`EndTurn`, `length`→`MaxTokens`, `aborted`→`Cancelled`,
  `error`→`Error`; `toolUse` never terminates a turn.
- All of this also surfaces as ordinary broker `SYSTEM_EVENT`s (`turn.started`,
  `turn.completed`, `turn.failed`, `agent.log`, `broker.error`), so
  `shared/timeline.ts::tryParseSystemEvent` and `SystemError` apply with zero changes.

### 1.4 Resume

The broker persists `sessionFile` (harvested from `get_state` responses) as its `ResumeState`
and replays it with `switch_session` on resume, before any client traffic. Client-side
reconnect is the existing `replay` / `afterSequence` SSE cursor. **No SDK work is required for
resume** — we expose `getState()` / `switchSession()` as escape hatches, not as plumbing.

### 1.5 What Pi does *not* have

No handshake. No approval or permission requests. No server-initiated requests of any kind in
RPC mode (extension UI dialogs exist but require installed extensions and are out of scope).
This makes the Pi module **strictly simpler** than both Claude and Codex — no
`onControlRequest`/`onApprovalRequest` surface, no replay buffering of unanswered requests.

---

## 2. Shared-primitive analysis

### 2.1 Reuse as-is — no changes needed

The Codex work (#134/#135, then #139/#146/#147/#149) already did the hoisting. Everything
protocol-neutral lives in `sdk/src/shared/` and is genuinely generic, not
Codex-shaped-and-renamed:

| Primitive | Path | Fit for Pi |
|---|---|---|
| `AxonFrameTransport<TFrame>` | `sdk/src/shared/axon-frame-transport.ts` | Publish/SSE, replay windowing, `SystemError` raising, reconnect — fully parameterized by callbacks (`parseFrame`, `resolveEventType`, `validateOutbound`, …). Pi needs no new capability from it. |
| `runConnectionReadLoop` | `sdk/src/shared/connection-read-loop.ts` | Single-retry reconnect, fatal-vs-transient split. Message type is generic. |
| `PendingRequestMap<Id, Value>` | `sdk/src/shared/pending-request-map.ts` | Pi correlates on its own `id` (`string`) instead of a JSON-RPC id. Same engine. |
| `AsyncMessageQueue` | `sdk/src/shared/async-message-queue.ts` | Pull surface for `receiveAgentEvents()` / `receiveTurn()`. |
| `ListenerSet` | `sdk/src/shared/listener-set.ts` | `onAxonEvent` / `onTimelineEvent` fan-out with error isolation. |
| `resolveReplayTarget` | `sdk/src/shared/connect-guards.ts` | `replay` / `afterSequence` mutual-exclusion + head lookup. |
| `createClassifier` + `tryParseSystemEvent` + `SYSTEM_EVENT_TYPES` | `sdk/src/shared/timeline.ts` | The classification pipeline; Pi supplies `isProtocolEventType` + `toProtocolEvent`. |
| shared system guards | `sdk/src/shared/timeline-event-guards.ts` | `isTurnStartedEvent`, `isTurnCompletedEvent`, `isTurnFailedEvent`, `isAgentLogEvent`, … re-exported unchanged. |
| `timelineEventGenerator` | `sdk/src/shared/timeline-generator.ts` | `receiveTimelineEvents()`. |
| `runDisconnectHook`, `makeLogger`, `makeDefaultOnError` | `lifecycle.ts`, `logging.ts` | Unchanged. |
| `ConnectionStateError`, `SystemError` | `sdk/src/shared/errors/` | Same state-machine vocabulary. |
| `isFromAgent` / `isFromUser` | `sdk/src/shared/origin-guards.ts` | Unchanged. |
| `mock-axon` test utils | `sdk/src/__test-utils__/mock-axon.ts` | `makeAgentEvent` / `makeUserEvent` / `makeSystemEvent` cover every Pi test we need. |

### 2.2 The one thing to lift — 8 lines, rides in PR 3

`AxonFrameTransportOptions` currently requires four callbacks that exist **solely** to buffer
unanswered server-initiated requests across the replay window:

```ts
isReplayRequest(event, frame): boolean;
requestId(frame): FrameRequestId | undefined;
isReplayAnswer(event, frame): boolean;
answerId(frame): FrameRequestId | undefined;
```

Pi has no server-initiated requests, so it would pass `() => false` / `() => undefined` stubs
four times. Make them **optional**, defaulting to "no replay-request buffering". This is not
speculative abstraction — it is the shared API telling the truth about which callbacks are
mandatory, and it makes the "protocol with no server requests" case a first-class shape rather
than a stubbed-out lie. Cost: ~8 lines in `axon-frame-transport.ts` plus one test asserting
the default path buffers nothing. It ships inside PR 3; it does not deserve its own PR.

### 2.3 Deliberately NOT abstracted

**The template's "PR 2: lift shared connection primitives" is dropped.** Codex is already
generic enough; there is no second lift to do. Specifically:

1. **No `BaseAxonConnection` base class.** Roughly 120 lines of `connect()` / `disconnect()` /
   `abortStream()` / `readLoop()` / state flags look duplicated across
   `claude/connection.ts:313-430`, `codex/connection.ts` and (soon) `pi/connection.ts`. They
   are not the same lines. Claude's `connect()` feeds a control-request replay buffer and is
   followed by a mandatory `initialize()` handshake; Codex's tracks `threadId` / `currentTurnId`
   from sniffed events inside `onAxonEvent` and has its own handshake; Pi's has neither and
   captures `sessionFile` instead. Expressing that in a base class needs ~6 template hooks,
   and the genuinely hard logic (read loop, reconnect, pending correlation, replay
   resolution) is *already* shared. What's left is mechanical field declarations. Three call
   sites is where you *may* abstract, not where you must. Revisit at agent #4 if the residue
   is still literally identical — it will be easier then, because we'll have three real
   examples instead of two and a guess.
2. **No shared `receiveTurn()` / message-queue mixin.** Turn termination is irreducibly
   per-protocol (`result` for Claude, `turn/completed` for Codex, `agent_settled` for Pi) and
   is six lines each.
3. **No generic `AgentConnection` interface for consumers.** `combined-app` deliberately keeps
   one hook per protocol (`useClaudeAgent` / `useACPAgent` / `useCodexAgent`, 641–775 lines
   each) because the event vocabularies are not isomorphic. A lowest-common-denominator
   interface would erase exactly what makes Pi worth a native module: `message_update`
   streaming deltas with a cumulative `partial` assistant message.
4. **No dependency on Pi's own npm types.** See §3.1 — this is the one place where the
   obvious reuse is the wrong call, and it needs justifying.

---

## 3. Grounded scope — file by file

New module `sdk/src/pi/`, mirroring `sdk/src/codex/` where the analogy holds.

### 3.1 `sdk/src/pi/protocol/index.ts` — hand-written wire types + constants

**Decision: hand-write a curated subset. Do not depend on Pi's packages, and do not codegen.**

Pi *does* publish types — `@earendil-works/pi-coding-agent@0.82.1` re-exports `RpcCommand`,
`RpcResponse`, `RpcSessionState` from its root, and `@earendil-works/pi-agent-core` exports the
`AgentEvent` union. Reusing them is nonetheless wrong here:

- The type graph reaches `@earendil-works/pi-ai`, whose **runtime** dependencies are `openai`,
  `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`,
  `undici` and `typebox` (3.6 MB unpacked, five provider SDKs). `pi-coding-agent` itself is 15 MB
  and bundles a TUI plus `@silvia-odwyer/photon-node` (native). That is an enormous surface —
  even as an optional peer dep — for about a dozen types.
- `RpcResponse`'s `data` members reference deep internal source paths
  (`../../core/agent-session.ts`, `../../core/bash-executor.ts`) that are not part of any
  published subpath export. The types are exported; their transitive references are not
  addressable.
- Codegen is unavailable: Pi ships no JSON Schema. The broker plan says so explicitly and
  hand-wrote `pi-codes` for that exact reason. This is the mirror image of the Codex decision
  (`sdk/src/codex/PLAN.md` — there a generator *did* exist, so we vendored its output).

So: hand-write the same curated subset the broker typed, with a provenance header naming Pi
`0.82.1` and `java/rust/broker/clients/pi-codes`. **This is verifiable, not vibes** — I
diffed `pi-agent-core`'s `AgentEvent` union against `pi-codes/src/events.rs` and they are
field-for-field identical (`pi-codes` adds only `agent_end.willRetry` and `agent_settled`,
which are RPC-mode additions). Structural parity with `pi-codes` is a reviewable property, and
the reviewer's job is to check it against §1 and the crate.

Contents, no `generated/` directory and no codegen script:

- `PiCommand` — discriminated on `type`: `prompt` (`message`, `images?`, `streamingBehavior?`),
  `steer`, `follow_up`, `abort`, `get_state`, `new_session` (`parentSession?`),
  `switch_session` (`sessionPath`), each with optional `id`. Plus `PiCommandFrame` as the
  open escape-hatch shape (`{ type: string; id?: string; [k: string]: unknown }`).
- `PiEvent` — the eleven `pi-codes` events, and `PiResponse` — the ack
  (`type`, `id?`, `command`, `success`, `error?`, `data?`).
- Nested types carried over from `pi-codes/src/types.rs`: `PiSessionState` (crucially
  `sessionFile`, `sessionId`, `isStreaming`, `model`), `PiModel`, `AgentMessage` union
  (`UserMessage` / `AssistantMessage` / `ToolResultMessage` / `BashExecutionMessage` /
  `CustomMessage` / `BranchSummaryMessage` / `CompactionSummaryMessage`),
  `AssistantMessageEvent` (the twelve streaming deltas), `Usage`, `Cost`, `StopReason`,
  `ThinkingLevel`, `QueueMode`, `ImageContent`, `SessionChange`. Fields Pi itself declares
  `any` (tool `args`/`result`, `diagnostics`, model `compat`) stay `unknown`, matching the
  crate's `serde_json::Value`.
- Constants — the antidote to the §1.2 casing asymmetry:
  `PI_TURN_START_EVENT_TYPE = "turn/start"`, `PI_CANCEL_EVENT_TYPE = "cancel"`,
  `PI_RESPONSE_EVENT_TYPE = "response"`, `PI_EVENT_TYPES` / `PI_EVENT_TYPE_SET` (the eleven),
  `RESERVED_REQUEST_ID_PREFIX = "broker-"`.

### 3.2 `sdk/src/pi/types.ts` — timeline union

`PiTimelineEvent = PiProtocolTimelineEvent | SystemTimelineEvent | UnknownTimelineEvent`,
built exactly like `sdk/src/codex/types.ts`: a `ProtocolTimelineEvent<M, D>` helper producing
`{ kind: "pi_protocol"; eventType: M; data: D } & BaseTimelineEvent`, one member per modelled
frame (`PiAgentStartTimelineEvent`, `PiMessageUpdateTimelineEvent`,
`PiToolExecutionEndTimelineEvent`, `PiAgentSettledTimelineEvent`, `PiResponseTimelineEvent`, …).

**Scope call:** classify exactly the twelve frames `pi-codes` models. The unmodelled Pi events
(§1.2) fall through to `kind: "unknown"` with the raw payload reachable via `axonEvent.payload`
and `tryParseTimelinePayload`. Adding them to the typed union is one line each and can happen
the moment we see them in real traffic — but typing frames we have never observed, against
docs rather than fixtures, is how you ship wrong types. The broker made the same scope call.

### 3.3 `sdk/src/pi/classify-pi-axon-event.ts`

`isPiProtocolEventType(eventType)` (`PI_EVENT_TYPE_SET.has(t) || t === PI_RESPONSE_EVENT_TYPE`)
plus `classifyPiAxonEvent = createClassifier<PiProtocolTimelineEvent>({ … })`. A near-copy of
`classify-codex-axon-event.ts` (31 lines) — pass-through `data`, `eventType` from
`ev.event_type`.

### 3.4 `sdk/src/pi/timeline-event-guards.ts`

`isPiAgentStartEvent`, `isPiMessageStartEvent`, `isPiMessageUpdateEvent`, `isPiMessageEndEvent`,
`isPiTurnStartEvent`, `isPiTurnEndEvent`, `isPiAgentEndEvent`, `isPiAgentSettledEvent`,
`isPiToolExecutionStartEvent`/`UpdateEvent`/`EndEvent`, `isPiResponseEvent`, plus two
convenience guards over the nested delta that a UI actually wants —
`isPiAssistantTextDeltaEvent`, `isPiAssistantThinkingDeltaEvent` (narrowing
`message_update.assistantMessageEvent.type`). Re-export the shared system guards, as
`codex/timeline-event-guards.ts` does.

### 3.5 `sdk/src/pi/transport.ts` — `PiAxonTransport`

Thin wrapper over `AxonFrameTransport<PiFrame>`, structurally the same 85 lines as
`codex/transport.ts`:

```ts
parseFrame:        JSON.parse, object-or-undefined
resolveEventType:  frame.type === "prompt" ? PI_TURN_START_EVENT_TYPE
                 : frame.type === "abort"  ? PI_CANCEL_EVENT_TYPE
                 : (frame.type ?? "unknown")
validateOutbound:  throw if typeof id === "string" && id.startsWith("broker-")
source:            "pi-sdk-client"
logPrefix:         "pi-axon-transport"
systemErrorsDuringReplay: false      // matches codex
// replay-request callbacks omitted entirely — see §2.2
```

The `prompt→turn/start` and `abort→cancel` mapping is the only translation in the module, and
it is the reason `steer` / `follow_up` are **not** routed through `turn/start`: they must reach
Pi without re-opening a broker turn (which would clobber the adapter's tracked `prompt_id`).
Sent as themselves, they classify as `Control` and are forwarded verbatim. Correct by
construction.

### 3.6 `sdk/src/pi/connection.ts` — `PiAxonConnection`

`PiAxonConnectionOptions extends BaseConnectionOptions` + `requestTimeoutMs?`. Public surface:

| Member | Behaviour |
|---|---|
| `connect()` | `resolveReplayTarget` → `PiAxonTransport.connect()` → `runConnectionReadLoop`. **No `initialize()`** — see §5.5. |
| `send(message, options?)` | publish `{ type: "prompt", id, message, images? }`; await the ack correlated on `id`; **throws `PiCommandError` if `success:false`**. Resolves on *acceptance*, documented in the TSDoc and in `sdk/AGENTS.md`. |
| `steer(message, images?)` / `followUp(message, images?)` | `{type:"steer"}` / `{type:"follow_up"}` as Control; ack-correlated. |
| `interrupt()` | `{ type: "abort", id }` → `cancel`. |
| `getState()` | `{ type: "get_state", id }` → `PiSessionState`. The supported way to read `sessionFile` / `sessionId` / `isStreaming`. |
| `newSession(parentSession?)` / `switchSession(sessionPath)` | Control; return `SessionChange`. |
| `command<T>(frame)` | Typed escape hatch for any Pi command not wrapped above (`set_model`, `compact`, `bash`, `get_messages`, `export_html`, …). Public, unlike Codex's private `request()`, because Pi's command surface is ~30 commands and v1 deliberately wraps five. |
| `sessionId` / `sessionFile` getters | Captured from `get_state` acks seen live **or during replay**. Free, because the adapter issues a `get_state` after every single turn — the Pi analogue of Codex's `threadId` capture, and exactly what a cold-restarting consumer needs. |
| `receiveAgentEvents()` | All agent frames indefinitely. |
| `receiveTurn()` | Terminates on `agent_settled`, or on a failed `prompt` ack for the open turn. **Not** on `agent_end` (§1.3). |
| `onAxonEvent` / `onTimelineEvent` / `receiveTimelineEvents()` | Identical to Claude/Codex. |
| `isConnected` / `isDisconnected` / `abortStream()` / `disconnect()` / `publish()` | Identical to Codex. |

`route(frame)`: if `frame.type === "response"` → capture session state, then
resolve/reject the pending entry for `frame.id` (acks with no `id`, e.g. the adapter's own
`broker-N` `get_state`, are still queued so nothing is silently swallowed); everything else →
`messageQueue.push(frame)`. **No server-request branch at all** — that whole limb of
`codex/connection.ts` (`handleServerRequest`, `defaultApproval`, `defaultDecline`,
`approvalWithTimeout`, ~90 lines) simply does not exist here.

`PiCommandError extends Error` with `command` and the ack's `error` string, mirroring
`CodexRequestError`.

### 3.7 Wire-up

- `sdk/src/pi/index.ts` — barrel, same five lines as `sdk/src/codex/index.ts`.
- `sdk/src/index.ts` — add `export * as pi from "./pi/index.js";`.
- `sdk/package.json` — add `exports["./pi"]` → `./dist/pi/index.{js,d.ts}`. **No new
  dependency, no new peer dependency** (§3.1).
- `sdk/src/index.test.ts` — extend the export-surface assertions.
- Docs: `sdk/AGENTS.md` (module table, `pi_json` mount, quickstart, key-methods table,
  gotchas) and `sdk/README.md` (protocol table row + quickstart).

---

## 4. PR-by-PR plan

Small, independently reviewable, in dependency order. Every PR title is Conventional Commits
with a scope from `sdk | acp | claude | examples | deps | project` (`.github/workflows/pr-title.yml`
enforces this). `.github/pull_request_template.md` checklist applies to all of them.

Repo-wide gate from `AGENTS.md` — after any `sdk/src/` edit, in this order:

```bash
bun run check      # biome lint + format
bun run typecheck  # tsc --project tsconfig.check.json, no emit
bun run build      # tsc
bun run test       # vitest run
```

### PR 1 — `docs(sdk): add Pi connect sub-plan`  ← this PR

**Scope.** This document only.

**Files.** `poss_plan_pi_sdk.md`.

**Acceptance.** Plan cites real paths and symbols; every open question in §5 has a
recommendation; the dropped-PR decision (§2.3) is justified.

**Verify.**

```bash
bun install
bun run check
```

(`biome check ./src` only reads `sdk/src`, so a docs-only PR is a no-op for it — run it anyway
to confirm the tree is clean before the branch stack starts.)

---

### PR 2 — `feat(sdk): add Pi wire protocol types and event classification`

**Scope.** Pure addition, no connection. Reviewable in isolation against §1 and the `pi-codes`
crate. Mirrors Codex #134.

**Files.**

- `sdk/src/pi/protocol/index.ts` (new)
- `sdk/src/pi/types.ts` (new)
- `sdk/src/pi/classify-pi-axon-event.ts` (new)
- `sdk/src/pi/timeline-event-guards.ts` (new)
- `sdk/src/pi/classify-pi-axon-event.test.ts` (new)
- `sdk/src/pi/timeline-event-guards.test.ts` (new)

**Acceptance.**

- Types are structurally faithful to `java/rust/broker/clients/pi-codes/src/{commands,events,response,types}.rs`; provenance header names Pi `0.82.1` and the crate path.
- Every `pi-codes` field is present with the crate's `camelCase` wire name; `any`-typed Pi fields are `unknown`, not invented shapes.
- `classifyPiAxonEvent` returns `kind:"pi_protocol"` for all twelve modelled `event_type`s, `kind:"system"` for `turn.started`/`turn.completed`/`turn.failed`/`agent.log`/`broker.error`, `kind:"unknown"` for `queue_update` and friends with the payload still reachable.
- Fixtures are wire-correct — cribbed from `pi-codes/tests/protocol_tests.rs` and `broker/tests/pi_protocol_tests.rs`, not hand-invented.
- Guards test file exists. **Note the parity gap:** `sdk/src/codex/` has *no* `timeline-event-guards.test.ts` while `claude/` and `acp/` do. Claude is the parity target, not Codex.
- Coverage thresholds in `sdk/vitest.config.ts` (statements 80 / branches 75 / functions 75 / lines 80) still pass. `index.ts` and `types.ts` are excluded from coverage, so `protocol/index.ts` being type-only is fine, but the classifier and guards must be exercised.

**Verify.**

```bash
bun run check && bun run typecheck && bun run build && bun run test
bun run --filter '@runloop/remote-agents-sdk' test:coverage
```

---

### PR 3 — `feat(sdk): add PiAxonConnection and transport`

**Scope.** The behavioural core, reviewed against the adapter contract in §1. Includes the
8-line shared-primitive relaxation from §2.2. Mirrors Codex #135.

**Files.**

- `sdk/src/pi/transport.ts` (new) + `sdk/src/pi/transport.test.ts` (new)
- `sdk/src/pi/connection.ts` (new) + `sdk/src/pi/connection.test.ts` (new)
- `sdk/src/pi/index.ts` (new)
- `sdk/src/shared/axon-frame-transport.ts` — four replay-request callbacks become optional
- `sdk/src/shared/index.ts` — no new exports expected; touch only if the option type is re-exported
- `sdk/src/index.ts` — `export * as pi`
- `sdk/src/index.test.ts` — export-surface assertions
- `sdk/package.json` — `exports["./pi"]`
- `sdk/AGENTS.md`, `sdk/README.md` — module table, `pi_json`, quickstart, gotchas

**Acceptance.** Unit tests on `__test-utils__/mock-axon.ts` covering:

- `send("hi")` publishes exactly one `USER_EVENT` with `event_type: "turn/start"`, payload `{"type":"prompt","id":"pi-sdk-…","message":"hi"}`, `source: "pi-sdk-client"`.
- `send()` resolves when the matching `{"type":"response","command":"prompt","success":true,"id":…}` arrives, and rejects with `PiCommandError` carrying `error` when `success:false`.
- `interrupt()` publishes `event_type: "cancel"` with an `abort` frame; `steer()`/`followUp()` publish `event_type: "steer"`/`"follow_up"` and do **not** use `turn/start`.
- Outbound ids starting with `broker-` throw.
- `receiveTurn()` terminates on `agent_settled`; a preceding `agent_end` with `willRetry:true` does **not** terminate it. This is the single most important test in the PR.
- `getState()` resolves `PiSessionState`; `sessionFile`/`sessionId` getters populate from acks seen during **replay** as well as live.
- Ack frames with no `id` (the adapter's own `broker-N` `get_state`) reach `receiveAgentEvents()` rather than vanishing.
- `broker.error` is fatal: read loop terminates, pending commands reject, `connect()` afterwards throws `ConnectionStateError("terminated")`.
- Single auto-reconnect on SSE end, via the shared read loop.
- Existing Claude, Codex and ACP suites stay green — they are the guard on the `axon-frame-transport.ts` change.
- Coverage thresholds pass.

**Verify.**

```bash
bun run check && bun run typecheck && bun run build && bun run test
bun run --filter '@runloop/remote-agents-sdk' test:coverage
```

---

### PR 4 — `feat(examples): add Pi agent to blueprint, feature examples, and combined app`

**Scope.** Make Pi reachable from both example vehicles. Depends on broker #10243 + #10256
being merged **and deployed** to the target environment (§5.3).

**Files.**

- `examples/blueprint/Dockerfile` — `RUN npm install -g @earendil-works/pi-coding-agent@0.82.1`
- `examples/feature-examples/src/types.ts` — `protocol: "acp" | "claude" | "codex" | "pi"`; `BrokerMount.protocol` gains `"pi_json"`; `PiAxonConnection` in the ctx union
- `examples/feature-examples/src/agents.ts` — a `pi` entry: `brokerMount: { protocol: "pi_json", agentBinary: "pi", workingDirectory: "/home/user", launchArgs: ["--model", "nebius/glm-5.2"] }`, `secrets: { NEBIUS_API_KEY: "NEBIUS_API_KEY" }`
- `examples/feature-examples/src/scaffold.ts` — `pi: "pi_json"` in `brokerProtocolByClientProtocol`; extend the `protocol: config.protocol as "acp" | "claude_json"` cast comment (§5.1); `launch_commands` writing `~/.pi/agent/models.json` (§5.10)
- `examples/feature-examples/src/use-cases/single-prompt.ts` — a `ctx.pi` branch
- `examples/feature-examples/src/use-cases/session-resume-pi.ts` (new) — `getState()` → `sessionFile`, suspend/resume the devbox, assert context survives; the Pi counterpart of `thread-resume-codex.ts`
- `examples/combined-app/src/server/pi-manager.ts` (new), `src/server/routes/pi.ts` (new), `src/server/agent-registry.ts` (+`"pi"` in `agentType`, `piManager`), `src/server/index.ts`, `src/server/routes/{lifecycle,prompt}.ts`
- `examples/combined-app/src/shared/ws-events.ts`, `src/client/types.ts`, `src/client/hooks/usePiAgent.ts` (new), `src/client/hooks/{useAgent,useAgentList}.ts`, `src/client/App.tsx`, `src/client/components/{SetupCard,AgentSidebar,TimelineEventItem}.tsx`
- **Generated, do not hand-edit:** `examples/feature-examples/compatibility.md` and `llms.txt` — regenerate with `bun run feature-compat` (templates live in `examples/feature-examples/templates/`)

**Acceptance.**

- `feature-compat` produces a `Pi` column and a `pi` agent row; `single-prompt` and `session-resume-pi` pass against a live devbox.
- combined-app can provision a Pi agent, stream a response with visible text and thinking deltas from `message_update`, and interrupt a turn.
- The blueprint builds and `pi --mode rpc` starts with the Nebius/glm-5.2 provider config.
- No example passes `--session-dir` in `launch_args` (§5.11).

**Verify.**

```bash
bun run check && bun run typecheck && bun run build && bun run test
bun run --filter 'feature-examples' typecheck
bun run --filter '@runloop/example-*' typecheck
bun run --filter '@runloop/example-combined-app' build
bun run build-blueprint          # needs RUNLOOP_API_KEY
bun run feature-compat           # needs RUNLOOP_API_KEY + NEBIUS_API_KEY
```

---

### PR 5 — `test(examples): Pi end-to-end verification runbook`

**Read this before assuming a template exists.** There is **no** e2e or integration suite
anywhere in this repository. `sdk/vitest.config.ts` includes only `src/**/*.test.ts`, and every
one of those is a unit test against `__test-utils__/mock-axon.ts`. `grep -ri vbrowser` over the
repo returns nothing. `.github/workflows/ci.yml` has no Runloop credentials; the only live-agent
CI is `.github/workflows/smoke-tests.yml`, which fires a `repository_dispatch` at the separate
`runloopai/remote-agents-sdk-smoke-tests` repo and only on `release-please--branches--main`
branches. So the same gap the parallel planner found on the runloop side holds here: Codex has
no e2e template to copy, and inventing a browser-driving CI job in this PR would be new
infrastructure smuggled in under a test label.

**Scope.** Codify the Pi e2e as (a) a reproducible operator runbook, and (b) the repo's
existing live-agent automation, which is `feature-examples`. vbrowser is the *instrument* used
to execute the runbook against `combined-app` and capture evidence — not a new CI dependency.

**Files.**

- `examples/combined-app/docs/pi-e2e-runbook.md` (new) — ordered steps: build blueprint → set `NEBIUS_API_KEY` → `bun run --filter '@runloop/example-combined-app' dev` → drive the UI in vbrowser → create Pi agent, prompt, observe streaming deltas, interrupt, suspend/resume, reconnect-with-replay → expected timeline events at each step, with the `pi_json` mount JSON inline
- `examples/feature-examples/src/use-cases/single-prompt.ts`, `session-resume-pi.ts` — assertions tightened by whatever the runbook exposes
- `examples/feature-examples/compatibility.md` — regenerated (generated artifact)
- `examples/combined-app/README.md` — link the runbook

**Acceptance.**

- Runbook executed end to end in vbrowser against a live devbox on the Pi-enabled broker; screenshots of a streamed turn, an interrupted turn, and a post-resume turn attached to the PR description.
- `bun run feature-compat` shows `pass` for `pi` on `single-prompt`, `agent-via-blueprint` and `session-resume-pi`; any `xfail` carries a written reason, matching the existing `elicitation-acp` convention.
- Follow-up issue filed against `runloopai/remote-agents-sdk-smoke-tests` to add the Pi case to the release smoke suite — that repo, not this one, is where recurring live-agent coverage belongs.

**Verify.**

```bash
bun run --filter '@runloop/example-combined-app' dev   # + vbrowser session
bun run feature-compat
bun run check && bun run typecheck && bun run build && bun run test
```

---

## 5. Open questions and risks — each with a recommendation

**5.1 `@runloop/api-client@1.20.0` has no `pi_json` in its mount union.**
The installed type is `protocol?: 'acp' | 'claude_json' | null` — it lacks even `codex_json`,
because the OpenAPI change lands in #10256 and Stainless has not regenerated.
*Recommendation:* follow the established precedent verbatim — a widened local literal plus a
cast at the boundary, exactly as `examples/feature-examples/src/scaffold.ts:338` and
`examples/combined-app/src/server/codex-manager.ts:133` already do, with the comment updated to
name `pi_json` too. Extend the comment rather than adding a second one. File a follow-up to drop
all three casts once the regenerated client ships. Do **not** hand-edit generated client types.

**5.2 Source of truth for the TypeScript wire types.**
*Recommendation:* hand-write the curated subset; no Pi npm dependency, no codegen. Fully
argued in §3.1 — the deciding facts are `@earendil-works/pi-ai`'s five provider SDKs, the
unaddressable internal source paths in `RpcResponse`, and the verified field-for-field match
between `pi-agent-core`'s `AgentEvent` and `pi-codes/src/events.rs`.

**5.3 Broker PRs #10243 / #10256 are not merged.**
*Recommendation:* land PR 2 and PR 3 now — they are unit-tested entirely against `mock-axon`
and need no live broker, and the contract they encode is already frozen in merged #10238 plus
the two open diffs. Gate PR 4 and PR 5 on #10256 being merged *and deployed* to the target
environment. If the adapter's `event_type` names change before merge, the blast radius is
`protocol/index.ts` constants plus `resolveEventType` — one file each.

**5.4 `turn/start` vs `turn_start` casing asymmetry.**
Outbound broker control names are slash-style; inbound Pi event types are `snake_case`. One
typo apart, and a `resolveEventType` that emitted `turn_start` would silently classify as
`Ignore` — the prompt would vanish with no error anywhere.
*Recommendation:* constants only, never literals (§3.1); a transport test asserting the exact
published `event_type` for prompt / abort / steer; a comment in `resolveEventType` naming
`classify_input` as the reason.

**5.5 Should the SDK expose `initialize()`?**
*Recommendation:* **no.** Pi has no handshake, and the adapter already issues `get_state` at
spawn and after every turn. An `initialize()` publishing `event_type:"initialize"` would only
make the broker send `{"type":"get_state"}` with **no `id`** — so its ack is uncorrelatable and
`initialize()` could not return the state it exists to fetch. `getState()` sending our own
id-stamped `get_state` as a Control frame is strictly more capable and strictly less
ceremony. Document the absence prominently: `sdk/AGENTS.md` currently says "**Explicit
`connect()` required:** … followed by `initialize()` — ACP, Claude, and Codex alike", and Pi is
the first module that breaks that pattern.

**5.6 `send()` resolves on acceptance, not completion.**
A caller who awaits `send()` and then reads the transcript sees nothing.
*Recommendation:* keep acceptance semantics — it is the only thing the ack actually means, and
pretending otherwise would mean silently swallowing rejections. Mitigate with documentation in
three places (TSDoc, `sdk/AGENTS.md` gotchas, README), and point callers at `receiveTurn()` or
the `turn.completed` system event. This mirrors the existing documented ACP gotcha
("`prompt()` resolves before all session updates arrive").

**5.7 Prompt-id ownership.**
*Recommendation:* the SDK stamps its own `pi-sdk-<n>-<rand>` id. Verified safe against
`prepare_prompt`: a non-empty client id is preserved and becomes the adapter's `prompt_id`, so
`is_active_prompt_ack` still matches and turn settlement is unaffected — while the SDK gains
ack correlation it otherwise could not have. Enforce the `broker-` prefix ban in
`validateOutbound`, mirroring Codex's reserved-prefix guard.

**5.8 Steering vs. a second prompt while streaming.**
Pi rejects a `prompt` sent during streaming unless `streamingBehavior` is set, and a `prompt`
routed through `turn/start` mid-turn would clobber the adapter's tracked `prompt_id`.
*Recommendation:* `send()` is for turn-starting prompts only and surfaces Pi's rejection as
`PiCommandError`; `steer()` / `followUp()` are separate methods publishing Pi's own `steer` /
`follow_up` commands as Control frames, which never touch broker turn state. Do not paper over
this with an auto-`streamingBehavior` heuristic based on a possibly-stale `isStreaming`.

**5.9 Unmodelled Pi events.**
`queue_update`, `compaction_start`/`_end`, `auto_retry_start`/`_end`,
`summarization_retry_*`, `bash_execution_update`, `extension_ui_request`, `extension_error`
reach the client verbatim but classify as `unknown`.
*Recommendation:* ship v1 that way. They are not lost — `axonEvent.payload` and
`tryParseTimelinePayload` reach them, which is exactly what `unknown` is for. Type them when we
have real fixtures. `auto_retry_*` is the one worth watching, since it is observable evidence
for the `agent_end`-is-not-the-end rule; add it first if it shows up.

**5.10 glm-5.2 on Runloop's Nebius endpoint.**
Pi resolves custom providers from `~/.pi/agent/models.json`, with `apiKey` supporting
`"$ENV_VAR"` interpolation.
*Recommendation:* write that file from devbox `launch_commands`, exactly mirroring the Codex
`auth.json` bootstrap already documented in `sdk/AGENTS.md`:

```jsonc
{ "providers": { "nebius": {
    "baseUrl": "<Runloop's dedicated Nebius endpoint>",
    "api": "openai-completions",
    "apiKey": "$NEBIUS_API_KEY",
    "models": [{ "id": "glm-5.2", "name": "GLM 5.2 (Nebius)", "reasoning": true,
                 "contextWindow": 262144, "maxTokens": 32000 }],
    "compat": { "thinkingFormat": "zai" } } } }
```

with `launch_args: ["--model", "nebius/glm-5.2"]`. Prefer the documented `--model provider/id`
form over `--provider`, which appears on Pi's RPC page but not its models page. Treat
`contextWindow` / `maxTokens` / `compat` as **to be confirmed against the live endpoint in
PR 4** — `thinkingFormat: "zai"` is the documented GLM-family setting but is unverified against
this deployment, and `supportsDeveloperRole: false` / `maxTokensField` may also be needed. This
is configuration to validate, not to guess in a plan.

**5.11 `--session-dir` is broker-owned.**
#10256 appends `--session-dir <state_root>/<axon_id>/pi-sessions` *after* user args
specifically so Pi's last-value-wins parsing cannot let a client redirect session persistence
out of the durable root.
*Recommendation:* never pass `--session-dir` from the SDK or examples; assert its absence in
the PR 4 review and say why in the example comment. A client that overrode it would silently
break resume across devbox snapshots.

**5.12 `message_update` volume vs. the message queue.**
Every token delta is one `message_update` frame carrying a **full** `partial` assistant
message. `AsyncMessageQueue` warns at 1000 buffered frames, so a consumer using only
`onTimelineEvent` and never draining `receiveAgentEvents()` will emit overflow warnings on a
long turn.
*Recommendation:* document that Pi consumers either use the push surfaces
(`onTimelineEvent` / `onAxonEvent`, which are unbounded) or drain `receiveAgentEvents()` —
the same caveat already applies to Codex, and Pi merely makes it easier to hit. Do not raise
the cap: the warning is doing its job. If real traffic shows the warning firing in normal use,
the fix is a `dropDeltas`-style option, not a bigger buffer.

**5.13 Test-coverage parity target.**
`sdk/src/codex/` has no `timeline-event-guards.test.ts`, while `claude/` and `acp/` do.
*Recommendation:* treat **Claude** as the parity target for the Pi module's test layout, not
Codex. CI runs `test:coverage` with enforced thresholds, so under-testing a new module is a
red build, not a silent gap.

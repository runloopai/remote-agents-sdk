# Elicitation v2 — SDK design and implementation plan

**Status:** proposed
**Scope:** `@runloop/remote-agents-sdk` (ACP module). Reflex-side changes are out of scope; the
contract this plan exposes to Reflex is summarized in [§8](#8-contract-exposed-to-reflex).
**Date:** 2026-07-13

---

## 1. Summary

Elicitation (the agent pausing mid-turn to request user input — a form, or a URL to visit) is
today supported only implicitly: the transport translates `session/elicitation` events with
method-keyed correlation, and every application re-implements an untyped `extMethod` handler with
hand-rolled ids and parked promises. This breaks under concurrency, loses requests on
reconnect/replay, produces ids that are useless as durable keys, and gives callers no way to know
whether a response ever reached the agent.

This plan makes elicitation a first-class, id-correlated SDK feature:

- A **durable per-elicitation id** used for correlation, replay resolution, UI keys, retries, and
  stale detection — the ACP `elicitationId` when the agent provides one, with a deterministic
  replay-stable fallback derived from the Axon sequence when it does not (see §3.1 for why a
  fallback is mandatory).
- An **`ElicitationManager`** that owns the full elicitation lifecycle at the transport boundary:
  requests are intercepted before JSON-RPC translation, keyed by the durable id, replayed
  correctly across reconnects, and answered through a typed API with a real delivery
  acknowledgement from the broker publish.
- **Both wire dialects** — legacy `session/elicitation` (ACP ≤ 0.18) and preview
  `elicitation/create` (ACP ≥ 0.19) — detected per-request from the method name and answered on
  the same method. (Dialects cannot be negotiated from capabilities; see §3.3.)
- A **first-class API**: `onElicitation(handler)`, `respondToElicitation(id, response)`,
  `onElicitationComplete(handler)`, `pendingElicitations()`, plus capability helpers and retained
  `initialize` results.
- A **composable default `Client`** so applications override single methods instead of
  reimplementing the whole interface (resolves the existing `@todo` in `sdk/src/acp/types.ts`).
- **Simulated protocol tests** for concurrency, replay, reconnect, decline/cancel, and staleness;
  real-agent coverage stays in `examples/feature-examples` behind the existing
  `expectedFailures` (xfail) mechanism until agents ship the feature.

## 2. Current behavior — verified findings

Each original problem statement was checked against the code. All are real; receipts below.

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Responses are correlated by method name; one in-flight request per method, second throws | **Confirmed** (client→agent direction) | `sdk/src/acp/axon-stream.ts:58` (`pendingRequests: Map<method, id>`), `axon-stream.ts:519-527` (duplicate in-flight throws) |
| 2 | Concurrent elicitations collide in the replay buffer; one is dropped on reconnect | **Confirmed** | `axon-stream.ts:142` (buffer is `Map<event_type, AnyMessage>`), `axon-stream.ts:326` (`replayBuffer.set(event_type, msg)` overwrites), `axon-stream.ts:310-314` (one `USER_EVENT` response deletes by event type, "resolving" whichever request is buffered) |
| 3 | Agent→client requests get synthetic, process-local JSON-RPC ids | **Confirmed** | `axon-stream.ts:64` (`nextAgentRequestId = 900_000`, reset every `axonStream()` call); ids never reach the wire — `jsonRpcToAxon` publishes only `method` + `params`/`result` (`axon-stream.ts:513-557`) |
| 4 | No first-class API; apps implement untyped `extMethod`, allocate ids, park promises | **Confirmed** | SDK's built-in client handles only `requestPermission` + `sessionUpdate` (`sdk/src/acp/connection.ts:563-597`); ACP SDK 0.18 routes `session/elicitation` to `client.extMethod` or throws method-not-found; reference app hand-rolls everything (`examples/combined-app/src/server/acp-client.ts:122-142`) |
| 5 | Completion rejects every pending elicitation | **Confirmed** | `examples/combined-app/src/server/acp-client.ts:110-117` — on any `session/elicitation/complete`, all pending elicitations are rejected; the notification's `elicitationId` is ignored |
| 6 | No delivery acknowledgement | **Confirmed** | Responses flow `extMethod` promise → `ClientSideConnection` → `WritableStream.write` → `axon.publish`; a publish failure surfaces only to `onError` (`axon-stream.ts:478-494`), never to the code that answered |
| 7 | Negotiated capabilities discarded | **Confirmed (nuance)** | `initialize()` *returns* the `InitializeResponse` (`connection.ts:245-253`) but the connection does not retain or expose it, so anything holding only the connection (e.g. a request handler) cannot inspect capabilities |

Additional latent bugs found during verification (not in the original list):

- **(F1) Preview-dialect requests would hang the agent.** `elicitation/create` is not in ACP
  0.18's `CLIENT_METHODS`, so `isClientMethod()` is false and the event falls through to the
  "unknown event type → JSON-RPC *notification*" path (`axon-stream.ts:448-453`). A notification
  has no id, so no response can ever be produced — the agent waits forever. It is also skipped by
  replay buffering (`processReplayEvent` only buffers `isClientMethod` events,
  `axon-stream.ts:317`).
- **(F2) `session/elicitation/complete` is mishandled during replay.** It *is* a
  `CLIENT_METHODS` entry, so `processReplayEvent` buffers an agent-sent complete notification as
  if it were an unresolved *request* and re-delivers it after replay. Meanwhile a historical
  complete does **not** resolve the buffered elicitation request it refers to (only `USER_EVENT`
  responses delete buffer entries), so a URL-mode elicitation that finished long ago is
  re-delivered as pending after every reconnect.
- **(F3) Responses answered by another client are invisible live.** In live mode all
  `USER_EVENT`s are skipped (`axon-stream.ts:244-247`). If a second connection (e.g. a restarted
  Reflex worker, or another browser tab publishing through a second SDK instance) answers an
  elicitation, the first connection's pending state never settles.
- **(F4) The Claude module already does this right.** `sdk/src/claude/transport.ts:306-344`
  buffers `control_request`s by the in-payload `request_id` and resolves them individually — the
  exact pattern this plan brings to ACP elicitation. Useful precedent for reviewers.

## 3. Corrections to the original proposal

The proposal's direction is right — key everything on a durable in-payload id — but three of its
factual premises are wrong, and the design below accounts for each.

### 3.1 `elicitationId` does not exist for form-mode requests — in either dialect

Verified against both schemas
([0.18.0](https://unpkg.com/@agentclientprotocol/sdk@0.18.0/schema/schema.json),
[1.2.1](https://unpkg.com/@agentclientprotocol/sdk@1.2.1/schema/schema.json)) and the
[elicitation RFD](https://agentclientprotocol.com/rfds/elicitation):

- `ElicitationUrlMode` — `required: ["elicitationId", "url"]`. URL mode **has** the id.
- `ElicitationFormMode` — `required: ["requestedSchema"]` only. Form mode has **no id field**,
  and this did not change between 0.18 and the current preview (1.2.1); the id is used only to
  correlate the out-of-band `…/complete` notification, which exists only for URL mode.

Form-mode is the common case for Reflex, so *"standardize on the in-payload `elicitationId`"*
cannot work as stated. **Fix:** the durable id is
`payload.elicitationId` when present (URL mode today; also honored if an agent includes it in
form mode as an extension field — extra properties pass through untouched in 0.18's `extMethod`
path), otherwise a deterministic SDK-derived id `rl-seq-<sequence>` from the Axon event's
`sequence`. Axon sequences are 1-based, monotonic, and identical on every replay of the channel
(`sdk/src/shared/replay.ts:26-28`), so the fallback is exactly as durable as a payload id — it
survives reconnect, process restart, and replay, and is safe as a DB/UI/audit key. The public
event carries `idSource: "payload" | "sequence"` so consumers can tell which they got.

### 3.2 Elicitation *responses* carry no id on the wire either

`ElicitationResponse` is `{ action, _meta? }` — no session id, no elicitation id — and
`jsonRpcToAxon` drops the JSON-RPC id when publishing (only `event_type` + result payload go
out). So even with ids on requests, replay cannot pair historical responses with historical
requests when two elicitations of the same dialect overlap; the proposal never addresses the
response side. **Fix:** the SDK stamps the durable id into the response payload's reserved
extension field when publishing: `_meta: { "runloop.dev/elicitation": { id } }`. `_meta` is
explicitly designated by ACP for implementation metadata, agents must not assume its contents,
and Axon replays payloads verbatim — so replay can pair request↔response by id with zero new
persistence. For responses published by older SDK versions (no stamp), replay falls back to
method-based pairing against the **oldest** unresolved request of that dialect (FIFO), which is
strictly no worse than today's behavior.

### 3.3 Dialects cannot be selected "behind capability negotiation"

In both schema versions, elicitation capabilities are advertised **only by the client**
(`ClientCapabilities.elicitation: { form?: {}, url?: {} }`). `AgentCapabilities` and
`InitializeResponse` contain nothing elicitation-related, so the agent never tells the client
which dialect (or whether any) it speaks. **Fix:** dialect handling is *per-request detection*,
not negotiation: the manager recognizes both request methods (`session/elicitation`,
`elicitation/create`) and both completion methods (`session/elicitation/complete`,
`elicitation/complete`), records the dialect on the pending entry, and publishes the response on
**the same method the request arrived on**. Capability work is still real, just different:
helpers to *advertise* client-side form/url support in `initialize`, and retention/exposure of
the agent's `InitializeResponse`.

### 3.4 Smaller clarifications

- **"Correlate pending requests by instance id" only applies to agent→client traffic.**
  Client→agent responses (`initialize`, `session/prompt`, …) echo only `event_type` from the
  broker; there is no in-payload id to key on. The one-in-flight-per-method constraint for agent
  methods stays (documented; see non-goals §10).
- **The upstream ACP SDK rename landed in 0.19.0** (`session/elicitation` → `elicitation/create`,
  agent-client-protocol PR #792/#966); current npm latest is 1.2.1, where the `Client` interface
  gained first-class `unstable_createElicitation` / `unstable_completeElicitation` members and
  **blocks** `extMethod` fallthrough for those methods. This plan deliberately does *not* upgrade
  the pinned `@agentclientprotocol/sdk@0.18.0` (see §10) — but because the manager intercepts
  elicitation *before* the upstream `ClientSideConnection` ever sees it, a later upgrade cannot
  break elicitation routing. Both messages remain UNSTABLE/preview upstream; the schema may still
  move (risk tracked in §9).
- **End-to-end concurrency has a broker dependency.** The broker routes `USER_EVENT` responses
  back to the agent's original JSON-RPC request by `event_type` alone. Client-side fixes make
  *our* side correct and the `_meta` stamp gives the broker/agent everything needed to correlate,
  but until the broker echoes a request id (or reads the stamp), two same-method in-flight
  elicitations answered out of order may still be mis-attributed agent-side. Flagged as an open
  question (§9) with a concrete broker ask; not a reason to hold the SDK work, since single
  in-flight elicitation (the overwhelmingly common case) and all replay/reconnect scenarios are
  fully fixed client-side.

## 4. Design

### 4.1 Ownership boundary (unchanged from proposal)

- **SDK owns:** wire dialects, id derivation and correlation, replay/reconnect correctness,
  delivery acknowledgement, capability advertisement helpers and retention.
- **Reflex owns:** the event model, DB state (`needs_input`), the HTTP contract (`409`), UI.
- Reflex consumes only: the durable id, the typed events, the typed delivery result. It never
  touches transport internals.

### 4.2 The `ElicitationManager` and stream interception

New module `sdk/src/acp/elicitation.ts` (manager, dialect table, id derivation, types, guards).

**Interception point.** `axonStream()` gains an optional `elicitationSink`. When set, events
whose `event_type` is in the elicitation dialect table are routed to the sink and **excluded**
from JSON-RPC translation, the generic replay buffer, and `NOTIFICATION_TYPES` handling — in
both live and replay mode, for `AGENT_EVENT` and `USER_EVENT` origins. Everything else
(permissions, fs, terminal, session updates) is untouched. `onAxonEvent` / timeline listeners
still fire for every event first, so observability and Reflex's timeline are unaffected.

Why intercept rather than implement via the default client's `extMethod`:

1. **Typed delivery ack for free.** The manager publishes responses itself via `axon.publish()`
   and sees the `PublishResultView` (or the thrown error) directly. Through the
   `ClientSideConnection` path, the response write happens deep inside upstream machinery with no
   per-message feedback (`extMethod` never even learns the JSON-RPC id).
2. **No synthetic ids in the elicitation path at all** — the instability problem is removed, not
   patched.
3. **Replay correctness lives in one place**, keyed by the durable id, instead of being split
   between the generic event-type-keyed buffer and app code.
4. **Upstream-proof.** ACP SDK ≥ 0.19 blocks `extMethod` fallthrough for elicitation methods;
   interception makes the future dependency upgrade a non-event for this feature.

**Escape hatch.** Connection option `elicitation: "managed" | "passthrough"` (default
`"managed"`). `"passthrough"` restores today's exact behavior (events flow to
`extMethod`/`extNotification`) for apps like the current `combined-app` that already built their
own handling and want to migrate on their own schedule. This is the only behavioral break;
called out in the changelog with a migration note.

**Manager state.** A `Map<elicitationId, PendingElicitation>` where each entry holds the
normalized request, dialect, scope (`sessionId`/`toolCallId` or `requestId` — the preview scope
fields), mode, sequence, and settlement state. Entries settle on: local response delivered,
response observed from another client (fixes F3), matching `complete` received, `turn.failed` /
system error for the owning turn, or disconnect.

### 4.3 Public API (on `ACPAxonConnection`)

```ts
type ElicitationDialect = "legacy" | "preview"; // session/elicitation vs elicitation/create

interface ElicitationEvent {
  /** Durable id: payload elicitationId when present, else "rl-seq-<sequence>". */
  elicitationId: string;
  idSource: "payload" | "sequence";
  dialect: ElicitationDialect;
  mode: "form" | "url" | "unknown";
  message: string;
  sessionId?: string;
  toolCallId?: string;   // preview session-scope extension
  requestId?: string;    // preview request-scope (elicitation outside a session)
  request: ElicitationRequestPayload;  // typed union (form | url | unknown-raw)
  sequence: number;
  /** True when delivered as an unresolved request after replay (reconnect/rehydrate). */
  replayed: boolean;
  /** Convenience wrapper over respondToElicitation(this.elicitationId, …). */
  respond(response: ElicitationResponse): Promise<ElicitationDeliveryResult>;
}

type ElicitationDeliveryResult =
  | { status: "delivered"; sequence: number }   // broker accepted the publish
  | { status: "unknown_elicitation" }           // no live pending entry: stale id, already
                                                //   answered (here or elsewhere), or completed
  | { status: "transport_error"; error: unknown }; // publish failed; entry stays pending → retryable

onElicitation(handler: (ev: ElicitationEvent) => void): () => void;
respondToElicitation(id: string, response: ElicitationResponse): Promise<ElicitationDeliveryResult>;
onElicitationComplete(handler: (ev: {
  elicitationId: string;
  dialect: ElicitationDialect;
  hadPending: boolean;   // whether this settled a live pending entry
}) => void): () => void;
/** Snapshot of unanswered elicitations — for UI rebuild and stale detection. */
pendingElicitations(): ElicitationEvent[];
```

Semantics worth pinning down now:

- **`respondToElicitation` is id-scoped and idempotent-safe**: answering an already-settled or
  never-seen id returns `unknown_elicitation` and publishes nothing. `transport_error` leaves the
  entry pending so the caller can retry with the same id. `delivered` means the broker accepted
  the publish (sequence returned) — it is a *transport* ack, not proof the agent acted on it;
  the docs will say exactly that.
- **`onElicitationComplete` settles only the matching id** (the reject-all bug becomes
  unrepresentable — the SDK does the matching, apps just get a notification). A complete for an
  unknown/settled id still fires the handler with `hadPending: false` (UIs may need to dismiss),
  and is never an error. The SDK does **not** auto-respond to the still-open request on complete;
  whether a client should answer `accept` after an out-of-band URL flow finishes is an upstream
  ambiguity (§9) and auto-responses are easy to add later but impossible to un-send.
- **Unhandled elicitations fail predictably.** If no `onElicitation` handler is registered when a
  request arrives (or dispatch to all handlers throws), the manager responds
  `{ action: { action: "cancel" } }` on the correct dialect method and reports via `onError` —
  the agent never hangs and never receives a method-not-found error dressed up as a response
  payload (today's default-client behavior). Configurable: `onUnhandledElicitation: "cancel" |
  "ignore"` (default `"cancel"`).
- **Unknown mode variants fail predictably.** A request whose `mode` is neither `form` nor `url`
  is still delivered (`mode: "unknown"`, raw payload preserved — the preview schema explicitly
  reserves custom modes) so capable apps can handle it; an app that doesn't respond falls into
  the unhandled path above. Malformed payloads (fails structural guards: no `message`, or
  unparseable) are rejected with a `cancel` response + `onError`; they never surface as events.

### 4.4 Dialect table (wire behavior)

| | legacy (ACP ≤ 0.18) | preview (ACP ≥ 0.19) |
|---|---|---|
| Request (agent→client, expects response) | `session/elicitation` | `elicitation/create` |
| Complete (agent→client notification) | `session/elicitation/complete` | `elicitation/complete` |
| Response published as | `event_type: "session/elicitation"`, payload = `ElicitationResponse` + `_meta` stamp | `event_type: "elicitation/create"`, payload = response + `_meta` stamp |
| Scope fields | top-level `sessionId` | `sessionId`+`toolCallId` XOR `requestId`, flattened into the mode variant |
| id present in | url mode (required), complete | url mode (required), complete |

Detection is per-inbound-event by exact method name; the response always echoes the request's
method (this is also what the broker's event-type-keyed routing requires). The table lives in one
exported const so the (eventual) upstream upgrade or a third dialect touches one file.

### 4.5 Replay and reconnect semantics

During replay (`sequence <= replayTargetSequence`) the manager consumes elicitation events
instead of the generic replay buffer:

1. `AGENT_EVENT` request → derive id, buffer keyed by id (two concurrent elicitations occupy two
   entries — fixes the overwrite/drop).
2. `USER_EVENT` response → pair by `_meta` stamp id; if unstamped (older SDK / foreign client),
   pair with the oldest unresolved request of the same dialect. Paired requests are resolved
   (not re-delivered).
3. `AGENT_EVENT` complete → resolves the buffered request with that `elicitationId`; the complete
   itself is **not** re-delivered post-replay (fixes F2). Completion handlers do not fire for
   history — Reflex rebuilds historical state from the timeline (which sees every replayed event
   via `onAxonEvent`), while manager handlers fire only for *actionable* items, matching the
   existing permission-replay philosophy.
4. `turn.failed` / system error during replay → resolves buffered requests belonging to that turn
   window (they are no longer actionable).
5. At the replay boundary (target sequence reached, first live event, or stream end — all three
   flush paths that exist today), unresolved entries are delivered to `onElicitation` handlers
   with `replayed: true`, in sequence order.

Because the id is derived from payload-or-sequence, the *same* elicitation gets the *same* id on
every reconnect, across processes — Reflex can upsert `needs_input` rows keyed by it with no
dedup heuristics.

Live mode additionally: `USER_EVENT` responses observed on elicitation methods settle the
matching local pending entry (`_meta` stamp, else oldest-of-dialect) so a response published by
any other client settles ours (fixes F3); a subsequent local `respondToElicitation` returns
`unknown_elicitation` instead of double-answering.

### 4.6 Capabilities

- `elicitationCapabilities({ form?: boolean; url?: boolean }): ClientCapabilities["elicitation"]`
  — helper to advertise form/url support in `initialize(...)` without hand-writing the shape.
- The connection retains the last successful handshake:
  `get initializeResult(): InitializeResponse | undefined` and convenience
  `get agentCapabilities(): AgentCapabilities | undefined`. Cleared on `disconnect()`.
  (Note: agent capabilities say nothing about elicitation — this is general-purpose exposure that
  the proposal asked for, useful for e.g. checking `promptCapabilities` from handler code.)

### 4.7 Default `Client` by composition

New `sdk/src/acp/default-client.ts`:

```ts
function createDefaultClient(overrides?: Partial<Client>, opts?: {
  requestPermission?: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}): Client;
```

- Defaults: current auto-approve permission logic, no-op `sessionUpdate`, `extMethod` throws
  method-not-found, `extNotification` ignores known lifecycle echoes — extracted from
  `connection.ts:563-597` and `combined-app`'s ignore-list, then merged with `overrides` by
  spread (single-method override, exactly what the `@todo` at `types.ts:79-82` asks for).
- `ACPAxonConnection.createClient()` is reimplemented on top of it; the existing
  `createClient` connection option keeps working unchanged (full replacement), and a *new*
  `clientOverrides` option accepts the partial form.
- Elicitation deliberately does **not** route through the client in managed mode; in
  `"passthrough"` mode the default client's `extMethod`/`extNotification` receive it as today.

## 5. Out-of-repo dependencies and asks

These do not block the SDK work but bound what it can guarantee:

1. **Broker (Axon) response routing.** Ask: echo a client-supplied correlation id (or read the
   `_meta` stamp) when routing `USER_EVENT` responses back to the agent's JSON-RPC request, and
   document current semantics for two in-flight same-method requests (FIFO? single slot? error?).
   Until then, end-to-end concurrent same-method elicitation carries a documented mis-attribution
   risk agent-side (§3.4).
2. **Agents.** Encourage Runloop-managed ACP agents to include `elicitationId` in form-mode
   payloads (legal as an extension field in both dialects). The SDK works without it; with it,
   ids are agent-meaningful (`idSource: "payload"`).

## 6. Implementation phases

Each phase is landable and releasable on its own; conventional commits (`feat(acp): …`) so
release-please picks them up.

**Phase 0 — pre-flight checks (no code)**
Answer §9 open questions 1–3 (broker routing semantics; Axon sequence stability guarantee in
writing; which target agents emit elicitation today and with what fields). Only Q2 (sequence
stability) can change the design — everything else adjusts docs/risk notes.

**Phase 1 — core manager + dialect support**
- `sdk/src/acp/elicitation.ts`: dialect table, id derivation, structural guards
  (`isElicitationRequestPayload` etc. following `shared/structural-guards.ts` conventions),
  `ElicitationManager` (pending map, dispatch, respond+publish+ack, complete-by-id,
  unhandled-cancel, turn-failure settlement).
- `sdk/src/acp/axon-stream.ts`: `elicitationSink` option; sink-aware routing in live path,
  replay path, and `NOTIFICATION_TYPES`; no behavior change when the sink is absent.
- `sdk/src/acp/connection.ts`: instantiate manager in `connect()`; expose `onElicitation`,
  `respondToElicitation`, `onElicitationComplete`, `pendingElicitations`; `elicitation:
  "managed" | "passthrough"` and `onUnhandledElicitation` options; retain `initializeResult`.
- Fixes: findings 1(elicitation-scope)/2/3/4/5/6, F1.

**Phase 2 — replay/reconnect + multi-client correctness**
- Manager replay mode per §4.5 (`_meta` stamping on publish, stamp/FIFO pairing, complete-
  resolves-request, boundary flush with `replayed: true`).
- Live `USER_EVENT` settlement (F3).
- Fixes: replay drop (finding 2), F2, F3.

**Phase 3 — capabilities + default client**
- `elicitationCapabilities()` helper; `agentCapabilities`/`initializeResult` getters.
- `sdk/src/acp/default-client.ts` + `clientOverrides` option; refactor `connection.ts`
  `createClient()` onto it; remove the `@todo`s in `types.ts`.
- Fixes: finding 7 and the composition `@todo`.

**Phase 4 — guards, exports, examples, docs**
- Broaden `isElicitationRequestEvent`/`isElicitationResponseEvent`/`isElicitationCompleteEvent`
  timeline guards to match both dialects (documented behavior change); export new types/guards
  from `sdk/src/acp/index.ts`.
- `examples/combined-app`: migrate `NodeACPClient` + routes/hooks to
  `onElicitation`/`respondToElicitation` — deleting the reject-all bug and the hand-rolled
  id/promise plumbing (it becomes the reference implementation).
- `examples/feature-examples`: rewrite `elicitation-acp.ts` on the new API; add
  `elicitation-concurrent-acp.ts` and `elicitation-preview-acp.ts` use cases with
  `expectedFailures` entries (xfail) for every agent that doesn't emit the feature yet.
- `sdk/AGENTS.md`, `sdk/README.md`: elicitation section (quick start, id semantics, delivery
  results, replay behavior, passthrough migration note).

## 7. Test plan

All simulated tests use the existing harness (`__test-utils__/mock-axon.ts`:
`createControllableStream`, `createMockAxon`, `makeAgentEvent`/`makeUserEvent`/`makeSystemEvent`).

**Unit — id derivation & guards** (`elicitation.test.ts`)
- payload id preferred; sequence fallback shape; stability of derived id for identical events;
  guards accept/reject each dialect × mode × malformed payloads.

**Manager — live protocol** (per dialect, parameterized)
- Two concurrent requests → two events, distinct ids; each respondable independently; responses
  published on the request's method with `_meta` stamp; both `delivered` with sequences.
- `respondToElicitation` on unknown id / already-answered id → `unknown_elicitation`, nothing
  published.
- `axon.publish` rejection → `transport_error`, entry still pending, retry succeeds.
- decline / cancel action payloads pass through verbatim.
- complete for one of two pending → only that one settles; handler gets `hadPending: true`;
  complete for unknown id → handler fires with `hadPending: false`, no error.
- No handler registered → auto-`cancel` response published + `onError`; `"ignore"` mode skips.
- Unknown mode variant → delivered with `mode: "unknown"`, raw payload intact.
- `turn.failed` → pending entries settle; later respond → `unknown_elicitation`.
- Preview scope fields (`toolCallId`, `requestId`) surfaced on the event.

**Replay / reconnect**
- History `[reqA, reqB, respA(stamped)]` → only B re-delivered, `replayed: true` (the
  overwrite/drop regression test).
- History `[reqA, reqB, respB(unstamped legacy)]` → FIFO fallback pairs the response with the
  *oldest* unresolved request (A), so B is re-delivered. Deterministic but imperfect (§9.6);
  asserted explicitly so any future change to the pairing rule is deliberate.
- History `[reqUrl, complete]` → nothing re-delivered; `pendingElicitations()` empty (F2
  regression).
- Replay ends via each flush path (target hit, first live event past target, stream close) —
  unresolved entries delivered exactly once, in sequence order.
- Reconnect: answer after replay-redelivery uses the same id; `delivered`.
- Mixed traffic: permission request + elicitation in same replay window — generic buffer still
  handles the permission, sink handles the elicitation (no cross-contamination).
- Live `USER_EVENT` response from another client (stamped and unstamped) settles local pending;
  local respond afterwards → `unknown_elicitation` (F3).

**Stream-level** (`axon-stream.test.ts` additions)
- With sink: both dialects' request/complete/response events routed to sink, absent from JSON-RPC
  stream in live and replay modes; F1 regression (preview request no longer becomes a
  notification).
- Without sink: byte-for-byte today's behavior (snapshot the existing tests keep passing).

**Connection-level** (`connection.test.ts` additions)
- Option plumbing (`managed`/`passthrough`, `onUnhandledElicitation`, `clientOverrides`);
  `initializeResult`/`agentCapabilities` retention and reset on disconnect; passthrough mode
  delivers to custom client `extMethod` exactly as today.

**Real agents** (`examples/feature-examples`, not CI-gating)
- Updated + new use cases run with `expectedFailures` (xfail) per agent until agents emit
  elicitation; xpass flips them to enforced.

## 8. Contract exposed to Reflex

| Reflex need | SDK primitive |
|---|---|
| Durable key for `needs_input` rows / UI / audit | `ElicitationEvent.elicitationId` (stable across reconnect & replay) |
| Detect stale answer → HTTP `409` | `respondToElicitation` → `unknown_elicitation` |
| Distinguish infra failure → retry | `transport_error` (entry stays answerable) |
| Confirm hand-off to broker | `delivered` + sequence |
| Rebuild pending state after reconnect | replay redelivery with `replayed: true` + `pendingElicitations()` |
| Dismiss UI when agent completes URL flow | `onElicitationComplete` (per-id, never reject-all) |
| Full historical timeline (event model) | unchanged `onTimelineEvent`/`onAxonEvent` — sees everything, including elicitation traffic |

## 9. Risks and open questions

1. **Broker routing semantics for concurrent same-method responses** (Phase 0 question; §5).
   Worst case is documented mis-attribution agent-side for overlapping same-method elicitations —
   client-side correctness is unaffected.
2. **Axon sequence stability guarantee.** The design's id fallback assumes sequences are
   immutable across replays (all current code — `getLastSequence`, `afterSequence` — already
   assumes this). Needs a one-line confirmation from the Axon team; if it ever doesn't hold, the
   fallback would need a payload-hash component (design isolated in one function).
3. **Preview dialect is still marked UNSTABLE upstream** (RFD moved to "preview" 2026-07-09;
   npm 1.2.1 still ships `unstable_` prefixes). Schema drift is plausible (e.g. PR #1574 removed
   the `-32042` URL-elicitation error in 1.2.0). Mitigation: dialect table + normalization are
   confined to `elicitation.ts`; unknown variants degrade to `mode: "unknown"` instead of
   breaking.
4. **Complete-notification response semantics.** Should the client answer the still-open request
   after `…/complete` (and with what action)? Upstream reference implementations are ambiguous.
   Shipping without auto-response is safe (agent-side libraries own their own request lifecycle);
   revisit against Zed's client behavior before stabilizing.
5. **Behavioral break for existing `extMethod`-based elicitation handlers** in managed mode.
   Mitigated by the `"passthrough"` option, a changelog entry, and the `combined-app` migration
   in the same release demonstrating the path.
6. **FIFO fallback pairing for unstamped replay responses** can mis-pair pathological histories
   (two overlapping elicitations answered out of order by an old client). Strictly better than
   today (which pairs by overwrite), self-heals as stamped responses become the norm, and is
   covered by an explicit test documenting the choice.

## 10. Non-goals / follow-ups

- **Client→agent method correlation** (one in-flight `prompt`/`initialize` per method) — needs
  broker id echo; unchanged and documented.
- **Upstream `@agentclientprotocol/sdk` 1.x upgrade** — separate track (constants renamed, zod
  v4, `Client` interface changes across *all* features). This design is forward-compatible with
  it by construction (§4.2).
- **Permission-request replay collisions** — same class of bug as finding 2 for
  `session/request_permission`; follow-up should generalize the manager's keyed-replay pattern
  (Claude's `control_request` handling, F4, is the precedent).
- **Claude module elicitation** — conversational (two-turn) by design; no protocol work needed.
- **Broker changes** — tracked as asks in §5, not deliverables here.

## 11. References

- Legacy dialect schema: `@agentclientprotocol/sdk@0.18.0` `schema/schema.json`
  (`ElicitationRequest` / `ElicitationResponse` / `ElicitationCompleteNotification`,
  `x-method: session/elicitation[/complete]`).
- Preview dialect schema: `@agentclientprotocol/sdk@1.2.1` `schema/schema.json`
  (`CreateElicitationRequest` / `CreateElicitationResponse` / `CompleteElicitationNotification`,
  `x-method: elicitation/create`, `elicitation/complete`); rename landed in npm 0.19.0 via
  agent-client-protocol PRs #792 and #966; `-32042` removed in #1574 (npm 1.2.0).
- Elicitation RFD ("Moved to Preview", 2026-07-09):
  https://agentclientprotocol.com/rfds/elicitation
- Current transport: `sdk/src/acp/axon-stream.ts`; connection: `sdk/src/acp/connection.ts`;
  reference client with reject-all bug: `examples/combined-app/src/server/acp-client.ts`;
  id-keyed replay precedent: `sdk/src/claude/transport.ts`.

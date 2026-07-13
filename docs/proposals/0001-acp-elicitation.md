# RFC 0001 — ACP elicitation: protocol upgrade, correlation redesign, and a first-class API

- **Status:** Draft (for discussion)
- **Scope:** `@runloop/remote-agents-sdk` (the `acp` module) — transport and protocol only
- **Author:** (proposed)
- **Related:** Reflex / Agentflow elicitation work (separate repo)

> This document is an independent evaluation of the proposed elicitation changes.
> It verifies the reported gaps against the current code, corrects two of them,
> adds findings the original list missed, and recommends a phased plan with a
> concrete API. No product code is changed in this PR — it is a proposal to
> align on before implementation.

---

## 1. TL;DR — recommendation

I agree with the direction, but the framing should change in three ways:

1. **The real problem is not "elicitation" — it is that the Axon transport
   correlates agent↔client messages by *method name*, having thrown away the
   JSON-RPC id.** Elicitation is simply the first feature where two requests of
   the same method can be in flight at once, so it is the first to break.
   Permission, `fs/*`, and `terminal/*` share the same transport and the same
   latent limitation. Fix the correlation layer once, generically; do not
   special-case elicitation.

2. **Do not try to "preserve the original JSON-RPC id."** Over this transport
   that id is a dead end (see §4.3). The durable identifier must live *in the
   payload* and be minted by the requester (the agent). ACP already defines one
   for this purpose: **`elicitationId`**. Standardise on it as the correlation,
   UI, retry, and audit key. This also makes IDs reconnect-stable *for free*,
   because Axon replays the persisted payload verbatim.

3. **Split ownership cleanly.** The SDK owns protocol/transport/correlation/
   capability negotiation/delivery-acknowledgement. Reflex owns events, DB
   (`needs_input`), the HTTP surface (`409`), and UI. This matches the original
   proposal's closing statement and should be stated as a hard boundary.

Everything else in the proposal is correct and worth doing; §6 sequences it.

---

## 2. How elicitation works today (verified code map)

| Concern | Location | Behaviour |
| --- | --- | --- |
| Pinned ACP SDK | `sdk/package.json:76` | `@agentclientprotocol/sdk@0.18.0` |
| Legacy method names | ACP SDK `CLIENT_METHODS` | `session/elicitation`, `session/elicitation/complete` |
| Delivery to app | ACP SDK `Client` interface | via `extMethod(method, params)` — **no typed elicitation handler** |
| Outbound request correlation | `sdk/src/acp/axon-stream.ts:58,520-527` | `pendingRequests` keyed by **method name**; a second in-flight request of the same method **throws** |
| Agent→client request ids | `sdk/src/acp/axon-stream.ts:64,429-432` | synthetic, process-local (`nextAgentRequestId = 900_000`) |
| Response routing | `sdk/src/acp/axon-stream.ts:418-426,543-554` | correlates the response publish by **`event_type`**, not id |
| Replay buffer | `sdk/src/acp/axon-stream.ts:142,311,326` | keyed by **`event_type`** — a second request of the same type overwrites the first |
| Completion notification | `sdk/src/acp/axon-stream.ts:17-22` | `session/elicitation/complete` treated as an un-routed notification |
| Timeline guards | `sdk/src/acp/timeline-event-guards.ts:173-216` | `isElicitationRequestEvent` / `…Response` / `…Complete` (observability only) |
| Default client | `sdk/src/acp/connection.ts:563-597` | implements only `requestPermission` + `sessionUpdate`; **no elicitation** |
| Composition escape hatch | `sdk/src/acp/types.ts:85-119` | all-or-nothing `createClient`; has a `@todo` for composition |
| Reference app | `examples/combined-app/src/server/acp-client.ts:122-152` | parks promises under a **local counter** id; completion **rejects every pending elicitation** |
| Conformance harness | `examples/feature-examples/src/use-cases/elicitation-acp.ts:20-28` | 4 ACP agents `expectedFailures`; advertises `{ elicitation: { form: {} } }` |

Key ACP 0.18 type facts (from the pinned schema) that the proposal glosses over:

- `ElicitationRequest` is a union on `mode`.
  **`form` mode carries no `elicitationId`**; `url` mode does.
- `ElicitationResponse` is `{ action }` — it also carries **no `elicitationId`**.
  For `form` mode, correlation is *only* the JSON-RPC request id.
- `ElicitationCompleteNotification` is `{ elicitationId }` and is documented as
  the completion signal for **URL-based** elicitation.

So today there are effectively two shapes with different correlation needs:

- **Form** = request/response. Correlation = JSON-RPC id → **dropped by Axon** →
  synthesised → matched by `event_type`. Two concurrent form elicitations are
  **indistinguishable on the wire**.
- **URL** = fire-and-forget request + async `complete`. Correlation =
  `elicitationId`, which the SDK currently ignores.

---

## 3. Independent assessment of each reported gap

Legend: ✅ confirmed · ✏️ confirmed but reframed · ➕ addition · ⚠️ correction.

### 3.1 Protocol version drift — ✅
`sdk/package.json:76` pins `0.18.0`, which exposes only the `session/elicitation`
family. Supporting both legacy and preview (`elicitation/create` /
`elicitation/complete`) behind negotiation is correct. **Dependency:** the exact
preview payload is not vendored on this environment; pin it from the upstream
ACP release (or a local type shim) before implementing — see §7.

### 3.2 "Correlation is method-based, not request-based" — ✅ and it is the root cause
Verified: `pendingRequests` is method-keyed (`axon-stream.ts:58`), the duplicate
guard throws per method (`:520-527`), and the replay buffer is `event_type`-keyed
(`:142`). This is not incidental — the transport correlates by method **because
the broker echoes back only `event_type`, never an id** (`axon-stream.ts:56-57`).
Treat this as a transport-correlation redesign, not an elicitation patch.

### 3.3 "IDs are not stable across reconnects" — ✏️ true, but the fix is simpler than implied
The synthetic `900_000+` ids (`axon-stream.ts:64`) are process-local and are
regenerated on every reconnect/replay, and `pendingClientRequests` is cleared on
stream end (`:288`). **However**, the fix is not to invent a new persistence
mechanism: an `elicitationId` that already lives *in the Axon payload* is
replay-stable automatically, because Axon persists and replays the event
verbatim. The correct move is to **stop minting synthetic ids and surface the
in-band `elicitationId`**. (This works for `url` today and for everything once
preview adds an id to `create`; it cannot work for legacy `form`, which has no
id — another reason to move to preview.)

### 3.4 "No first-class elicitation API" — ✅ (highest-value, lowest-risk item)
Confirmed: elicitation only reaches the app through `extMethod`, and the built-in
client (`connection.ts:563-597`) does not implement it, so every app must supply a
full `createClient`, hand-roll ids, and park promises — exactly what
`combined-app` does (`acp-client.ts:122-152`). This is the single most valuable
thing the SDK can own. Proposed surface in §5.2.

### 3.5 "Completion handling is too broad" — ✅ (and the reference app proves it)
`examples/combined-app/src/server/acp-client.ts:106-118` rejects **every** entry
in `pendingElicitations` on a single `complete`, ignoring the notification's
`elicitationId`. Correct today only because the app assumes ≤1 concurrent
elicitation. Completion must target one `elicitationId`.

### 3.6 "Missing delivery acknowledgement" — ✏️ partially SDK-ownable
`publish()` already returns a broker sequence/timestamp
(`connection.ts:461-463`), i.e. *transport delivered*. What the SDK **cannot**
know is whether the agent still wants the answer ("stale/missing") — that is the
agent's state, surfaced only via a `complete` notification or an error. So the
SDK should expose a **typed result** of `delivered | unknown_elicitation
(no local pending) | transport_error`, and Reflex maps that to `409 / needs_input`.
Anything richer belongs to the agent, not the SDK.

### 3.7 "Capability and version negotiation" — ✅ with a concrete gap
`initialize()` already forwards `clientCapabilities.elicitation.{form,url}`
(`scaffold.ts:117-125`), but the SDK **discards the agent's advertised
capabilities** from `InitializeResponse` — callers cannot tell whether the agent
supports elicitation, or which modes. Expose negotiated capabilities and fail
predictably on unknown preview variants (typed error, not a silent drop that
currently falls through to `axonEventToJsonRpc`'s "unknown → notification" path,
`axon-stream.ts:448-453`).

### 3.8 "Insufficient tests" — ✅
`elicitation-acp.ts:20-26` xfails opencode/codex-acp/qwen/gemini-cli. Keeping
*real-agent* tests as xfail is correct — those agents genuinely do not emit the
feature yet. The gap is **simulated** round-trips, which are cheap here:
`sdk/src/__test-utils__/mock-axon.ts` already drives inbound `AGENT_EVENT`s,
captures publishes, and supports sequence-based replay. See §8.

### ➕ Additional findings not in the original list

- **➕ Two concurrent `form` elicitations cannot be disambiguated on the wire in
  0.18** (no id in request or response). This is a *protocol* limitation, not
  just an SDK bug, and is the strongest argument for moving to preview where
  every `create` carries an id.
- **➕ The replay buffer can silently drop a request.** Because it is keyed by
  `event_type` (`axon-stream.ts:311,326`), a second unresolved `session/elicitation`
  (or a `session/request_permission` after another of the same type) overwrites
  the first, so on reconnect one pending request is lost, not replayed.
- **➕ The `combined-app` correlation id is a local counter** (`acp-client.ts`,
  `elicit-${++counter}`), not derived from the payload, so it is meaningless to
  the agent and unstable across a server restart — the same class of bug as the
  SDK's synthetic ids.

---

## 4. Design principles

### 4.1 One durable identifier: `elicitationId`
Use the in-payload `elicitationId` as the single key for correlation, UI state,
retries, stale detection, and audit. It is minted by the agent, echoed in the
`complete` notification, and replay-stable.

### 4.2 Correlate by instance id, not method
Replace `event_type`/method keys in `pendingClientRequests` and the replay buffer
with the request-instance id (the `elicitationId`, or a generic
`_meta.requestInstanceId` for non-elicitation request types once the envelope
supports it). This removes the "one in-flight per method" ceiling and the
overwrite-on-replay bug in one change.

### 4.3 Why not "preserve the JSON-RPC id"
The JSON-RPC id is client-minted, process-local, and **not on the wire** — the
broker echoes only `event_type` (`axon-stream.ts:56-57`). It cannot survive a
reconnect, cannot be understood by the agent, and cannot disambiguate two
same-method requests. Reviving it would push a fragile transport detail into
product code. The in-payload instance id is strictly better on every axis.

### 4.4 SDK/Reflex boundary (hard line)
- **SDK owns:** method-name negotiation (legacy ↔ preview), capability
  negotiation, `elicitationId` correlation, replay/reconnect correctness, the
  typed elicitation API, and delivery/transport acknowledgement.
- **Reflex owns:** persistence (`needs_input`), the HTTP contract (`409`), the
  timeline/event model, and the UI. The SDK must expose enough (a stable id + a
  typed ack) for Reflex to implement those without reaching into transport
  internals.

---

## 5. Proposed SDK surface

### 5.1 Method-set abstraction (version drift)
A tiny indirection so the rest of the SDK is agnostic to which wire names are in
play. Selected during `initialize` from negotiated capabilities / advertised
protocol variant, defaulting to legacy.

```ts
interface ElicitationDialect {
  create: "session/elicitation" | "elicitation/create";
  complete: "session/elicitation/complete" | "elicitation/complete";
}
```

Both dialects are registered in `NOTIFICATION_TYPES` and the client-method set so
inbound classification and timeline guards keep working across the transition.
Unknown preview variants → a typed `UnsupportedElicitationVariantError` rather
than the current silent "unknown → notification" fallthrough.

### 5.2 First-class elicitation API on `ACPAxonConnection`
Additive and non-breaking; the built-in client wires these when the caller does
*not* supply a full `createClient`.

```ts
interface ElicitationRequestEvent {
  elicitationId: string;          // durable, from payload (or SDK-issued for legacy form)
  sessionId: string;
  request: ElicitationRequest;    // form | url, typed
}

type ElicitationDeliveryResult =
  | { status: "delivered"; sequence: number }
  | { status: "unknown_elicitation" }   // no local pending — likely already completed/stale
  | { status: "transport_error"; error: unknown };

class ACPAxonConnection {
  /** Fires when the agent requests input. Returns an unsubscribe fn. */
  onElicitation(handler: (e: ElicitationRequestEvent) => void): () => void;

  /** Fires when the agent completes/cancels a specific elicitation (url mode). */
  onElicitationComplete(handler: (elicitationId: string) => void): () => void;

  /** Answers one elicitation by its durable id. Returns a typed delivery ack. */
  respondToElicitation(
    elicitationId: string,
    response: ElicitationResponse,      // accept | decline | cancel
  ): Promise<ElicitationDeliveryResult>;

  /** Agent capabilities negotiated at initialize (undefined until initialized). */
  get agentCapabilities(): AgentCapabilities | undefined;
}
```

Notes:
- `respondToElicitation` looks up the parked request by `elicitationId`; if none
  exists (already completed, or replayed-stale) it returns `unknown_elicitation`
  **instead of throwing**, so Reflex can return `409` and keep `needs_input`.
- For legacy `form` (no payload id), the SDK issues a local id and keeps the
  synthetic JSON-RPC mapping internally, but still presents a stable id to the
  caller for the lifetime of the connection. Reconnect-stability for `form` is
  explicitly *not* guaranteed until preview lands (documented limitation).

### 5.3 Reusable default `Client` (composition)
Resolves the `@todo` at `sdk/src/acp/types.ts:79-84,113-118`. Provide
`createDefaultClient(overrides?: Partial<Client>)` that supplies
`requestPermission` + `sessionUpdate` + elicitation routing, and lets callers
override individual methods without reimplementing the whole interface. The
elicitation route parks the promise keyed by `elicitationId` and resolves it from
`respondToElicitation`; `complete` resolves/cancels exactly that id.

### 5.4 Capability helpers
`advertiseElicitation({ form?: boolean; url?: boolean })` to build the
`clientCapabilities.elicitation` block, and `agentCapabilities` (5.2) to read
back what the agent supports so callers never send an unsupported mode.

---

## 6. Phased plan

| Phase | Content | Risk | Depends on |
| --- | --- | --- | --- |
| **1** | First-class API (§5.2) + reusable default client (§5.3) + dialect map (§5.1), routing legacy `session/elicitation`. Completion targets one id. | Low, additive | none |
| **2** | Correlate `pendingClientRequests` + replay buffer by instance id (§4.2); fix replay drop + reconnect stability. | Medium (touches core transport) | Phase 1 |
| **3** | Capability negotiation read-back (§5.4) + typed delivery ack (§3.6) + predictable failure for unknown variants. | Low–medium | Phase 1 |
| **4** | Preview method support (`elicitation/create` / `elicitation/complete`) behind negotiation; bump/shim ACP SDK. | Medium | upstream preview schema |
| **5** | Simulated protocol tests (§8). | Low | Phases 1–4 |

Phase 1 alone removes the need for every app to hand-roll `extMethod` + id
allocation, and makes the `combined-app` completion bug unrepresentable.

---

## 7. Open questions / dependencies

1. **Preview schema.** The exact `elicitation/create` / `elicitation/complete`
   payloads (does every `create` carry an `elicitationId`? is `form` unified with
   `url`?) are not vendored here. Pin them from the upstream ACP release before
   Phase 4; until then, Phases 1–3 stand on 0.18.
2. **Agent-side echo.** Reconnect-stable correlation for `form` requires the
   agent to include an id in the request. This is an agent/broker change outside
   the SDK; track it with the ACP-agent owners.
3. **Envelope for non-elicitation requests.** Generalising instance-id
   correlation to `fs/*` and `terminal/*` needs a `_meta.requestInstanceId`
   convention in the Axon envelope. Elicitation can ship first using
   `elicitationId`; the generic version is a follow-up.

## 8. Test plan (simulated, using `sdk/src/__test-utils__/mock-axon.ts`)

- **Round-trip:** inbound `session/elicitation` (form) → assert `onElicitation`
  fires with the right id → `respondToElicitation` → assert a `USER_EVENT`
  publish with the `accept` action.
- **Concurrency:** two elicitations with distinct ids in flight → answer the
  second → assert only the second is published/resolved, the first stays pending.
- **Replay/reconnect:** replay a history containing an unresolved elicitation past
  `replayTargetSequence` → assert exactly one pending request survives with a
  stable id; a resolved one does not re-fire.
- **Decline/cancel:** assert `decline` and `cancel` actions serialise correctly.
- **Targeted completion:** `complete{elicitationId:A}` with A and B pending →
  assert only A is completed; B remains.
- **Stale response:** `respondToElicitation` for an id with no local pending →
  assert `unknown_elicitation`, no publish.
- **Real agents stay `xfail`** in `elicitation-acp.ts` until they emit the feature.

## 9. Non-goals

Reflex event schema, DB state (`needs_input`), the HTTP `409` contract, and UI.
The SDK exposes a stable id and a typed ack; Reflex builds those on top.

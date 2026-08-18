import type {
  Agent,
  Client,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import type { ResubscribeTuning } from "../shared/stream-resubscribe.js";
import type {
  BaseConnectionOptions,
  BaseTimelineEvent,
  LogFn,
  SystemTimelineEvent,
  UnknownTimelineEvent,
} from "../shared/types.js";

/**
 * Configuration for creating a low-level Axon stream via {@link axonStream}.
 * @category Configuration
 */
export interface AxonStreamOptions {
  /** Axon channel to connect to (from `@runloop/api-client`). */
  axon: Axon;
  /** AbortSignal to cancel the SSE connection and stop publishing. */
  signal?: AbortSignal;
  /** Called for every Axon event before JSON-RPC translation. */
  onAxonEvent?: (event: AxonEventView) => void;
  /**
   * Called when a non-critical error occurs (e.g. unparseable SSE event).
   * Defaults to `console.error`.
   */
  onError?: (error: unknown) => void;
  /** Diagnostic log callback. When provided, the stream emits verbose logs. */
  log?: LogFn;
  /**
   * Axon sequence number to resume from. When set, the initial SSE
   * subscription starts **after** this sequence — earlier events are skipped.
   * Omit to replay the full event history.
   */
  afterSequence?: number;

  /**
   * When set, events with `sequence <= replayTargetSequence` are considered
   * historical replay. During replay, `onAxonEvent` still fires (so timeline
   * listeners work) but agent-to-client requests are buffered instead of
   * enqueued. After replay ends, only unresolved requests are enqueued.
   */
  replayTargetSequence?: number;

  /**
   * The `source` string attached to every published Axon event, or a
   * resolver invoked at publish time to obtain it. Use the resolver form to
   * change the `source` between messages without recreating the stream
   * (e.g. `() => this.currentSource`). When omitted, or when the resolver
   * returns `undefined`, the default is used.
   *
   * @defaultValue `"acp-sdk-client"`
   */
  source?: string | (() => string | undefined);

  /**
   * Backoff tuning overrides for the SSE resubscribe engine.
   * @internal
   */
  retry?: ResubscribeTuning;
}

/**
 * Factory function that creates a {@link Client} implementation for the
 * underlying `ClientSideConnection`.
 *
 * Receives the `Agent` proxy (so the client can call back into the agent
 * if needed) and must return a `Client` that handles agent-to-client
 * requests such as `requestPermission`, `sessionUpdate`, file I/O,
 * terminal management, and elicitation.
 *
 * @todo Consider a composition-based approach (e.g. accepting partial
 * overrides that merge with defaults) so callers don't have to
 * reimplement the entire `Client` interface.
 *
 * @category Configuration
 */
export type CreateClientFn = (agent: Agent) => Client;

/**
 * Options for creating an {@link ACPAxonConnection}.
 * @category Configuration
 */
export interface ACPAxonConnectionOptions extends BaseConnectionOptions {
  /**
   * Custom handler for agent permission requests. Receives the permission
   * options and must return the selected outcome.
   *
   * Defaults to auto-approving with preference:
   * `allow_always` > `allow_once` > first option.
   *
   * Ignored when {@link createClient} is provided (the custom client is
   * responsible for handling permissions).
   */
  requestPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  /**
   * Provide a full custom {@link Client} implementation for the underlying
   * `ClientSideConnection`. Use this when you need to handle agent-to-client
   * callbacks beyond permissions and session updates — for example file I/O,
   * terminal management, or elicitation.
   *
   * When set, the built-in `requestPermission` / `onSessionUpdate` wiring is
   * bypassed — the returned `Client` is used as-is.
   *
   * **Design note:** A composition-based approach (partial overrides merged
   * with defaults) would be more ergonomic but the `Client` interface from
   * `@agentclientprotocol/sdk` doesn't lend itself to easy merging. This
   * all-or-nothing option keeps the boundary clear. See
   * {@link CreateClientFn} for the `@todo` on future composition support.
   */
  createClient?: CreateClientFn;
}

/**
 * Callback invoked on each `session/update` notification from the agent.
 *
 * @param sessionId - The session that emitted the update, or `null` if
 *   the notification did not include a session ID.
 * @param update    - The session update payload (message chunk, tool call, usage, etc.).
 *
 * @category Configuration
 */
export type SessionUpdateListener = (sessionId: string | null, update: SessionUpdate) => void;

// ---------------------------------------------------------------------------
// Timeline events
// ---------------------------------------------------------------------------

/**
 * A `session/update` timeline event. `data` is the parsed `SessionNotification`
 * containing `{ sessionId, update }` where `update` is the `SessionUpdate`.
 * @category Timeline
 */
export interface ACPSessionUpdateTimelineEvent extends BaseTimelineEvent {
  kind: "acp_protocol";
  eventType: "session/update";
  data: SessionNotification;
}

/**
 * An `initialize` timeline event.
 * @category Timeline
 */
export interface ACPInitializeTimelineEvent extends BaseTimelineEvent {
  kind: "acp_protocol";
  eventType: "initialize";
  data: InitializeRequest | InitializeResponse;
}

/**
 * A `session/prompt` timeline event.
 * @category Timeline
 */
export interface ACPPromptTimelineEvent extends BaseTimelineEvent {
  kind: "acp_protocol";
  eventType: "session/prompt";
  data: PromptRequest | PromptResponse;
}

/**
 * A `session/new` timeline event.
 * @category Timeline
 */
export interface ACPNewSessionTimelineEvent extends BaseTimelineEvent {
  kind: "acp_protocol";
  eventType: "session/new";
  data: NewSessionRequest | NewSessionResponse;
}

/**
 * A recognized ACP protocol event whose `eventType` is not one of the
 * specifically typed variants above.
 *
 * Use `axonEvent.origin` to determine direction:
 * - `USER_EVENT` = outbound (client sent this)
 * - `AGENT_EVENT` = inbound (agent sent this)
 *
 * @category Timeline
 */
export interface ACPOtherProtocolTimelineEvent extends BaseTimelineEvent {
  kind: "acp_protocol";
  eventType: string & {};
  data: unknown;
}

/**
 * Discriminated union of all ACP protocol timeline event variants.
 * Switch on `eventType` to narrow the `data` type.
 * @category Timeline
 */
export type ACPProtocolTimelineEvent =
  | ACPSessionUpdateTimelineEvent
  | ACPInitializeTimelineEvent
  | ACPPromptTimelineEvent
  | ACPNewSessionTimelineEvent
  | ACPOtherProtocolTimelineEvent;

/**
 * Union of all timeline event types emitted by the ACP connection.
 * @category Timeline
 */
export type ACPTimelineEvent =
  | ACPProtocolTimelineEvent
  | SystemTimelineEvent
  | UnknownTimelineEvent;

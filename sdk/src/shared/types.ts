/**
 * Shared types used by both the ACP and Claude connection modules.
 */

/** @category Configuration */
export type { AxonEventView } from "@runloop/api-client/resources/axons";

import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { ResubscribeTuning } from "./stream-resubscribe.js";

// ---------------------------------------------------------------------------
// Timeline events — unified event stream types
// ---------------------------------------------------------------------------

/**
 * Broker-emitted system event recognized by the SDK.
 * These bracket agent turns on the Axon channel.
 *
 * @category Timeline
 */
/**
 * Devbox lifecycle state derived from the second segment of the
 * `devbox.*` system event type (e.g. `devbox.running` → `"running"`).
 *
 * @category Timeline
 */
export type DevboxLifecycleKind = "running" | "suspended" | "shutdown" | "failed";

/**
 * Devbox lifecycle event. Discriminate on `kind` to narrow:
 * - `running`   — devbox is running
 * - `suspended` — devbox is suspended / suspending
 * - `shutdown`  — devbox reached shutdown state
 * - `failed`    — devbox failed / not found / deadline exceeded (`reason` is set)
 *
 * @category Timeline
 */
export type DevboxLifecycleEvent =
  | { type: "devbox.lifecycle"; kind: "running"; devboxId: string }
  | { type: "devbox.lifecycle"; kind: "suspended"; devboxId: string }
  | { type: "devbox.lifecycle"; kind: "shutdown"; devboxId: string }
  | { type: "devbox.lifecycle"; kind: "failed"; devboxId: string; reason?: string };

/**
 * Agent error event emitted when the agent fails (e.g. launch failure).
 *
 * @category Timeline
 */
export interface AgentErrorEvent {
  type: "agent.error";
  devboxId: string;
  errorType?: string;
  message?: string;
}

/**
 * Agent log event emitted when the agent produces log output (e.g. stderr).
 *
 * @category Timeline
 */
export type AgentLogType = "stderr";

export interface AgentLogEvent {
  type: "agent.log";
  logType: AgentLogType;
  message: string;
}

export type SystemEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string; stopReason?: string }
  | { type: "turn.failed"; turnId: string; error: string; stopReason?: string }
  | { type: "broker.error"; message: string }
  | DevboxLifecycleEvent
  | AgentErrorEvent
  | AgentLogEvent;

/**
 * Common shape shared by every timeline event variant.
 *
 * Protocol-specific event interfaces (ACP, Claude) extend this with
 * narrower `kind` and `data` types plus optional extra fields like
 * `eventType`.
 *
 * @category Timeline
 */
export interface BaseTimelineEvent {
  kind: string;
  data: unknown;
  axonEvent: AxonEventView;
}

/**
 * A timeline event carrying a recognized broker system event.
 * @category Timeline
 */
export interface SystemTimelineEvent extends BaseTimelineEvent {
  kind: "system";
  data: SystemEvent;
}

/**
 * A timeline event the SDK did not recognize. The `data` field contains the
 * eagerly-parsed payload (or `null` if the payload was missing / unparseable).
 * Inspect `axonEvent.origin` and `axonEvent.event_type` to decide how to
 * handle it, or use {@link createCustomEventGuard} to build a typed guard.
 * @category Timeline
 */
export interface UnknownTimelineEvent extends BaseTimelineEvent {
  kind: "unknown";
  data: unknown;
}

/**
 * A narrowed unknown timeline event whose payload has been parsed as `T`.
 * Produced by type guards created with {@link createCustomEventGuard}.
 * @category Timeline
 */
export interface CustomTimelineEvent<T> extends BaseTimelineEvent {
  kind: "unknown";
  data: T;
}

/**
 * Listener callback for timeline events.
 * @category Timeline
 */
export type TimelineEventListener<T> = (event: T) => void;

/**
 * Diagnostic log callback used throughout the SDK for verbose logging.
 *
 * @param tag  - Short label identifying the call site (e.g. `"connect"`, `"readLoop"`).
 * @param args - Arbitrary data to log alongside the tag.
 *
 * @category Configuration
 */
export type LogFn = (tag: string, ...args: unknown[]) => void;

/**
 * Callback invoked for every Axon event (before protocol-specific processing).
 *
 * @param event - The raw {@link AxonEventView} from the Axon SSE feed,
 *   including events from all origins (agent, user, system).
 *
 * @category Configuration
 */
export type AxonEventListener = (event: AxonEventView) => void;

/**
 * Common connection options shared by both ACP and Claude connections.
 *
 * @category Configuration
 */
export interface BaseConnectionOptions {
  /**
   * Backoff tuning overrides for the SSE resubscribe engine.
   * @internal
   */
  retry?: ResubscribeTuning;

  /**
   * When `true`, emit timestamped diagnostic logs to `stderr` for every
   * transport read/write and lifecycle event.
   * Useful during development; too noisy for production.
   *
   * @defaultValue `false`
   */
  verbose?: boolean;

  /**
   * Called when a non-critical error occurs (e.g. unparseable event,
   * listener exception). Defaults to `console.error`.
   */
  onError?: (error: unknown) => void;

  /**
   * Async teardown callback invoked by `disconnect()` (e.g. devbox shutdown).
   */
  onDisconnect?: () => void | Promise<void>;

  /**
   * Axon sequence number to resume from. When set, the initial SSE
   * subscription uses `{ after_sequence }` so only events **after** this
   * sequence are delivered — earlier events are skipped.
   *
   * Omit (or pass `undefined`) to replay the full event history from the
   * beginning of the Axon channel.
   *
   * Typical usage: persist `AxonEventView.sequence` from a previous
   * session and pass it here to avoid re-processing events you have
   * already seen.
   *
   * Mutually exclusive with {@link replay}.
   */
  afterSequence?: number;

  /**
   * When `true`, the connection queries the axon for the current head
   * sequence and replays all events up to that point without invoking
   * handlers. Unresolved permission/control requests are dispatched
   * to handlers after replay completes. Timeline events are emitted
   * for all replayed events regardless.
   *
   * Set to `false` to replay the full history with handlers firing for
   * every event (legacy behavior).
   *
   * Mutually exclusive with {@link afterSequence}.
   *
   * @defaultValue `true`
   */
  replay?: boolean;

  /**
   * The `source` string attached to every event this client publishes to
   * the Axon API. Use it to identify which client produced a user prompt
   * (e.g. distinguishing multiple integrations writing to the same channel).
   *
   * Defaults to the built-in client identifier (`"claude-sdk-client"` or
   * `"acp-sdk-client"` depending on the connection type).
   */
  source?: string;
}

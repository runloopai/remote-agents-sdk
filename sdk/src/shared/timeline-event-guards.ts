/**
 * Shared type guards for narrowing {@link BaseTimelineEvent} to system and unknown variants.
 *
 * These guards work with any timeline event type (ACP or Claude) since they
 * only inspect the `kind` and `data.type` fields present on {@link BaseTimelineEvent}.
 *
 * @module
 */

import { SYSTEM_EVENT_TYPES } from "./timeline.js";
import type {
  AgentErrorEvent,
  AgentLogEvent,
  BaseTimelineEvent,
  CustomTimelineEvent,
  DevboxLifecycleKind,
  SystemTimelineEvent,
  UnknownTimelineEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Narrowed system event types
// ---------------------------------------------------------------------------

/**
 * Narrowed type for a `turn.started` system event.
 * @category Timeline
 */
export type TurnStartedTimelineEvent = SystemTimelineEvent & {
  data: { type: "turn.started"; turnId: string };
};

/**
 * Narrowed type for a `turn.completed` system event.
 * @category Timeline
 */
export type TurnCompletedTimelineEvent = SystemTimelineEvent & {
  data: { type: "turn.completed"; turnId: string; stopReason?: string };
};

/**
 * Narrowed type for a `turn.failed` system event.
 * @category Timeline
 */
export type TurnFailedTimelineEvent = SystemTimelineEvent & {
  data: { type: "turn.failed"; turnId: string; error: string; stopReason?: string };
};

/**
 * Narrowed type for a `broker.error` system event.
 * @category Timeline
 */
export type BrokerErrorTimelineEvent = SystemTimelineEvent & {
  data: { type: "broker.error"; message: string };
};

// ---------------------------------------------------------------------------
// System event guards
// ---------------------------------------------------------------------------

/**
 * Type guard for system timeline events (turn lifecycle, broker errors).
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link SystemTimelineEvent}.
 * @category Timeline
 */
export function isSystemTimelineEvent(event: BaseTimelineEvent): event is SystemTimelineEvent {
  return event.kind === "system";
}

/**
 * Type guard for `turn.started` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a turn-started system event.
 * @category Timeline
 */
export function isTurnStartedEvent(event: BaseTimelineEvent): event is TurnStartedTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.TURN_STARTED
  );
}

/**
 * Type guard for `turn.completed` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a turn-completed system event.
 * @category Timeline
 */
export function isTurnCompletedEvent(
  event: BaseTimelineEvent,
): event is TurnCompletedTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.TURN_COMPLETED
  );
}

/**
 * Type guard for `turn.failed` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a turn-failed system event.
 * @category Timeline
 */
export function isTurnFailedEvent(event: BaseTimelineEvent): event is TurnFailedTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.TURN_FAILED
  );
}

/**
 * Type guard for `broker.error` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a broker error system event.
 * @category Timeline
 */
export function isBrokerErrorEvent(event: BaseTimelineEvent): event is BrokerErrorTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.BROKER_ERROR
  );
}

// ---------------------------------------------------------------------------
// Devbox lifecycle guards
// ---------------------------------------------------------------------------

/**
 * Narrowed type for a devbox lifecycle system event.
 * @category Timeline
 */
export type DevboxLifecycleTimelineEvent = SystemTimelineEvent & {
  data: { type: "devbox.lifecycle"; kind: DevboxLifecycleKind; devboxId: string };
};

/**
 * Type guard for devbox lifecycle system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link DevboxLifecycleTimelineEvent}.
 * @category Timeline
 */
export function isDevboxLifecycleEvent(
  event: BaseTimelineEvent,
): event is DevboxLifecycleTimelineEvent {
  return event.kind === "system" && (event.data as { type?: string }).type === "devbox.lifecycle";
}

// ---------------------------------------------------------------------------
// Agent error guard
// ---------------------------------------------------------------------------

/**
 * Narrowed type for an `agent.error` system event.
 * @category Timeline
 */
export type AgentErrorTimelineEvent = SystemTimelineEvent & {
  data: AgentErrorEvent;
};

/**
 * Type guard for `agent.error` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link AgentErrorTimelineEvent}.
 * @category Timeline
 */
export function isAgentErrorEvent(event: BaseTimelineEvent): event is AgentErrorTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.AGENT_ERROR
  );
}

// ---------------------------------------------------------------------------
// Agent log guard
// ---------------------------------------------------------------------------

/**
 * Narrowed type for an `agent.log` system event.
 * @category Timeline
 */
export type AgentLogTimelineEvent = SystemTimelineEvent & {
  data: AgentLogEvent;
};

/**
 * Type guard for `agent.log` system events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link AgentLogTimelineEvent}.
 * @category Timeline
 */
export function isAgentLogEvent(event: BaseTimelineEvent): event is AgentLogTimelineEvent {
  return (
    event.kind === "system" &&
    (event.data as { type?: string }).type === SYSTEM_EVENT_TYPES.AGENT_LOG
  );
}

// ---------------------------------------------------------------------------
// Unknown event guard
// ---------------------------------------------------------------------------

/**
 * Type guard for unrecognized timeline events.
 *
 * These are events the SDK did not classify as system or protocol events.
 * Inspect `event.axonEvent` for raw event details.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link UnknownTimelineEvent}.
 * @category Timeline
 */
export function isUnknownTimelineEvent(event: BaseTimelineEvent): event is UnknownTimelineEvent {
  return event.kind === "unknown";
}

// ---------------------------------------------------------------------------
// Custom event guard factory
// ---------------------------------------------------------------------------

/**
 * Creates a type guard that matches unknown timeline events by `event_type`
 * and narrows the `data` field to `T`.
 *
 * Unknown events are eagerly parsed by the classifier, so the `data` field
 * already contains the parsed payload (or `null` when unparseable). The
 * returned guard checks both `kind === "unknown"` and the `event_type` string,
 * giving you a fully typed {@link CustomTimelineEvent\<T\>} without manual
 * parsing.
 *
 * @example
 * ```typescript
 * interface AgentStartedPayload { agentType: string; model?: string; }
 *
 * const isAgentStarted = createCustomEventGuard<AgentStartedPayload>("agent_started");
 *
 * conn.onTimelineEvent((event) => {
 *   if (isAgentStarted(event)) {
 *     console.log(event.data.agentType); // fully typed
 *   }
 * });
 * ```
 *
 * @typeParam T - The expected shape of the parsed event payload.
 * @param eventType - The `axonEvent.event_type` string to match.
 * @returns A type guard function.
 * @category Timeline
 */
export function createCustomEventGuard<T>(
  eventType: string,
): (event: BaseTimelineEvent) => event is CustomTimelineEvent<T> {
  return (event: BaseTimelineEvent): event is CustomTimelineEvent<T> => {
    return event.kind === "unknown" && event.axonEvent.event_type === eventType;
  };
}

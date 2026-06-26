/**
 * Utility helpers for working with timeline events.
 */

import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { SYSTEM_EVENT_ORIGIN } from "./errors/system-error.js";
import type {
  DevboxLifecycleKind,
  SystemEvent,
  SystemTimelineEvent,
  UnknownTimelineEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// System event type constants
// ---------------------------------------------------------------------------

/**
 * Known system event type strings emitted by the Axon broker.
 * Use these instead of raw string literals for type-safe matching.
 *
 * @category Timeline
 */
export const SYSTEM_EVENT_TYPES = {
  TURN_STARTED: "turn.started",
  TURN_COMPLETED: "turn.completed",
  TURN_FAILED: "turn.failed",
  BROKER_ERROR: "broker.error",
  DEVBOX_RUNNING: "devbox.running",
  DEVBOX_SUSPENDED: "devbox.suspended",
  DEVBOX_SHUTDOWN: "devbox.shutdown",
  DEVBOX_FAILED: "devbox.failed",
  AGENT_ERROR: "agent.error",
  AGENT_LOG: "agent.log",
} as const;

/** Set of all recognized system event type strings for O(1) lookup. */
const SYSTEM_EVENT_TYPE_SET: Set<string> = new Set(Object.values(SYSTEM_EVENT_TYPES));

/** Returns `true` if `eventType` is a recognized broker system event type. */
export function isSystemEventType(eventType: string): boolean {
  return SYSTEM_EVENT_TYPE_SET.has(eventType);
}

/**
 * Checks whether a raw Axon event is a `turn.failed` SYSTEM_EVENT.
 *
 * Counterpart to {@link isSystemError} for the per-turn failure case.
 * Use in the Axon-stream layer (before timeline classification) to detect
 * turn-level failures and reject in-flight JSON-RPC requests without
 * tearing the SSE stream down.
 *
 * @param event - The raw Axon event to check.
 * @returns `true` if the event is a `turn.failed` system event.
 *
 * @category Utilities
 * @internal
 */
export function isTurnFailedAxonEvent(event: AxonEventView): boolean {
  return (
    event.origin === SYSTEM_EVENT_ORIGIN && event.event_type === SYSTEM_EVENT_TYPES.TURN_FAILED
  );
}

// ---------------------------------------------------------------------------
// System event payload shapes
// ---------------------------------------------------------------------------

interface TurnStartedPayload {
  turn_id?: string;
}

interface TurnCompletedPayload {
  turn_id?: string;
  stop_reason?: string;
}

interface TurnFailedPayload {
  turn_id?: string;
  error?: string;
  stop_reason?: string;
}

interface BrokerErrorPayload {
  message?: string;
}

interface DevboxLifecyclePayload {
  devbox_id?: string;
  reason?: string;
}

interface AgentErrorPayload {
  devbox_id?: string;
  type?: string;
  message?: string;
}

interface AgentLogPayload {
  log_type?: string;
  message?: string;
}

const DEVBOX_PREFIX = "devbox.";

/** Set of recognized devbox lifecycle kinds for validation. */
const DEVBOX_LIFECYCLE_KINDS: Set<string> = new Set<string>([
  "running",
  "suspended",
  "shutdown",
  "failed",
]);

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Attempts to parse the JSON payload from an Axon event.
 * Returns `null` if the payload is missing or not valid JSON.
 * Invalid JSON string payloads are logged with {@link console.warn} (includes
 * `event_type` and `sequence` from the Axon event for correlation).
 *
 * @category Timeline
 */
export function tryParseTimelinePayload<T = unknown>(event: {
  axonEvent: AxonEventView;
}): T | null {
  const raw = event.axonEvent.payload;
  if (typeof raw !== "string") return (raw as T) ?? null;
  const { axonEvent } = event;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tryParseTimelinePayload] Failed to parse JSON payload for event_type="${axonEvent.event_type}" sequence=${String(axonEvent.sequence)}: ${reason}`,
    );
    return null;
  }
}

/**
 * Attempts to parse a `SYSTEM_EVENT` Axon event into a typed {@link SystemEvent}.
 * Returns `null` if the event is not a recognized system event or the payload
 * cannot be parsed.
 *
 * @category Timeline
 */
export function tryParseSystemEvent(ev: AxonEventView): SystemEvent | null {
  if (
    ev.event_type === SYSTEM_EVENT_TYPES.TURN_STARTED ||
    ev.event_type === SYSTEM_EVENT_TYPES.TURN_COMPLETED
  ) {
    const parsed = tryParseTimelinePayload<TurnStartedPayload | TurnCompletedPayload>({
      axonEvent: ev,
    });
    if (!parsed) return null;
    const turnId = (parsed as TurnStartedPayload).turn_id ?? "";
    if (ev.event_type === SYSTEM_EVENT_TYPES.TURN_STARTED) {
      return { type: "turn.started", turnId };
    }
    return {
      type: "turn.completed",
      turnId,
      stopReason: (parsed as TurnCompletedPayload).stop_reason,
    };
  }

  if (ev.event_type === SYSTEM_EVENT_TYPES.TURN_FAILED) {
    const parsed = tryParseTimelinePayload<TurnFailedPayload>({ axonEvent: ev });
    // Mirror the broker.error fallback: when the payload is unparseable or
    // missing the `error` field, surface the raw payload string.
    const error =
      parsed != null ? (parsed.error ?? String(ev.payload ?? "")) : String(ev.payload ?? "");
    return {
      type: "turn.failed",
      turnId: parsed?.turn_id ?? "",
      error,
      stopReason: parsed?.stop_reason,
    };
  }

  if (ev.event_type === SYSTEM_EVENT_TYPES.BROKER_ERROR) {
    const parsed = tryParseTimelinePayload<BrokerErrorPayload>({ axonEvent: ev });
    const message =
      parsed != null ? (parsed.message ?? String(ev.payload)) : String(ev.payload ?? "");
    return { type: "broker.error", message };
  }

  if (ev.event_type.startsWith(DEVBOX_PREFIX)) {
    const suffix = ev.event_type.slice(DEVBOX_PREFIX.length);
    if (DEVBOX_LIFECYCLE_KINDS.has(suffix)) {
      const kind = suffix as DevboxLifecycleKind;
      const parsed = tryParseTimelinePayload<DevboxLifecyclePayload>({ axonEvent: ev });
      const devboxId = parsed?.devbox_id;
      if (!devboxId) return null;
      if (kind === "failed") {
        return { type: "devbox.lifecycle", kind: "failed", devboxId, reason: parsed?.reason };
      }
      return { type: "devbox.lifecycle", kind, devboxId };
    }
  }

  if (ev.event_type === SYSTEM_EVENT_TYPES.AGENT_ERROR) {
    const parsed = tryParseTimelinePayload<AgentErrorPayload>({ axonEvent: ev });
    const devboxId = parsed?.devbox_id;
    if (!devboxId) return null;
    return {
      type: "agent.error",
      devboxId,
      errorType: parsed?.type,
      message: parsed?.message,
    };
  }

  if (ev.event_type === SYSTEM_EVENT_TYPES.AGENT_LOG) {
    const parsed = tryParseTimelinePayload<AgentLogPayload>({ axonEvent: ev });
    if (!parsed) return null;
    return {
      type: "agent.log",
      logType: (parsed.log_type as "stderr") ?? "stderr",
      message: parsed.message ?? "",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Generic classifier factory
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createClassifier}. Each protocol module provides
 * its own config to specialize the shared classification pipeline.
 *
 * @category Timeline
 */
export interface ClassifyConfig<TProtocolEvent> {
  /** Label used in error messages (e.g. `"classifyACPAxonEvent"`). */
  label: string;
  /** Returns `true` if `eventType` belongs to this protocol. */
  isProtocolEventType: (eventType: string) => boolean;
  /**
   * Converts a parsed payload into a protocol-specific timeline event.
   * Return `null` to fall through to the `unknown` classification.
   */
  toProtocolEvent: (data: unknown, ev: AxonEventView) => TProtocolEvent | null;
  /**
   * Called when a non-critical error occurs (e.g. unparseable payload).
   * Defaults to `console.warn`.
   */
  onError?: (error: unknown) => void;
}

/**
 * Creates a classifier function that maps raw Axon events into a
 * discriminated union of `SystemTimelineEvent | TProtocolEvent | UnknownTimelineEvent`.
 *
 * The shared pipeline:
 * 1. `SYSTEM_EVENT` origin -> attempt {@link tryParseSystemEvent}
 * 2. Known protocol event type -> JSON-parse payload, delegate to `toProtocolEvent`
 * 3. Everything else -> `{ kind: "unknown" }`
 *
 * @category Timeline
 */
export function createClassifier<TProtocolEvent>(
  config: ClassifyConfig<TProtocolEvent>,
): (ev: AxonEventView) => SystemTimelineEvent | TProtocolEvent | UnknownTimelineEvent {
  const reportError = config.onError ?? ((err: unknown) => console.warn(err));
  return (ev: AxonEventView) => {
    if (ev.origin === "SYSTEM_EVENT") {
      const systemEvent = tryParseSystemEvent(ev);
      if (systemEvent) {
        return { kind: "system" as const, data: systemEvent, axonEvent: ev };
      }
    }

    if (config.isProtocolEventType(ev.event_type)) {
      let data: unknown = null;
      if (typeof ev.payload === "string") {
        try {
          data = JSON.parse(ev.payload);
        } catch (err) {
          reportError(
            `[${config.label}] Failed to parse payload for event_type="${ev.event_type}": ${err}`,
          );
        }
      } else if (ev.payload != null) {
        data = ev.payload;
      }
      const result = config.toProtocolEvent(data, ev);
      if (result) return result;
    }

    const unknownData = tryParseTimelinePayload({ axonEvent: ev });
    return { kind: "unknown" as const, data: unknownData, axonEvent: ev };
  };
}

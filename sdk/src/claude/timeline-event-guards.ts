/**
 * Type guards for narrowing {@link ClaudeTimelineEvent} to specific variants.
 *
 * Use these to discriminate the timeline event union in `onTimelineEvent`
 * callbacks or when processing events from `receiveTimelineEvents()`.
 *
 * @example
 * ```typescript
 * conn.onTimelineEvent((event) => {
 *   if (isClaudeAssistantTextEvent(event)) {
 *     // event.data is SDKAssistantMessage with at least one text block
 *     console.log("Got assistant text");
 *   }
 *   if (isClaudeResultEvent(event)) {
 *     console.log("Turn complete:", event.data.subtype);
 *   }
 *   if (isTurnStartedEvent(event)) {
 *     console.log("Turn started:", event.data.turnId);
 *   }
 * });
 * ```
 *
 * @module
 */

import { isTextContentBlock } from "../shared/structural-guards.js";
import type {
  ClaudeAssistantTimelineEvent,
  ClaudeControlRequestTimelineEvent,
  ClaudeControlResponseTimelineEvent,
  ClaudeProtocolTimelineEvent,
  ClaudeQueryTimelineEvent,
  ClaudeResultTimelineEvent,
  ClaudeSystemInitTimelineEvent,
  ClaudeTimelineEvent,
} from "./types.js";

// Re-export shared system/unknown guards and types for convenience.
// Consumers can import from either `@runloop/remote-agents-sdk/claude` or `/shared`.
export type {
  AgentErrorTimelineEvent,
  AgentLogTimelineEvent,
  BrokerErrorTimelineEvent,
  DevboxLifecycleTimelineEvent,
  TurnCompletedTimelineEvent,
  TurnFailedTimelineEvent,
  TurnStartedTimelineEvent,
} from "../shared/timeline-event-guards.js";
export {
  createCustomEventGuard,
  isAgentErrorEvent,
  isAgentLogEvent,
  isBrokerErrorEvent,
  isDevboxLifecycleEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "../shared/timeline-event-guards.js";

// ---------------------------------------------------------------------------
// Claude protocol event guards
// ---------------------------------------------------------------------------

/**
 * Type guard for Claude protocol timeline events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeProtocolTimelineEvent}.
 * @category Timeline
 */
export function isClaudeProtocolEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeProtocolTimelineEvent {
  return event.kind === "claude_protocol";
}

/**
 * Type guard for Claude assistant message events.
 *
 * After narrowing, `event.data` is an `SDKAssistantMessage`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeAssistantTimelineEvent}.
 * @category Timeline
 */
export function isClaudeAssistantEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeAssistantTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "assistant";
}

/**
 * Type guard for Claude assistant message events containing non-empty text.
 *
 * This is a compound guard that narrows to `ClaudeAssistantTimelineEvent` AND
 * verifies the message contains at least one text block with non-whitespace content.
 * Replaces the common pattern:
 * ```typescript
 * if (event.kind === "claude_protocol" && event.eventType === "assistant") {
 *   if (event.data.message.content.some((b) => b.type === "text" && b.text.trim().length > 0)) {
 *     // ...
 *   }
 * }
 * ```
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an assistant event with at least one non-empty text block.
 * @category Timeline
 */
export function isClaudeAssistantTextEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeAssistantTimelineEvent {
  if (!isClaudeAssistantEvent(event)) {
    return false;
  }
  const content = event.data.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => isTextContentBlock(block) && block.text.trim().length > 0);
}

/**
 * Type guard for Claude result (turn-complete) events.
 *
 * After narrowing, `event.data` is an `SDKResultMessage`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeResultTimelineEvent}.
 * @category Timeline
 */
export function isClaudeResultEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeResultTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "result";
}

/**
 * Type guard for Claude user query events.
 *
 * After narrowing, `event.data` is an `SDKUserMessage`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeQueryTimelineEvent}.
 * @category Timeline
 */
export function isClaudeQueryEvent(event: ClaudeTimelineEvent): event is ClaudeQueryTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "query";
}

/**
 * Type guard for Claude system/init events (per-turn initialization).
 *
 * After narrowing, `event.data` is an `SDKSystemMessage`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeSystemInitTimelineEvent}.
 * @category Timeline
 */
export function isClaudeSystemInitEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeSystemInitTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "system";
}

/**
 * Type guard for Claude control request events.
 *
 * After narrowing, `event.data` is an `SDKControlRequest`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeControlRequestTimelineEvent}.
 * @category Timeline
 */
export function isClaudeControlRequestEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeControlRequestTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "control_request";
}

/**
 * Type guard for Claude control response events.
 *
 * After narrowing, `event.data` is an `SDKControlResponse`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is a {@link ClaudeControlResponseTimelineEvent}.
 * @category Timeline
 */
export function isClaudeControlResponseEvent(
  event: ClaudeTimelineEvent,
): event is ClaudeControlResponseTimelineEvent {
  return event.kind === "claude_protocol" && event.eventType === "control_response";
}

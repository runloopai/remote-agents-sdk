/** Type guards for Pi timeline events. */
import type {
  PiAgentEndTimelineEvent,
  PiAgentSettledTimelineEvent,
  PiAgentStartTimelineEvent,
  PiAssistantTextDeltaTimelineEvent,
  PiAssistantThinkingDeltaTimelineEvent,
  PiMessageEndTimelineEvent,
  PiMessageStartTimelineEvent,
  PiMessageUpdateTimelineEvent,
  PiProtocolTimelineEvent,
  PiResponseTimelineEvent,
  PiTimelineEvent,
  PiToolExecutionEndTimelineEvent,
  PiToolExecutionStartTimelineEvent,
  PiToolExecutionUpdateTimelineEvent,
  PiTurnEndTimelineEvent,
  PiTurnStartTimelineEvent,
} from "./types.js";

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

export function isPiProtocolEvent(event: PiTimelineEvent): event is PiProtocolTimelineEvent {
  return event.kind === "pi_protocol";
}

function hasEventType<M extends PiProtocolTimelineEvent["eventType"]>(
  event: PiTimelineEvent,
  eventType: M,
): event is Extract<PiProtocolTimelineEvent, { eventType: M }> {
  return event.kind === "pi_protocol" && event.eventType === eventType;
}

export const isPiAgentStartEvent = (event: PiTimelineEvent): event is PiAgentStartTimelineEvent =>
  hasEventType(event, "agent_start");
export const isPiMessageStartEvent = (
  event: PiTimelineEvent,
): event is PiMessageStartTimelineEvent => hasEventType(event, "message_start");
export const isPiMessageUpdateEvent = (
  event: PiTimelineEvent,
): event is PiMessageUpdateTimelineEvent => hasEventType(event, "message_update");
export const isPiMessageEndEvent = (event: PiTimelineEvent): event is PiMessageEndTimelineEvent =>
  hasEventType(event, "message_end");
export const isPiToolExecutionStartEvent = (
  event: PiTimelineEvent,
): event is PiToolExecutionStartTimelineEvent => hasEventType(event, "tool_execution_start");
export const isPiToolExecutionUpdateEvent = (
  event: PiTimelineEvent,
): event is PiToolExecutionUpdateTimelineEvent => hasEventType(event, "tool_execution_update");
export const isPiToolExecutionEndEvent = (
  event: PiTimelineEvent,
): event is PiToolExecutionEndTimelineEvent => hasEventType(event, "tool_execution_end");
export const isPiTurnStartEvent = (event: PiTimelineEvent): event is PiTurnStartTimelineEvent =>
  hasEventType(event, "turn_start");
export const isPiTurnEndEvent = (event: PiTimelineEvent): event is PiTurnEndTimelineEvent =>
  hasEventType(event, "turn_end");
export const isPiAgentEndEvent = (event: PiTimelineEvent): event is PiAgentEndTimelineEvent =>
  hasEventType(event, "agent_end");
export const isPiAgentSettledEvent = (
  event: PiTimelineEvent,
): event is PiAgentSettledTimelineEvent => hasEventType(event, "agent_settled");
export const isPiResponseEvent = (event: PiTimelineEvent): event is PiResponseTimelineEvent =>
  hasEventType(event, "response");

/** Narrows a `message_update` to an assistant text delta. */
export function isPiAssistantTextDeltaEvent(
  event: PiTimelineEvent,
): event is PiAssistantTextDeltaTimelineEvent {
  return isPiMessageUpdateEvent(event) && event.data.assistantMessageEvent?.type === "text_delta";
}

/** Narrows a `message_update` to an assistant thinking delta. */
export function isPiAssistantThinkingDeltaEvent(
  event: PiTimelineEvent,
): event is PiAssistantThinkingDeltaTimelineEvent {
  return (
    isPiMessageUpdateEvent(event) && event.data.assistantMessageEvent?.type === "thinking_delta"
  );
}

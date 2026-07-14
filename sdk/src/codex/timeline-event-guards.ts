/** Type guards for Codex app-server timeline events. */
import { CODEX_APPROVAL_REQUEST_METHOD_SET } from "./protocol/index.js";
import type {
  CodexAgentMessageDeltaTimelineEvent,
  CodexApprovalRequestTimelineEvent,
  CodexCommandExecutionOutputDeltaTimelineEvent,
  CodexErrorTimelineEvent,
  CodexItemCompletedTimelineEvent,
  CodexItemStartedTimelineEvent,
  CodexProtocolTimelineEvent,
  CodexReasoningSummaryPartAddedTimelineEvent,
  CodexReasoningSummaryTextDeltaTimelineEvent,
  CodexReasoningTextDeltaTimelineEvent,
  CodexResponseTimelineEvent,
  CodexThreadStartedTimelineEvent,
  CodexTimelineEvent,
  CodexTurnCompletedTimelineEvent,
  CodexTurnStartedTimelineEvent,
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

export function isCodexProtocolEvent(
  event: CodexTimelineEvent,
): event is CodexProtocolTimelineEvent {
  return event.kind === "codex_protocol";
}

function hasEventType<M extends CodexProtocolTimelineEvent["eventType"]>(
  event: CodexTimelineEvent,
  eventType: M,
): event is Extract<CodexProtocolTimelineEvent, { eventType: M }> {
  return event.kind === "codex_protocol" && event.eventType === eventType;
}

export const isCodexThreadStartedEvent = (
  event: CodexTimelineEvent,
): event is CodexThreadStartedTimelineEvent => hasEventType(event, "thread/started");
export const isCodexTurnStartedEvent = (
  event: CodexTimelineEvent,
): event is CodexTurnStartedTimelineEvent => hasEventType(event, "turn/started");
export const isCodexTurnCompletedEvent = (
  event: CodexTimelineEvent,
): event is CodexTurnCompletedTimelineEvent => hasEventType(event, "turn/completed");
export const isCodexItemStartedEvent = (
  event: CodexTimelineEvent,
): event is CodexItemStartedTimelineEvent => hasEventType(event, "item/started");
export const isCodexItemCompletedEvent = (
  event: CodexTimelineEvent,
): event is CodexItemCompletedTimelineEvent => hasEventType(event, "item/completed");
export const isCodexAgentMessageDeltaEvent = (
  event: CodexTimelineEvent,
): event is CodexAgentMessageDeltaTimelineEvent => hasEventType(event, "item/agentMessage/delta");
export const isCodexCommandExecutionOutputDeltaEvent = (
  event: CodexTimelineEvent,
): event is CodexCommandExecutionOutputDeltaTimelineEvent =>
  hasEventType(event, "item/commandExecution/outputDelta");
export const isCodexReasoningSummaryTextDeltaEvent = (
  event: CodexTimelineEvent,
): event is CodexReasoningSummaryTextDeltaTimelineEvent =>
  hasEventType(event, "item/reasoning/summaryTextDelta");
export const isCodexReasoningSummaryPartAddedEvent = (
  event: CodexTimelineEvent,
): event is CodexReasoningSummaryPartAddedTimelineEvent =>
  hasEventType(event, "item/reasoning/summaryPartAdded");
export const isCodexReasoningTextDeltaEvent = (
  event: CodexTimelineEvent,
): event is CodexReasoningTextDeltaTimelineEvent => hasEventType(event, "item/reasoning/textDelta");
export const isCodexErrorEvent = (event: CodexTimelineEvent): event is CodexErrorTimelineEvent =>
  hasEventType(event, "error");
export const isCodexResponseEvent = (
  event: CodexTimelineEvent,
): event is CodexResponseTimelineEvent => hasEventType(event, "response");

export function isCodexApprovalRequestEvent(
  event: CodexTimelineEvent,
): event is CodexApprovalRequestTimelineEvent {
  return event.kind === "codex_protocol" && CODEX_APPROVAL_REQUEST_METHOD_SET.has(event.eventType);
}

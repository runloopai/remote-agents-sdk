/**
 * Claude module for connecting to Claude Code instances running inside
 * Runloop devboxes via the Axon event bus.
 *
 * **Getting started:** Create a {@link ClaudeAxonConnection} with an
 * Axon channel and devbox ID, call
 * {@link ClaudeAxonConnection.connect | connect()} then
 * {@link ClaudeAxonConnection.initialize | initialize()}, then use
 * {@link ClaudeAxonConnection.send | send()} and
 * {@link ClaudeAxonConnection.receiveAgentResponse | receiveAgentResponse()} to
 * interact with Claude Code.
 *
 * @categoryDescription Connection
 * The main connection class for interacting with Claude Code.
 *
 * @categoryDescription Configuration
 * Options, callbacks, and listener types used when creating a connection.
 *
 * @categoryDescription Transport
 * Low-level transport layer that bridges Axon SSE streams and the Claude
 * wire protocol. Most users won't need this directly.
 *
 * @categoryDescription Claude SDK
 * Re-exported message and control types from the upstream
 * `@anthropic-ai/claude-agent-sdk`. Use these to type method parameters
 * and narrow response messages.
 *
 * @module
 */

/** @category Claude SDK */
export type * from "@anthropic-ai/claude-agent-sdk";

/** @category Claude SDK */
export type {
  PermissionMode,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKCompactBoundaryMessage,
  SDKControlRequest,
  SDKControlResponse,
  SDKElicitationCompleteMessage,
  SDKFilesPersistedEvent,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKLocalCommandOutputMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKPromptSuggestionMessage,
  SDKRateLimitEvent,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
export {
  type AgentOriginEvent,
  isFromAgent,
  isFromUser,
  type UserOriginEvent,
} from "../shared/origin-guards.js";
export { tryParseSystemEvent, tryParseTimelinePayload } from "../shared/timeline.js";
export type {
  AxonEventListener,
  AxonEventView,
  BaseConnectionOptions,
  CustomTimelineEvent,
  SystemEvent,
  SystemTimelineEvent,
  TimelineEventListener,
  UnknownTimelineEvent,
} from "../shared/types.js";
export {
  type ExtractedClaudeUserMessage,
  type ExtractedUserMessage,
  extractClaudeUserMessage,
} from "../shared/user-message.js";
export {
  classifyClaudeAxonEvent,
  isClaudeProtocolEventType,
} from "./classify-claude-axon-event.js";
export {
  ClaudeAxonConnection,
  type ClaudeAxonConnectionOptions,
  type ControlRequestHandler,
  type ControlRequestInner,
  type ControlRequestOfSubtype,
} from "./connection.js";
export type {
  AgentErrorTimelineEvent,
  AgentLogTimelineEvent,
  BrokerErrorTimelineEvent,
  DevboxLifecycleTimelineEvent,
  TurnCompletedTimelineEvent,
  TurnFailedTimelineEvent,
  TurnStartedTimelineEvent,
} from "./timeline-event-guards.js";
export {
  createCustomEventGuard,
  isAgentErrorEvent,
  isAgentLogEvent,
  isBrokerErrorEvent,
  isClaudeAssistantEvent,
  isClaudeAssistantTextEvent,
  isClaudeControlRequestEvent,
  isClaudeControlResponseEvent,
  isClaudeProtocolEvent,
  isClaudeQueryEvent,
  isClaudeResultEvent,
  isClaudeSystemInitEvent,
  isDevboxLifecycleEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
export {
  AxonTransport,
  type AxonTransportOptions,
  type ControlRequestEvent,
  type ControlResponseEvent,
  isControlRequest,
  isControlResponse,
  type Transport,
} from "./transport.js";
export type {
  ClaudeAssistantTimelineEvent,
  ClaudeControlRequestTimelineEvent,
  ClaudeControlResponseTimelineEvent,
  ClaudeOtherProtocolTimelineEvent,
  ClaudeProtocolTimelineEvent,
  ClaudeQueryTimelineEvent,
  ClaudeResultTimelineEvent,
  ClaudeSystemInitTimelineEvent,
  ClaudeTimelineEvent,
  WireData,
} from "./types.js";

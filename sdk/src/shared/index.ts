/**
 * Shared types and utilities used by both the ACP and Claude connection modules.
 *
 * @categoryDescription Types
 * Common types shared by both the ACP and Claude connection modules.
 *
 * @categoryDescription Utilities
 * Internal helpers for lifecycle management, logging, and listener dispatch.
 *
 * @module
 */

export { resolveReplayTarget } from "./connect-guards.js";
export {
  ConnectionStateError,
  type ConnectionStateErrorCode,
  isConnectionStateError,
} from "./errors/connection-state-error.js";
export { InitializationError } from "./errors/initialization-error.js";
export { SystemError, type SystemErrorEventInfo } from "./errors/system-error.js";
export { runDisconnectHook } from "./lifecycle.js";
export { ListenerSet } from "./listener-set.js";
export { makeDefaultOnError, makeLogger } from "./logging.js";
export {
  type AgentOriginEvent,
  isFromAgent,
  isFromUser,
  type UserOriginEvent,
} from "./origin-guards.js";
export { getLastSequence } from "./replay.js";
export {
  getJsonRpcId,
  getRequestId,
  getStringProp,
  hasJsonRpcId,
  hasRequestId,
  hasStringType,
  isNonNullObject,
  isTextContentBlock,
} from "./structural-guards.js";
export {
  type ClassifyConfig,
  createClassifier,
  isSystemEventType,
  SYSTEM_EVENT_TYPES,
  tryParseSystemEvent,
  tryParseTimelinePayload,
} from "./timeline.js";
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
  isDevboxLifecycleEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
export { timelineEventGenerator } from "./timeline-generator.js";
/** @category Timeline */
export type {
  AgentErrorEvent,
  AgentLogEvent,
  AgentLogType,
  AxonEventListener,
  AxonEventView,
  BaseConnectionOptions,
  BaseTimelineEvent,
  CustomTimelineEvent,
  DevboxLifecycleEvent,
  DevboxLifecycleKind,
  LogFn,
  SystemEvent,
  SystemTimelineEvent,
  TimelineEventListener,
  UnknownTimelineEvent,
} from "./types.js";
export {
  type ExtractedACPUserMessage,
  type ExtractedClaudeUserMessage,
  type ExtractedUserMessage,
  extractACPUserMessage,
  extractClaudeUserMessage,
} from "./user-message.js";

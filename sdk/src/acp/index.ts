/**
 * ACP (Agent Client Protocol) module for connecting to ACP-compatible agents
 * running inside Runloop devboxes via the Axon event bus.
 *
 * **Getting started:** Create an {@link ACPAxonConnection} with your Axon
 * channel, call {@link ACPAxonConnection.initialize | initialize()}, then
 * use {@link ACPAxonConnection.newSession | newSession()} and
 * {@link ACPAxonConnection.prompt | prompt()} to interact with the agent.
 * Subscribe to streaming updates with
 * {@link ACPAxonConnection.onSessionUpdate | onSessionUpdate()} and narrow
 * them using the type guard functions.
 *
 * @categoryDescription Connection
 * The main connection class and its low-level stream factory.
 *
 * @categoryDescription Configuration
 * Options, callbacks, and listener types used when creating a connection.
 *
 * @categoryDescription Session Updates
 * Type guards and narrowed types for discriminating {@link SessionUpdate} variants
 * received via {@link ACPAxonConnection.onSessionUpdate | onSessionUpdate()}.
 *
 * @categoryDescription ACP Protocol
 * Re-exported request/response types and constants from the upstream
 * `@agentclientprotocol/sdk`. Use these to type method parameters.
 *
 * @module
 */

/** @category ACP Protocol */
export type * from "@agentclientprotocol/sdk";

/** @category ACP Protocol */
export type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  Stream,
} from "@agentclientprotocol/sdk";

/** @category ACP Protocol */
export {
  CLIENT_METHODS,
  ClientSideConnection,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
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
  type ExtractedACPUserMessage,
  type ExtractedUserMessage,
  extractACPUserMessage,
} from "../shared/user-message.js";
export { axonStream } from "./axon-stream.js";
export { ACPAxonConnection, classifyACPAxonEvent, isACPProtocolEventType } from "./connection.js";
export {
  isAudioContent,
  isEmbeddedResourceContent,
  isImageContent,
  isResourceLinkContent,
  isTextContent,
} from "./content-block-guards.js";
export type {
  AgentMessageChunkUpdate,
  AgentTextChunkUpdate,
  AgentThoughtChunkUpdate,
  AvailableCommandsSessionUpdate,
  ConfigOptionSessionUpdate,
  CurrentModeSessionUpdate,
  PlanSessionUpdate,
  SessionInfoSessionUpdate,
  ThoughtTextChunkUpdate,
  ToolCallProgressSessionUpdate,
  ToolCallSessionUpdate,
  UsageSessionUpdate,
  UserMessageChunkUpdate,
} from "./session-update-guards.js";
export {
  isAgentMessageChunk,
  isAgentTextChunk,
  isAgentThoughtChunk,
  isAvailableCommandsUpdate,
  isConfigOptionUpdate,
  isCurrentModeUpdate,
  isPlan,
  isSessionInfoUpdate,
  isThoughtTextChunk,
  isToolCall,
  isToolCallProgress,
  isUsageUpdate,
  isUserMessageChunk,
} from "./session-update-guards.js";
export type {
  AgentErrorTimelineEvent,
  AgentLogTimelineEvent,
  BrokerErrorTimelineEvent,
  DevboxLifecycleTimelineEvent,
  ElicitationCompleteTimelineEvent,
  ElicitationTimelineEvent,
  TurnCompletedTimelineEvent,
  TurnFailedTimelineEvent,
  TurnStartedTimelineEvent,
} from "./timeline-event-guards.js";
export {
  createCustomEventGuard,
  isACPProtocolEvent,
  isAgentErrorEvent,
  isAgentLogEvent,
  isBrokerErrorEvent,
  isDevboxLifecycleEvent,
  isElicitationCompleteEvent,
  isElicitationRequestEvent,
  isElicitationResponseEvent,
  isInitializeEvent,
  isNewSessionEvent,
  isPromptEvent,
  isSessionUpdateEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
export type {
  ACPAxonConnectionOptions,
  ACPInitializeTimelineEvent,
  ACPNewSessionTimelineEvent,
  ACPOtherProtocolTimelineEvent,
  ACPPromptTimelineEvent,
  ACPProtocolTimelineEvent,
  ACPSessionUpdateTimelineEvent,
  ACPTimelineEvent,
  AxonStreamOptions,
  CreateClientFn,
  SessionUpdateListener,
} from "./types.js";

/**
 * Type guards for narrowing {@link ACPTimelineEvent} to specific variants.
 *
 * Use these to discriminate the timeline event union in `onTimelineEvent`
 * callbacks or when processing events from `receiveTimelineEvents()`.
 *
 * @example
 * ```typescript
 * conn.onTimelineEvent((event) => {
 *   if (isSessionUpdateEvent(event)) {
 *     // event.data is SessionNotification
 *     const update = event.data.update;
 *     if (isAgentMessageChunk(update)) {
 *       console.log(update.content);
 *     }
 *   }
 *   if (isTurnStartedEvent(event)) {
 *     console.log("Turn started:", event.data.turnId);
 *   }
 * });
 * ```
 *
 * @module
 */

import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import type {
  ACPInitializeTimelineEvent,
  ACPNewSessionTimelineEvent,
  ACPOtherProtocolTimelineEvent,
  ACPPromptTimelineEvent,
  ACPProtocolTimelineEvent,
  ACPSessionUpdateTimelineEvent,
  ACPTimelineEvent,
} from "./types.js";

// Re-export shared system/unknown guards and types for convenience.
// Consumers can import from either `@runloop/remote-agents-sdk/acp` or `/shared`.
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
// ACP protocol event guards
// ---------------------------------------------------------------------------

/**
 * Type guard for ACP protocol timeline events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link ACPProtocolTimelineEvent}.
 * @category Timeline
 */
export function isACPProtocolEvent(event: ACPTimelineEvent): event is ACPProtocolTimelineEvent {
  return event.kind === "acp_protocol";
}

/**
 * Type guard for `session/update` timeline events.
 *
 * After narrowing, `event.data` is a `SessionNotification` containing
 * `{ sessionId, update }` where `update` is the `SessionUpdate`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link ACPSessionUpdateTimelineEvent}.
 * @category Timeline
 */
export function isSessionUpdateEvent(
  event: ACPTimelineEvent,
): event is ACPSessionUpdateTimelineEvent {
  return event.kind === "acp_protocol" && event.eventType === CLIENT_METHODS.session_update;
}

/**
 * Type guard for `initialize` timeline events.
 *
 * After narrowing, `event.data` is `InitializeRequest | InitializeResponse`.
 * Check `event.axonEvent.origin` to distinguish direction:
 * - `USER_EVENT` = client sent the request
 * - `AGENT_EVENT` = agent sent the response
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link ACPInitializeTimelineEvent}.
 * @category Timeline
 */
export function isInitializeEvent(event: ACPTimelineEvent): event is ACPInitializeTimelineEvent {
  return event.kind === "acp_protocol" && event.eventType === AGENT_METHODS.initialize;
}

/**
 * Type guard for `session/prompt` timeline events.
 *
 * After narrowing, `event.data` is `PromptRequest | PromptResponse`.
 * Check `event.axonEvent.origin` to distinguish direction.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link ACPPromptTimelineEvent}.
 * @category Timeline
 */
export function isPromptEvent(event: ACPTimelineEvent): event is ACPPromptTimelineEvent {
  return event.kind === "acp_protocol" && event.eventType === AGENT_METHODS.session_prompt;
}

/**
 * Type guard for `session/new` timeline events.
 *
 * After narrowing, `event.data` is `NewSessionRequest | NewSessionResponse`.
 * Check `event.axonEvent.origin` to distinguish direction.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an {@link ACPNewSessionTimelineEvent}.
 * @category Timeline
 */
export function isNewSessionEvent(event: ACPTimelineEvent): event is ACPNewSessionTimelineEvent {
  return event.kind === "acp_protocol" && event.eventType === AGENT_METHODS.session_new;
}

// ---------------------------------------------------------------------------
// Elicitation timeline event types and guards
// ---------------------------------------------------------------------------

/**
 * A timeline event for `session/elicitation` (agent requesting user input).
 *
 * Check `axonEvent.origin` to determine direction:
 * - `AGENT_EVENT` = agent sent the request
 * - `USER_EVENT` = client sent the response
 *
 * @category Timeline
 */
export type ElicitationTimelineEvent = ACPOtherProtocolTimelineEvent & {
  eventType: typeof CLIENT_METHODS.session_elicitation;
};

/**
 * A timeline event for `session/elicitation/complete` notification.
 *
 * @category Timeline
 */
export type ElicitationCompleteTimelineEvent = ACPOtherProtocolTimelineEvent & {
  eventType: typeof CLIENT_METHODS.session_elicitation_complete;
};

/**
 * Type guard for `session/elicitation` timeline events (request from agent).
 *
 * This matches when the agent asks the client for user input. The request
 * arrives as an `AGENT_EVENT`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an elicitation request from the agent.
 * @category Timeline
 */
export function isElicitationRequestEvent(
  event: ACPTimelineEvent,
): event is ElicitationTimelineEvent {
  return (
    event.kind === "acp_protocol" &&
    event.eventType === CLIENT_METHODS.session_elicitation &&
    isFromAgent(event)
  );
}

/**
 * Type guard for `session/elicitation` timeline events (response from client).
 *
 * This matches when the client responds to an elicitation request. The response
 * arrives as a `USER_EVENT`.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an elicitation response from the client.
 * @category Timeline
 */
export function isElicitationResponseEvent(
  event: ACPTimelineEvent,
): event is ElicitationTimelineEvent {
  return (
    event.kind === "acp_protocol" &&
    event.eventType === CLIENT_METHODS.session_elicitation &&
    isFromUser(event)
  );
}

/**
 * Type guard for `session/elicitation/complete` timeline events.
 *
 * @param event - The timeline event to test.
 * @returns `true` if `event` is an elicitation complete notification.
 * @category Timeline
 */
export function isElicitationCompleteEvent(
  event: ACPTimelineEvent,
): event is ElicitationCompleteTimelineEvent {
  return (
    event.kind === "acp_protocol" && event.eventType === CLIENT_METHODS.session_elicitation_complete
  );
}

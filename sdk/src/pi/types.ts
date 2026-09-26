/** Types for Pi timeline classification. */
import type {
  BaseTimelineEvent,
  SystemTimelineEvent,
  UnknownTimelineEvent,
} from "../shared/types.js";
import type {
  AssistantMessageEvent,
  MessageUpdateEvent,
  PiEvent,
  PiResponse,
} from "./protocol/index.js";

type EventFrame<M extends PiEvent["type"]> = Extract<PiEvent, { type: M }>;

type ProtocolTimelineEvent<M extends string, D> = BaseTimelineEvent & {
  kind: "pi_protocol";
  eventType: M;
  data: D;
};

export type PiAgentStartTimelineEvent = ProtocolTimelineEvent<
  "agent_start",
  EventFrame<"agent_start">
>;
export type PiMessageStartTimelineEvent = ProtocolTimelineEvent<
  "message_start",
  EventFrame<"message_start">
>;
export type PiMessageUpdateTimelineEvent = ProtocolTimelineEvent<
  "message_update",
  EventFrame<"message_update">
>;
export type PiMessageEndTimelineEvent = ProtocolTimelineEvent<
  "message_end",
  EventFrame<"message_end">
>;
export type PiToolExecutionStartTimelineEvent = ProtocolTimelineEvent<
  "tool_execution_start",
  EventFrame<"tool_execution_start">
>;
export type PiToolExecutionUpdateTimelineEvent = ProtocolTimelineEvent<
  "tool_execution_update",
  EventFrame<"tool_execution_update">
>;
export type PiToolExecutionEndTimelineEvent = ProtocolTimelineEvent<
  "tool_execution_end",
  EventFrame<"tool_execution_end">
>;
export type PiTurnStartTimelineEvent = ProtocolTimelineEvent<
  "turn_start",
  EventFrame<"turn_start">
>;
export type PiTurnEndTimelineEvent = ProtocolTimelineEvent<"turn_end", EventFrame<"turn_end">>;
export type PiAgentEndTimelineEvent = ProtocolTimelineEvent<"agent_end", EventFrame<"agent_end">>;
export type PiAgentSettledTimelineEvent = ProtocolTimelineEvent<
  "agent_settled",
  EventFrame<"agent_settled">
>;
export type PiResponseTimelineEvent = ProtocolTimelineEvent<"response", PiResponse>;

/** A `message_update` narrowed to one variant of its nested streaming delta. */
type AssistantDeltaTimelineEvent<T extends AssistantMessageEvent["type"]> =
  PiMessageUpdateTimelineEvent & {
    data: MessageUpdateEvent & {
      assistantMessageEvent: Extract<AssistantMessageEvent, { type: T }>;
    };
  };

export type PiAssistantTextDeltaTimelineEvent = AssistantDeltaTimelineEvent<"text_delta">;
export type PiAssistantThinkingDeltaTimelineEvent = AssistantDeltaTimelineEvent<"thinking_delta">;

export type PiProtocolTimelineEvent =
  | PiAgentStartTimelineEvent
  | PiMessageStartTimelineEvent
  | PiMessageUpdateTimelineEvent
  | PiMessageEndTimelineEvent
  | PiToolExecutionStartTimelineEvent
  | PiToolExecutionUpdateTimelineEvent
  | PiToolExecutionEndTimelineEvent
  | PiTurnStartTimelineEvent
  | PiTurnEndTimelineEvent
  | PiAgentEndTimelineEvent
  | PiAgentSettledTimelineEvent
  | PiResponseTimelineEvent;

export type PiTimelineEvent = PiProtocolTimelineEvent | SystemTimelineEvent | UnknownTimelineEvent;

/** Types for Codex app-server timeline classification. */
import type {
  BaseTimelineEvent,
  SystemTimelineEvent,
  UnknownTimelineEvent,
} from "../shared/types.js";
import type { ServerNotification, ServerRequest } from "./protocol/index.js";

export type CodexResponseFrame = {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type NotificationFrame<M extends ServerNotification["method"]> = Extract<
  ServerNotification,
  { method: M }
>;
type RequestFrame<M extends ServerRequest["method"]> = Extract<ServerRequest, { method: M }>;

type ProtocolTimelineEvent<M extends string, D> = BaseTimelineEvent & {
  kind: "codex_protocol";
  eventType: M;
  data: D;
};

export type CodexThreadStartedTimelineEvent = ProtocolTimelineEvent<
  "thread/started",
  NotificationFrame<"thread/started">
>;
export type CodexTurnStartedTimelineEvent = ProtocolTimelineEvent<
  "turn/started",
  NotificationFrame<"turn/started">
>;
export type CodexTurnCompletedTimelineEvent = ProtocolTimelineEvent<
  "turn/completed",
  NotificationFrame<"turn/completed">
>;
export type CodexItemStartedTimelineEvent = ProtocolTimelineEvent<
  "item/started",
  NotificationFrame<"item/started">
>;
export type CodexItemCompletedTimelineEvent = ProtocolTimelineEvent<
  "item/completed",
  NotificationFrame<"item/completed">
>;
export type CodexAgentMessageDeltaTimelineEvent = ProtocolTimelineEvent<
  "item/agentMessage/delta",
  NotificationFrame<"item/agentMessage/delta">
>;
export type CodexCommandExecutionOutputDeltaTimelineEvent = ProtocolTimelineEvent<
  "item/commandExecution/outputDelta",
  NotificationFrame<"item/commandExecution/outputDelta">
>;
export type CodexReasoningSummaryTextDeltaTimelineEvent = ProtocolTimelineEvent<
  "item/reasoning/summaryTextDelta",
  NotificationFrame<"item/reasoning/summaryTextDelta">
>;
export type CodexReasoningSummaryPartAddedTimelineEvent = ProtocolTimelineEvent<
  "item/reasoning/summaryPartAdded",
  NotificationFrame<"item/reasoning/summaryPartAdded">
>;
export type CodexReasoningTextDeltaTimelineEvent = ProtocolTimelineEvent<
  "item/reasoning/textDelta",
  NotificationFrame<"item/reasoning/textDelta">
>;
export type CodexServerRequestResolvedTimelineEvent = ProtocolTimelineEvent<
  "serverRequest/resolved",
  NotificationFrame<"serverRequest/resolved">
>;
export type CodexErrorTimelineEvent = ProtocolTimelineEvent<"error", NotificationFrame<"error">>;
export type CodexResponseTimelineEvent = ProtocolTimelineEvent<"response", CodexResponseFrame>;

export type CodexApprovalRequestTimelineEvent = {
  [M in Extract<
    ServerRequest["method"],
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/tool/requestUserInput"
    | "mcpServer/elicitation/request"
    | "item/permissions/requestApproval"
    | "execCommandApproval"
    | "applyPatchApproval"
  >]: ProtocolTimelineEvent<M, RequestFrame<M>>;
}[Extract<
  ServerRequest["method"],
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/permissions/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval"
>];

export type CodexProtocolTimelineEvent =
  | CodexThreadStartedTimelineEvent
  | CodexTurnStartedTimelineEvent
  | CodexTurnCompletedTimelineEvent
  | CodexItemStartedTimelineEvent
  | CodexItemCompletedTimelineEvent
  | CodexAgentMessageDeltaTimelineEvent
  | CodexCommandExecutionOutputDeltaTimelineEvent
  | CodexReasoningSummaryTextDeltaTimelineEvent
  | CodexReasoningSummaryPartAddedTimelineEvent
  | CodexReasoningTextDeltaTimelineEvent
  | CodexServerRequestResolvedTimelineEvent
  | CodexApprovalRequestTimelineEvent
  | CodexErrorTimelineEvent
  | CodexResponseTimelineEvent;

export type CodexTimelineEvent =
  | CodexProtocolTimelineEvent
  | SystemTimelineEvent
  | UnknownTimelineEvent;

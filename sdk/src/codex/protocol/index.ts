/** Official Codex app-server protocol bindings and wire method constants. */
export type * from "./generated/index.js";
export type {
  ConfigReadParams,
  ConfigReadResponse,
  ReviewDelivery,
  ReviewStartResponse,
  ReviewTarget,
  ThreadStartParams,
  ThreadStartResponse,
  ToolRequestUserInputAnswer,
  ToolRequestUserInputOption,
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
  TurnStartParams,
  UserInput,
} from "./generated/v2/index.js";

export const THREAD_START = "thread/start";
export const RESPONSE_EVENT_TYPE = "response";
export const RESERVED_REQUEST_ID_PREFIX = "runloop-broker-";

export const CODEX_NOTIFICATION_METHODS = [
  "thread/started",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "error",
] as const;

export const CODEX_APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

export type CodexNotificationMethod = (typeof CODEX_NOTIFICATION_METHODS)[number];
export type CodexApprovalRequestMethod = (typeof CODEX_APPROVAL_REQUEST_METHODS)[number];

export const CODEX_NOTIFICATION_METHOD_SET: ReadonlySet<string> = new Set(
  CODEX_NOTIFICATION_METHODS,
);
export const CODEX_APPROVAL_REQUEST_METHOD_SET: ReadonlySet<string> = new Set(
  CODEX_APPROVAL_REQUEST_METHODS,
);

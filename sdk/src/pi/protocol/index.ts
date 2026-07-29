/**
 * Pi JSONL RPC wire types and broker event-type constants.
 *
 * Hand-written from Pi `0.82.1`
 * (`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`) and kept
 * field-for-field aligned with the broker's Rust bindings in
 * `java/rust/broker/clients/pi-codes/src/{commands,events,response,types}.rs`,
 * so the two can be diffed directly.
 *
 * Pi exchanges one JSON object per line — commands on stdin, responses and
 * events on stdout — correlated by an optional `id`. There is no JSON-RPC
 * envelope. Fields Pi itself declares `any` are `unknown` here, matching the
 * crate's `serde_json::Value`.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** How queued prompts are released: all at once, or one per turn. */
export type QueueMode = "all" | "one-at-a-time";

/**
 * Why an assistant message stopped. `toolUse` continues the turn; the broker
 * maps `stop` to `EndTurn`, `length` to `MaxTokens`, `aborted` to `Cancelled`
 * and `error` to `Error`.
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Input modality a model accepts. */
export type InputKind = "text" | "image";

/** How a prompt submitted while the agent is streaming is queued. */
export type StreamingBehavior = "steer" | "followUp";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: unknown[];
}

export interface PiModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: InputKind[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: unknown;
  headers?: unknown;
  compat?: unknown;
}

/**
 * Snapshot returned by the `get_state` command. `sessionFile` is the path the
 * broker persists as its resume state and replays with `switch_session`.
 */
export interface PiSessionState {
  model: PiModel | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** Result of `new_session` and `switch_session`. */
export interface SessionChange {
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  thoughtSignature?: string;
}

export type UserContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "image"; data: string; mimeType: string };

/** A user message body: plain text, or a list of content blocks. */
export type UserContent = string | UserContentBlock[];

export type AssistantContent =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; thoughtSignature?: string };

export type ToolResultContent =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "image"; data: string; mimeType: string };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: Cost;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: UserContent;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: unknown[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent[];
  details?: unknown;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: UserContent;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** Any message in a Pi session transcript. Discriminate on `role`. */
export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Assistant streaming deltas
// ---------------------------------------------------------------------------

export type AssistantMessageEventSuccessReason = "stop" | "length" | "toolUse";
export type AssistantMessageEventErrorReason = "aborted" | "error";

/**
 * The streaming delta carried by a `message_update` event. Every variant
 * except the two terminal ones carries `partial`, the assistant message
 * accumulated so far.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | { type: "done"; reason: AssistantMessageEventSuccessReason; message: AssistantMessage }
  | { type: "error"; reason: AssistantMessageEventErrorReason; error: AssistantMessage };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface AgentStartEvent {
  type: "agent_start";
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface TurnStartEvent {
  type: "turn_start";
}

export interface TurnEndEvent {
  type: "turn_end";
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

/**
 * The agent stopped producing output. Not the end of the turn: `willRetry`
 * marks an auto-retry, after which more events follow. Only `agent_settled`
 * ends a turn.
 */
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  willRetry: boolean;
}

/** The agent is idle with nothing queued. Terminates a turn. */
export interface AgentSettledEvent {
  type: "agent_settled";
}

/** Any event Pi emits while the agent runs. Discriminate on `type`. */
export type PiEvent =
  | AgentStartEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | AgentEndEvent
  | AgentSettledEvent;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Pi's acknowledgement of a command. `success: false` carries `error`; a
 * `prompt` acknowledgement means the prompt was accepted, not that the turn
 * finished. `data` is the command's payload — {@link PiSessionState} for
 * `get_state`, {@link SessionChange} for `new_session` / `switch_session`.
 */
export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

/** Any frame Pi writes to stdout. */
export type PiOutput = PiResponse | PiEvent;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * The commands this SDK wraps. `steer` and `follow_up` reach Pi verbatim as
 * broker Control frames and so have no counterpart in `pi-codes`, which types
 * only the commands the broker itself constructs.
 */
export type PiCommand =
  | {
      type: "prompt";
      id?: string;
      message: string;
      images?: ImageContent[];
      streamingBehavior?: StreamingBehavior;
    }
  | { type: "steer"; id?: string; message: string; images?: ImageContent[] }
  | { type: "follow_up"; id?: string; message: string; images?: ImageContent[] }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  | { type: "new_session"; id?: string; parentSession?: string }
  | { type: "switch_session"; id?: string; sessionPath: string };

/**
 * Any Pi command frame, including the ~25 commands this SDK does not wrap
 * (`set_model`, `compact`, `bash`, `get_messages`, `export_html`, …).
 */
export interface PiCommandFrame {
  type: string;
  id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Broker event-type constants
// ---------------------------------------------------------------------------

/**
 * Outbound broker event type that starts a turn. Slash-style, unlike the
 * inbound `turn_start` Pi event — the broker's `classify_input` matches this
 * exact string and silently ignores anything else it does not recognize.
 */
export const PI_TURN_START_EVENT_TYPE = "turn/start";

/** Outbound broker event type that aborts the in-flight turn. */
export const PI_CANCEL_EVENT_TYPE = "cancel";

/** Event type the broker assigns to every Pi acknowledgement frame. */
export const PI_RESPONSE_EVENT_TYPE = "response";

/** Event types the broker assigns to Pi's modelled events, in `pi-codes` order. */
export const PI_EVENT_TYPES = [
  "agent_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_start",
  "turn_end",
  "agent_end",
  "agent_settled",
] as const;

export type PiEventType = (typeof PI_EVENT_TYPES)[number];

export const PI_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PI_EVENT_TYPES);

/**
 * Id prefix the Pi adapter uses for the commands it issues itself. Client
 * frames must not use it, or their acknowledgements would collide with the
 * broker's.
 */
export const RESERVED_REQUEST_ID_PREFIX = "broker-";

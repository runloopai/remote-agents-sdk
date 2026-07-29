import type {
  AvailableCommand,
  Diff,
  ModelInfo,
  PermissionOption,
  SessionInfo,
  SessionMode,
  Terminal,
  ToolCallStatus,
  ToolKind,
  AgentCapabilities,
  ClientCapabilities,
  ElicitationPropertySchema,
  ElicitationSchema,
  Implementation,
  PlanEntry,
  SessionConfigOption,
} from "@runloop/remote-agents-sdk/acp";
import type { ACPTimelineEvent, AxonEventView } from "@runloop/remote-agents-sdk/acp";
import type { ClaudeTimelineEvent, SDKControlRequest } from "@runloop/remote-agents-sdk/claude";
import type { ApprovalRequest, CodexTimelineEvent } from "@runloop/remote-agents-sdk/codex";
import type { PiTimelineEvent } from "@runloop/remote-agents-sdk/pi";

export type {
  AgentCapabilities,
  AvailableCommand,
  ClientCapabilities,
  Diff,
  ElicitationPropertySchema,
  ElicitationSchema,
  Implementation,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  SessionConfigOption,
  SessionInfo,
  SessionMode,
  Terminal,
  ToolCallStatus,
  ToolKind,
} from "@runloop/remote-agents-sdk/acp";
export type { ACPTimelineEvent, AxonEventView } from "@runloop/remote-agents-sdk/acp";
export type { ClaudeTimelineEvent } from "@runloop/remote-agents-sdk/claude";
export type { CodexTimelineEvent } from "@runloop/remote-agents-sdk/codex";
export type { PiTimelineEvent } from "@runloop/remote-agents-sdk/pi";

export type TimelineEvent =
  | ACPTimelineEvent
  | ClaudeTimelineEvent
  | CodexTimelineEvent
  | PiTimelineEvent;

export type AgentType = "claude" | "acp" | "codex" | "pi";

export type ConnectionPhase = "idle" | "connecting" | "ready" | "error";

// --- Attachment types ---

export type Attachment =
  | { type: "image"; data: string; mimeType: string; name: string; preview: string }
  | { type: "file"; name: string; text: string; mimeType: string };

export type AttachmentContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "file"; name: string; text: string; mimeType: string };

// --- Tool call types ---

export interface ToolCallLocation {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ContentItem {
  type: "content" | "diff" | "terminal";
  text?: string;
  diff?: Diff;
  terminal?: Terminal;
}

// --- Turn block types ---

export interface ThinkingBlock {
  type: "thinking";
  id: string;
  text: string;
  duration: number | null;
  isActive: boolean;
  extra?: Record<string, unknown>;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: ToolCallLocation[];
  content: ContentItem[];
  rawInput?: unknown;
  rawOutput?: unknown;
  startedAt: number;
  duration?: number | null;
  extra?: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  id: string;
  text: string;
  messageId?: string | null;
  extra?: Record<string, unknown>;
}

export interface PlanBlock {
  type: "plan";
  id: string;
  entries: PlanEntry[];
  extra?: Record<string, unknown>;
}

export interface TaskBlock {
  type: "task";
  id: string;
  taskId: string;
  description: string;
  status: "started" | "in_progress" | "completed" | "failed" | "stopped";
  summary?: string;
  toolUses?: number;
  extra?: Record<string, unknown>;
}

export interface ResourceLinkBlock {
  type: "resource_link";
  id: string;
  uri: string;
  name?: string | null;
  title?: string | null;
  extra?: Record<string, unknown>;
}

export interface ImageBlock {
  type: "image";
  id: string;
  data: string;
  mimeType: string;
  uri?: string | null;
  extra?: Record<string, unknown>;
}

export interface AudioBlock {
  type: "audio";
  id: string;
  data: string;
  mimeType: string;
  extra?: Record<string, unknown>;
}

export interface EmbeddedResourceBlock {
  type: "resource";
  id: string;
  uri: string;
  mimeType?: string | null;
  text?: string;
  blob?: string;
  extra?: Record<string, unknown>;
}

// --- System init block (unified agent initialization) ---

export interface ClaudeInitExtensions {
  protocol: "claude";
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  permissionMode: string;
}

export interface ACPInitExtensions {
  protocol: "acp";
  protocolVersion: number | null;
  modes: SessionMode[];
  models: ModelInfo[];
  configOptions: SessionConfigOption[];
  agentCapabilities: AgentCapabilities | null;
  clientCapabilities: ClientCapabilities | null;
  authMethods: unknown[];
}

export interface CodexInitExtensions {
  protocol: "codex";
  threadId: string | null;
  modelProvider: string | null;
  cwd: string | null;
}

export interface PiInitExtensions {
  protocol: "pi";
  sessionId: string | null;
  sessionFile: string | null;
  thinkingLevel: string | null;
}

export interface SystemInitBlock {
  type: "system_init";
  id: string;
  agentName: string | null;
  agentVersion: string | null;
  model: string | null;
  commands: string[];
  extensions:
    | ClaudeInitExtensions
    | ACPInitExtensions
    | CodexInitExtensions
    | PiInitExtensions
    | null;
  extra: Record<string, unknown>;
}

export type TurnBlock =
  | ThinkingBlock
  | ToolCallBlock
  | TextBlock
  | PlanBlock
  | TaskBlock
  | ResourceLinkBlock
  | ImageBlock
  | AudioBlock
  | EmbeddedResourceBlock
  | SystemInitBlock;

// --- Chat message ---

export interface UserAttachment {
  type: "image" | "file";
  name?: string;
  data?: string;
  mimeType?: string;
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: UserAttachment[];
  blocks?: TurnBlock[];
  stopReason?: string;
  cost?: number;
  numTurns?: number;
  durationMs?: number;
}

export interface AgentStartedPayload {
  agentType: string;
  agentId: string;
  model?: string;
  agentBinary?: string;
  blueprintName?: string;
  launchArgs?: string[];
  launchCommands?: string[];
  systemPrompt?: string;
  autoApprovePermissions?: boolean;
  dangerouslySkipPermissions?: boolean;
  [key: string]: unknown;
}

export interface AgentConfigItem {
  id: string;
  role: "system";
  itemType: "agent_started";
  config: AgentStartedPayload;
}

export interface SystemEventItem {
  id: string;
  role: "system";
  itemType: "system_event";
  eventKind: "devbox_lifecycle" | "agent_error";
  label: string;
  detail?: string;
  timestamp: number;
}

export type ChatItem = ChatMessage | AgentConfigItem | SystemEventItem;

export function isSystemEventItem(item: ChatItem): item is SystemEventItem {
  return item.role === "system" && "itemType" in item && item.itemType === "system_event";
}

export function isErrorSystemEvent(item: SystemEventItem): boolean {
  return item.eventKind === "agent_error";
}

export function isAgentConfigItem(item: ChatItem): item is AgentConfigItem {
  return item.role === "system" && "itemType" in item && item.itemType === "agent_started";
}

export function isChatMessage(item: ChatItem): item is ChatMessage {
  return item.role !== "system";
}

// --- Usage ---

export interface UsageState {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  size?: number;
  used?: number;
  cost?: number | null;
}

// --- Claude-specific: control request ---

export interface ControlRequestOption {
  label: string;
  description?: string;
}

export interface ControlRequestQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: ControlRequestOption[];
}

export interface PendingControlRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  questions: ControlRequestQuestion[];
  rawRequest: SDKControlRequest;
}

// --- ACP-specific: permission ---

export interface PendingPermission {
  requestId: string;
  toolTitle: string;
  toolKind: string;
  toolCallId: string;
  rawInput?: unknown;
  options: PermissionOption[];
}

// --- Codex-specific: approval request ---

export interface PendingApproval {
  requestId: string;
  method: string;
  summary: string;
  rawRequest: ApprovalRequest;
}

// --- Codex-specific: question tool (item/tool/requestUserInput) ---

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

export interface PendingUserInput {
  requestId: string;
  questions: UserInputQuestion[];
}

// --- ACP-specific: elicitation ---

export interface PendingElicitation {
  requestId: string;
  message: string;
  mode: "form" | "url";
  schema?: ElicitationSchema;
  url?: string;
}

// --- ACP-specific: agent info ---

export type AgentInfo = Implementation;

export interface ConnectionDetails {
  protocolVersion: number | null;
  agentCapabilities: AgentCapabilities | null;
  clientCapabilities: ClientCapabilities | null;
  sessionMeta: Record<string, unknown> | null;
}

// --- Claude-specific: init info ---

export interface InitInfo {
  model: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  permissionMode: string;
  slashCommands: string[];
}

// --- Sidebar types ---

export interface ToolActivity {
  toolCallId: string;
  kind: string;
  title: string;
  status: string;
  command?: string;
  output?: string;
  timestamp: number;
}

export interface FileOp {
  id: string;
  type: "read" | "write";
  path: string;
  detail: string;
  timestamp: number;
}

export interface TerminalState {
  terminalId: string;
  command: string;
  output: string;
  exited: boolean;
  timestamp: number;
}


// --- Unified hook return type (discriminated union) ---

export interface SharedAgentState {
  connectionPhase: ConnectionPhase;
  connectionStatus: string | null;
  error: string | null;
  messages: ChatItem[];
  currentTurnBlocks: TurnBlock[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  isSendingPrompt: boolean;
  usage: UsageState | null;
  autoApprovePermissions: boolean;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  axonEvents: AxonEventView[];
  timelineEvents: TimelineEvent[];
  availableCommands: AvailableCommand[];

  sendMessage: (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => Promise<void>;
  cancel: () => Promise<void>;
  shutdown: () => Promise<void>;
  setAutoApprovePermissions: (enabled: boolean) => Promise<void>;
}

export interface ClaudeAgentState extends SharedAgentState {
  agentType: "claude";
  initInfo: InitInfo | null;
  permissionMode: string | null;
  currentModel: string | null;
  pendingControlRequest: PendingControlRequest | null;
  setModel: (model: string) => Promise<void>;
  setPermissionMode: (mode: string) => Promise<void>;
  sendControlResponse: (requestId: string, response: { behavior: string; updatedInput?: unknown }) => Promise<void>;
}

export interface ACPAgentState extends SharedAgentState {
  agentType: "acp";
  plan: PlanEntry[] | null;
  toolActivity: ToolActivity[];
  fileOps: FileOp[];
  terminals: Map<string, TerminalState>;
  currentMode: string | null;
  availableModes: SessionMode[];
  configOptions: SessionConfigOption[];
  availableModels: ModelInfo[];
  currentModelId: string | null;
  pendingPermission: PendingPermission | null;
  pendingElicitation: PendingElicitation | null;
  agentInfo: AgentInfo | null;
  connectionDetails: ConnectionDetails;
  authMethods: unknown[];
  isAuthenticated: boolean;
  authDismissed: boolean;
  sessions: SessionInfo[];
  isLoadingSessions: boolean;
  sessionId: string | null;
  setMode: (modeId: string) => Promise<void>;
  setACPModel: (modelId: string) => Promise<void>;
  setConfigOption: (optionId: string, valueId: string) => Promise<void>;
  authenticate: (methodId: string) => Promise<void>;
  dismissAuth: () => void;
  respondToPermission: (requestId: string, optionId: string) => Promise<void>;
  cancelPermission: (requestId: string) => Promise<void>;
  respondToElicitation: (requestId: string, action: unknown) => Promise<void>;
  createNewSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

export interface CodexAgentState extends SharedAgentState {
  agentType: "codex";
  threadId: string | null;
  pendingApproval: PendingApproval | null;
  respondToApproval: (requestId: string, approve: boolean) => Promise<void>;
  pendingUserInput: PendingUserInput | null;
  respondToUserInput: (requestId: string, answers: Record<string, string[]>) => Promise<void>;
}

export interface PiAgentState extends SharedAgentState {
  agentType: "pi";
  sessionId: string | null;
  sessionFile: string | null;
}

export interface IdleAgentState extends SharedAgentState {
  agentType: null;
}

export type UseAgentReturn =
  | ClaudeAgentState
  | ACPAgentState
  | CodexAgentState
  | PiAgentState
  | IdleAgentState;

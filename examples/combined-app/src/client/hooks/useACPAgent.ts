import { useReducer, useRef, useCallback, useEffect } from "react";
import {
  isAgentMessageChunk,
  isAgentThoughtChunk,
  isToolCall,
  isToolCallProgress,
  isPlan,
  isUsageUpdate,
  isSessionInfoUpdate,
  isCurrentModeUpdate,
  isConfigOptionUpdate,
  isAvailableCommandsUpdate,
  isTextContent,
  isImageContent,
  isAudioContent,
  isResourceLinkContent,
  isEmbeddedResourceContent,
  isTurnStartedEvent,
  isTurnCompletedEvent,
  isSessionUpdateEvent,
  isInitializeEvent,
  isFromAgent,
  extractACPUserMessage,
} from "@runloop/remote-agents-sdk/acp";
import type { AuthMethod, ElicitationAction, SessionUpdate, ACPTimelineEvent, InitializeResponse } from "@runloop/remote-agents-sdk/acp";
import type { WsEvent } from "../../shared/ws-events.js";
import type {
  TurnBlock,
  ChatMessage,
  ChatItem,
  SystemEventItem,
  PlanEntry,
  UsageState,
  PendingPermission,
  PendingElicitation,
  ToolActivity,
  SessionMode,
  ModelInfo,
  AvailableCommand,
  SessionConfigOption,
  AgentInfo,
  AgentCapabilities,
  ConnectionDetails,
  ACPInitExtensions,
  SessionInfo,
  AxonEventView,
  ToolCallBlock,
  UserAttachment,
} from "../types.js";
import { parseToolCallContent, extractOutputText, nextBlockId } from "./parsers.js";
import { useBlockManager } from "./useBlockManager.js";
import { buildAgentConfigItem, buildSystemEventItem } from "./timeline-helpers.js";
import { api } from "./api.js";

const NORMAL_END_REASONS = new Set(["end_turn", "endturn", "end turn"]);
function isNormalEndTurn(reason: string): boolean {
  return NORMAL_END_REASONS.has(reason.toLowerCase());
}

export interface UseACPAgentReturn {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  messages: ChatItem[];
  currentTurnBlocks: TurnBlock[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  isSendingPrompt: boolean;
  usage: UsageState | null;
  plan: PlanEntry[] | null;
  toolActivity: ToolActivity[];
  currentMode: string | null;
  availableModes: SessionMode[];
  configOptions: SessionConfigOption[];
  availableModels: ModelInfo[];
  currentModelId: string | null;
  pendingPermission: PendingPermission | null;
  autoApprovePermissions: boolean;
  pendingElicitation: PendingElicitation | null;
  devboxId: string | null;
  axonId: string | null;
  sessionId: string | null;
  runloopUrl: string | null;
  agentInfo: AgentInfo | null;
  connectionDetails: ConnectionDetails;
  authMethods: AuthMethod[];
  isAuthenticated: boolean;
  authDismissed: boolean;
  availableCommands: AvailableCommand[];
  axonEvents: AxonEventView[];
  timelineEvents: ACPTimelineEvent[];
  sessions: SessionInfo[];
  isLoadingSessions: boolean;
  sendMessage: (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => Promise<void>;
  cancel: () => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setConfigOption: (optionId: string, valueId: string) => Promise<void>;
  authenticate: (methodId: string) => Promise<void>;
  dismissAuth: () => void;
  respondToPermission: (requestId: string, optionId: string) => Promise<void>;
  cancelPermission: (requestId: string) => Promise<void>;
  setAutoApprovePermissions: (enabled: boolean) => Promise<void>;
  respondToElicitation: (requestId: string, action: ElicitationAction) => Promise<void>;
  shutdown: () => Promise<void>;
  createNewSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const EMPTY_CONNECTION_DETAILS: ConnectionDetails = {
  protocolVersion: null, agentCapabilities: null, clientCapabilities: null, sessionMeta: null,
};

interface ACPState {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  isSendingPrompt: boolean;
  messages: ChatItem[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  plan: PlanEntry[] | null;
  toolActivity: ToolActivity[];
  usage: UsageState | null;
  axonEvents: AxonEventView[];
  timelineEvents: ACPTimelineEvent[];
  devboxId: string | null;
  axonId: string | null;
  sessionId: string | null;
  runloopUrl: string | null;
  agentInfo: AgentInfo | null;
  connectionDetails: ConnectionDetails;
  authMethods: AuthMethod[];
  isAuthenticated: boolean;
  authDismissed: boolean;
  pendingPermission: PendingPermission | null;
  autoApprovePermissions: boolean;
  pendingElicitation: PendingElicitation | null;
  sessions: SessionInfo[];
  isLoadingSessions: boolean;
  currentMode: string | null;
  availableModes: SessionMode[];
  configOptions: SessionConfigOption[];
  availableModels: ModelInfo[];
  currentModelId: string | null;
  availableCommands: AvailableCommand[];
}

const INITIAL_ACP_STATE: ACPState = {
  connectionPhase: "idle",
  connectionStatus: null,
  error: null,
  isSendingPrompt: false,
  messages: [],
  isAgentTurn: false,
  isStreaming: false,
  plan: null,
  toolActivity: [],
  usage: null,
  axonEvents: [],
  timelineEvents: [],
  devboxId: null,
  axonId: null,
  sessionId: null,
  runloopUrl: null,
  agentInfo: null,
  connectionDetails: EMPTY_CONNECTION_DETAILS,
  authMethods: [],
  isAuthenticated: false,
  authDismissed: false,
  pendingPermission: null,
  autoApprovePermissions: true,
  pendingElicitation: null,
  sessions: [],
  isLoadingSessions: false,
  currentMode: null,
  availableModes: [],
  configOptions: [],
  availableModels: [],
  currentModelId: null,
  availableCommands: [],
};

type ACPAction =
  | { type: "RESET" }
  | { type: "SET"; patch: Partial<ACPState> }
  | { type: "APPEND_MESSAGE"; message: ChatItem }
  | { type: "APPEND_TIMELINE_EVENT"; event: ACPTimelineEvent }
  | { type: "UPDATE_TOOL_ACTIVITY"; updater: (prev: ToolActivity[]) => ToolActivity[] }
  | { type: "UPDATE_SESSIONS"; updater: (prev: SessionInfo[]) => SessionInfo[] };

function acpReducer(state: ACPState, action: ACPAction): ACPState {
  switch (action.type) {
    case "RESET":
      return INITIAL_ACP_STATE;
    case "SET":
      return { ...state, ...action.patch };
    case "APPEND_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "APPEND_TIMELINE_EVENT":
      return {
        ...state,
        timelineEvents: [...state.timelineEvents, action.event],
        axonEvents: [...state.axonEvents, action.event.axonEvent],
      };
    case "UPDATE_TOOL_ACTIVITY":
      return { ...state, toolActivity: action.updater(state.toolActivity) };
    case "UPDATE_SESSIONS":
      return { ...state, sessions: action.updater(state.sessions) };
  }
}

export function useACPAgent(agentId: string | null): UseACPAgentReturn {
  const [s, dispatch] = useReducer(acpReducer, INITIAL_ACP_STATE);
  const blocks = useBlockManager();
  const lastStopReasonRef = useRef<string | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);

  function resetAllState() {
    blocks.reset();
    lastStopReasonRef.current = undefined;
    dispatch({ type: "RESET" });
  }

  function flushBlocksToMessages(stopReason?: string) {
    const extra = stopReason && !isNormalEndTurn(stopReason) ? { stopReason } : {};
    const msg = blocks.flushToMessage(extra);
    if (msg) {
      dispatch({ type: "APPEND_MESSAGE", message: msg });
    }
  }

  function applySessionResponse(resp: Record<string, unknown>) {
    const patch: Partial<ACPState> = {};
    const modes = resp.modes as { availableModes?: SessionMode[]; currentModeId?: string } | undefined;
    if (modes?.availableModes) patch.availableModes = modes.availableModes;
    if (modes?.currentModeId) patch.currentMode = modes.currentModeId;
    const opts = resp.configOptions as SessionConfigOption[] | undefined;
    if (opts) patch.configOptions = opts;
    const models = resp.models as { availableModels?: ModelInfo[]; currentModelId?: string } | undefined;
    if (models?.availableModels) patch.availableModels = models.availableModels;
    if (models?.currentModelId) patch.currentModelId = models.currentModelId;
    if (Object.keys(patch).length > 0) dispatch({ type: "SET", patch });
  }

  function handleSessionUpdate(update: SessionUpdate, eventSessionId: string | null) {
    if (isAgentMessageChunk(update)) {
      blocks.finalizeThinking();
      const { content, messageId = null } = update;
      if (isResourceLinkContent(content)) {
        blocks.pushBlock({
          type: "resource_link",
          id: nextBlockId("rl"),
          uri: content.uri,
          name: content.name ?? null,
          title: content.title ?? null,
        });
        return;
      }
      if (isImageContent(content)) {
        blocks.pushBlock({
          type: "image",
          id: nextBlockId("img"),
          data: content.data,
          mimeType: content.mimeType,
          uri: null,
        });
        return;
      }
      if (isAudioContent(content)) {
        blocks.pushBlock({
          type: "audio",
          id: nextBlockId("aud"),
          data: content.data,
          mimeType: content.mimeType,
        });
        return;
      }
      if (isEmbeddedResourceContent(content)) {
        const res = content.resource;
        blocks.pushBlock({
          type: "resource",
          id: nextBlockId("res"),
          uri: res.uri,
          mimeType: res.mimeType ?? null,
          text: "text" in res ? res.text as string : undefined,
          blob: "blob" in res ? res.blob as string : undefined,
        });
        return;
      }
      const text = isTextContent(content) ? content.text : "";
      const last = blocks.lastBlock();
      if (last?.type === "text") {
        blocks.updateBlocks((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...last, text: last.text + text };
          return copy;
        });
      } else {
        blocks.pushBlock({ type: "text", id: nextBlockId("txt"), text, messageId });
      }
      dispatch({ type: "SET", patch: { isStreaming: true } });
      return;
    }

    if (isAgentThoughtChunk(update)) {
      const { content } = update;
      const text = isTextContent(content) ? content.text : "";
      const last = blocks.lastBlock();
      if (last?.type === "thinking" && last.isActive) {
        blocks.updateBlocks((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...last, text: last.text + text };
          return copy;
        });
      } else {
        if (!blocks.thinkingStartRef.current) blocks.thinkingStartRef.current = Date.now();
        blocks.pushBlock({ type: "thinking", id: nextBlockId("think"), text, duration: null, isActive: true });
      }
      return;
    }

    if (isToolCall(update)) {
      blocks.finalizeThinking();
      const { toolCallId, title, rawInput, rawOutput } = update;
      const kind = update.kind ?? "other";
      const status = update.status ?? "pending";
      const locations = update.locations ?? [];
      const contentItems = update.content ? parseToolCallContent(update.content) : [];

      blocks.pushBlock({
        type: "tool_call",
        id: nextBlockId("tc"),
        toolCallId,
        title,
        kind,
        status,
        locations,
        content: contentItems,
        rawInput,
        rawOutput,
        startedAt: Date.now(),
        duration: null,
      });

      const command = rawInput && typeof rawInput === "object"
        ? ((rawInput as Record<string, unknown>).command as string | undefined)
        : undefined;
      dispatch({ type: "UPDATE_TOOL_ACTIVITY", updater: (prev) => {
        if (prev.some((a) => a.toolCallId === toolCallId)) return prev;
        return [...prev, { toolCallId, kind, title, status, command, timestamp: Date.now() }];
      } });
      return;
    }

    if (isToolCallProgress(update)) {
      const { toolCallId, rawInput, rawOutput, status: newStatus, title: newTitle, kind: newKind, locations: newLocations } = update;
      const newContentItems = update.content ? parseToolCallContent(update.content) : undefined;

      blocks.updateBlocks((prev) =>
        prev.map((b) => {
          if (b.type !== "tool_call" || b.toolCallId !== toolCallId) return b;
          const tc = b as ToolCallBlock;
          const isFinishing =
            (newStatus === "completed" || newStatus === "failed") &&
            tc.status !== "completed" && tc.status !== "failed";
          return {
            ...tc,
            status: newStatus ?? tc.status,
            title: newTitle ?? tc.title,
            kind: newKind ?? tc.kind,
            locations: newLocations ?? tc.locations,
            content: newContentItems ?? tc.content,
            rawInput: rawInput ?? tc.rawInput,
            rawOutput: rawOutput ?? tc.rawOutput,
            duration: isFinishing
              ? Math.round((Date.now() - tc.startedAt) / 1000 * 10) / 10
              : tc.duration,
          };
        }),
      );

      const command = rawInput && typeof rawInput === "object"
        ? ((rawInput as Record<string, unknown>).command as string | undefined)
        : undefined;
      const outputText = newContentItems ? extractOutputText(newContentItems, rawOutput) : undefined;
      dispatch({ type: "UPDATE_TOOL_ACTIVITY", updater: (prev) =>
        prev.map((a) =>
          a.toolCallId === toolCallId
            ? { ...a, status: newStatus ?? a.status, command: command ?? a.command, output: outputText ?? a.output }
            : a,
        ),
      });
      return;
    }

    if (isPlan(update)) {
      const { entries } = update;
      dispatch({ type: "SET", patch: { plan: entries } });
      const existingPlan = blocks.blocksRef.current.find((b) => b.type === "plan");
      if (existingPlan) {
        blocks.updateBlocks((prev) =>
          prev.map((b) => b.type === "plan" ? { ...b, entries } : b),
        );
      } else {
        blocks.pushBlock({ type: "plan", id: nextBlockId("plan"), entries });
      }
      return;
    }

    if (isCurrentModeUpdate(update)) {
      dispatch({ type: "SET", patch: { currentMode: update.currentModeId } });
    } else if (isConfigOptionUpdate(update)) {
      dispatch({ type: "SET", patch: { configOptions: update.configOptions } });
    } else if (isAvailableCommandsUpdate(update)) {
      dispatch({ type: "SET", patch: { availableCommands: update.availableCommands } });
    }

    if (isUsageUpdate(update)) {
      const { size, used, cost } = update;
      dispatch({ type: "SET", patch: { usage: { size, used, cost: cost?.amount ?? null } } });
    }

    if (isSessionInfoUpdate(update)) {
      if (update.title) {
        dispatch({ type: "UPDATE_SESSIONS", updater: (prev) =>
          prev.map((sess) =>
            sess.sessionId === eventSessionId ? { ...sess, title: update.title, updatedAt: update.updatedAt } : sess,
          ),
        });
      }
    }
  }

  function handleTimelineEvent(tlEvent: ACPTimelineEvent): void {
    dispatch({ type: "APPEND_TIMELINE_EVENT", event: tlEvent });

    const userMsg = extractACPUserMessage(tlEvent.data, tlEvent.axonEvent);
    if (userMsg) {
      flushBlocksToMessages(lastStopReasonRef.current);
      lastStopReasonRef.current = undefined;

      const attachments: UserAttachment[] = [];
      for (const block of userMsg.content) {
        if (block.type === "image" && "data" in block && "mimeType" in block) {
          attachments.push({
            type: "image",
            data: (block as { data: string }).data,
            mimeType: (block as { mimeType: string }).mimeType,
          });
        }
      }

      dispatch({ type: "APPEND_MESSAGE", message: {
        id: `user-${userMsg.sequence}`,
        role: "user" as const,
        content: userMsg.text,
        ...(attachments.length > 0 ? { attachments } : {}),
      } });
      return;
    }

    if (isTurnStartedEvent(tlEvent)) {
      dispatch({ type: "SET", patch: { isAgentTurn: true, isStreaming: false } });
      return;
    }
    if (isTurnCompletedEvent(tlEvent)) {
      // A completed turn can no longer be answered, so drop any prompt (an
      // elicitation question or permission request) that is still pending.
      dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false, pendingElicitation: null, pendingPermission: null } });
      lastStopReasonRef.current = tlEvent.data.stopReason;
      return;
    }

    if (isSessionUpdateEvent(tlEvent)) {
      const notification = tlEvent.data;
      const eventSessionId = notification.sessionId ?? null;
      const inner = notification.update;
      if (inner && typeof inner === "object") {
        handleSessionUpdate(inner, eventSessionId);
      }
      return;
    }
    if (isInitializeEvent(tlEvent) && isFromAgent(tlEvent)) {
      const payload = tlEvent.data as InitializeResponse;
      const info = payload.agentInfo ?? null;
      const caps = payload.agentCapabilities ?? null;
      const protoVer = payload.protocolVersion ?? null;
      const authMeta = (payload as Record<string, unknown>).authMethods as unknown[] ?? [];

      dispatch({ type: "SET", patch: {
        agentInfo: info as AgentInfo | null,
        connectionDetails: { protocolVersion: protoVer, agentCapabilities: caps, clientCapabilities: null, sessionMeta: null },
        authMethods: authMeta as AuthMethod[],
      } });

      blocks.pushBlock({
        type: "system_init",
        id: nextBlockId("init"),
        agentName: info?.name ?? null,
        agentVersion: info?.version ?? null,
        model: null,
        commands: [],
        extensions: {
          protocol: "acp",
          protocolVersion: protoVer,
          modes: [],
          models: [],
          configOptions: [],
          agentCapabilities: caps,
          clientCapabilities: null,
          authMethods: authMeta,
        } satisfies ACPInitExtensions,
        extra: payload as Record<string, unknown>,
      });
      return;
    }

    const sysItem = buildSystemEventItem(tlEvent);
    if (sysItem) {
      flushBlocksToMessages(lastStopReasonRef.current);
      lastStopReasonRef.current = undefined;
      dispatch({ type: "APPEND_MESSAGE", message: sysItem });
      return;
    }

    const agentConfig = buildAgentConfigItem(tlEvent);
    if (agentConfig) {
      dispatch({ type: "APPEND_MESSAGE", message: agentConfig });
      return;
    }
  }

  useEffect(() => {
    resetAllState();

    if (!agentId) {
      wsRef.current?.close();
      wsRef.current = null;
      dispatch({ type: "SET", patch: { connectionPhase: "idle" } });
      return;
    }

    dispatch({ type: "SET", patch: { connectionPhase: "connecting" } });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    socket.onmessage = (ev) => {
      let data: WsEvent;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.agentId !== agentId) return;

      if (data.type === "timeline_event") {
        handleTimelineEvent(data.event as ACPTimelineEvent);
        return;
      }

      if (data.type === "connection_progress") {
        dispatch({ type: "SET", patch: { connectionStatus: data.step } });
        return;
      }

      if (data.type === "turn_error") {
        flushBlocksToMessages();
        dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false, pendingElicitation: null, pendingPermission: null, error: data.error ?? "Turn failed" } });
        return;
      }

      if (data.type === "permission_request") {
        const { requestId, request } = data as { requestId: string; request: Record<string, unknown> };
        const toolCall = request.toolCall as Record<string, unknown> | undefined;
        dispatch({ type: "SET", patch: { pendingPermission: {
          requestId,
          toolTitle: (toolCall?.title as string) ?? "unknown",
          toolKind: (toolCall?.kind as string) ?? "other",
          toolCallId: (toolCall?.toolCallId as string) ?? "",
          rawInput: toolCall?.rawInput,
          options: request.options as PendingPermission["options"],
        } } });
        return;
      }

      if (data.type === "permission_dismissed") {
        dispatch({ type: "SET", patch: { pendingPermission: null } });
        return;
      }

      if (data.type === "elicitation_request") {
        const { request, requestId } = data as { request: Record<string, unknown>; requestId: string };
        dispatch({ type: "SET", patch: { pendingElicitation: {
          requestId,
          message: request.message as string,
          mode: request.mode as "form" | "url",
          schema: request.mode === "form"
            ? request.requestedSchema as PendingElicitation["schema"]
            : undefined,
          url: request.mode === "url" ? request.url as string : undefined,
        } } });
        return;
      }

      if (data.type === "elicitation_dismissed") {
        dispatch({ type: "SET", patch: { pendingElicitation: null } });
        return;
      }
    };

    socket.onopen = () => {
      dispatch({ type: "SET", patch: { connectionPhase: "ready" } });
      api("/api/subscribe", { agentId }).catch(() => {});
    };

    socket.onclose = () => { wsRef.current = null; };

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [agentId]);

  const sendMessage = useCallback(async (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => {
    if (!text.trim() && (!content || content.length === 0)) return;

    flushBlocksToMessages(lastStopReasonRef.current);
    lastStopReasonRef.current = undefined;
    blocks.reset();
    dispatch({ type: "SET", patch: { isAgentTurn: true, isStreaming: false, isSendingPrompt: true } });

    try {
      if (content && content.length > 0) {
        await api("/api/prompt", { agentId, content });
      } else {
        await api("/api/prompt", { agentId, text });
      }
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    } finally {
      dispatch({ type: "SET", patch: { isSendingPrompt: false } });
    }
  }, [agentId]);

  const cancel = useCallback(async () => {
    try { await api("/api/cancel", { agentId }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setMode = useCallback(async (modeId: string) => {
    dispatch({ type: "SET", patch: { currentMode: modeId } });
    try { await api("/api/set-mode", { agentId, modeId }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setModel = useCallback(async (modelId: string) => {
    dispatch({ type: "SET", patch: { currentModelId: modelId } });
    try { await api("/api/set-model", { agentId, modelId }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setConfigOption = useCallback(async (optionId: string, valueId: string) => {
    try {
      const resp = await api<{ configOptions?: SessionConfigOption[] }>("/api/set-config-option", { agentId, configId: optionId, value: valueId });
      if (resp.configOptions) dispatch({ type: "SET", patch: { configOptions: resp.configOptions } });
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const authenticate = useCallback(async (methodId: string) => {
    try { await api("/api/authenticate", { agentId, methodId }); dispatch({ type: "SET", patch: { isAuthenticated: true } }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const dismissAuth = useCallback(() => { dispatch({ type: "SET", patch: { authDismissed: true } }); }, []);

  const respondToPermission = useCallback(async (requestId: string, optionId: string) => {
    dispatch({ type: "SET", patch: { pendingPermission: null } });
    try {
      await api("/api/permission-response", { agentId, requestId, outcome: { outcome: "selected", optionId } });
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const cancelPermission = useCallback(async (requestId: string) => {
    dispatch({ type: "SET", patch: { pendingPermission: null } });
    try {
      await api("/api/permission-response", { agentId, requestId, outcome: { outcome: "cancelled" } });
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setAutoApprovePermissions = useCallback(async (enabled: boolean) => {
    dispatch({ type: "SET", patch: { autoApprovePermissions: enabled } });
    try { await api("/api/set-auto-approve-permissions", { agentId, enabled }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const respondToElicitation = useCallback(async (requestId: string, action: ElicitationAction) => {
    dispatch({ type: "SET", patch: { pendingElicitation: null } });
    try { await api("/api/elicitation-response", { agentId, requestId, action }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const createNewSession = useCallback(async () => {
    try {
      const resp = await api<{ sessionId: string; modes?: unknown; configOptions?: unknown }>("/api/new-session", { agentId });
      dispatch({ type: "SET", patch: { sessionId: resp.sessionId } });
      applySessionResponse(resp as Record<string, unknown>);
      dispatch({ type: "UPDATE_SESSIONS", updater: (prev) => {
        if (prev.some((sess) => sess.sessionId === resp.sessionId)) return prev;
        return [...prev, { sessionId: resp.sessionId, cwd: "." }];
      } });
      resetAllState();
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const switchSession = useCallback(async (targetSessionId: string) => {
    try {
      const resp = await api<Record<string, unknown>>("/api/switch-session", { agentId, sessionId: targetSessionId });
      dispatch({ type: "SET", patch: { sessionId: targetSessionId } });
      applySessionResponse(resp);
      resetAllState();
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const refreshSessions = useCallback(async () => {
    dispatch({ type: "SET", patch: { isLoadingSessions: true } });
    try {
      const resp = await api<{ sessions?: SessionInfo[] }>(`/api/sessions?agentId=${agentId}`);
      if (resp.sessions) dispatch({ type: "SET", patch: { sessions: resp.sessions, isLoadingSessions: false } });
      else dispatch({ type: "SET", patch: { isLoadingSessions: false } });
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err), isLoadingSessions: false } });
    }
  }, [agentId]);

  const shutdown = useCallback(async () => {
    try { await api("/api/shutdown", { agentId }); } catch { /* ignore */ }
    wsRef.current?.close();
    wsRef.current = null;
    dispatch({ type: "SET", patch: { connectionPhase: "idle" } });
    resetAllState();
  }, [agentId]);

  return {
    connectionPhase: s.connectionPhase, connectionStatus: s.connectionStatus, error: s.error,
    messages: s.messages, currentTurnBlocks: blocks.currentTurnBlocks, isAgentTurn: s.isAgentTurn, isStreaming: s.isStreaming, isSendingPrompt: s.isSendingPrompt,
    usage: s.usage, plan: s.plan, toolActivity: s.toolActivity,
    currentMode: s.currentMode, availableModes: s.availableModes, configOptions: s.configOptions, availableModels: s.availableModels, currentModelId: s.currentModelId,
    pendingPermission: s.pendingPermission, autoApprovePermissions: s.autoApprovePermissions, pendingElicitation: s.pendingElicitation,
    devboxId: s.devboxId, axonId: s.axonId, sessionId: s.sessionId, runloopUrl: s.runloopUrl,
    agentInfo: s.agentInfo, connectionDetails: s.connectionDetails, authMethods: s.authMethods, isAuthenticated: s.isAuthenticated, authDismissed: s.authDismissed,
    availableCommands: s.availableCommands, axonEvents: s.axonEvents, timelineEvents: s.timelineEvents, sessions: s.sessions, isLoadingSessions: s.isLoadingSessions,
    sendMessage, cancel,
    setMode, setModel, setConfigOption,
    authenticate, dismissAuth,
    respondToPermission, cancelPermission, setAutoApprovePermissions,
    respondToElicitation, shutdown,
    createNewSession, switchSession, refreshSessions,
  };
}

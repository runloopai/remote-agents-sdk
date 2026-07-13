import { useReducer, useRef, useCallback, useEffect } from "react";
import {
  extractClaudeUserMessage,
  isClaudeProtocolEvent,
  isTurnStartedEvent,
  isTurnCompletedEvent,
} from "@runloop/remote-agents-sdk/claude";
import type { ClaudeTimelineEvent, SDKControlRequest, ControlRequestOfSubtype } from "@runloop/remote-agents-sdk/claude";
import type { WsEvent } from "../../shared/ws-events.js";
import type {
  TurnBlock,
  ChatMessage,
  ChatItem,
  UsageState,
  InitInfo,
  PendingControlRequest,
  ControlRequestQuestion,
  TaskBlock,
  PlanEntry,
  AxonEventView,
  ToolCallBlock,
  ClaudeInitExtensions,
} from "../types.js";
import { nextBlockId, inferToolKind } from "./parsers.js";
import { useBlockManager } from "./useBlockManager.js";
import { buildAgentConfigItem, buildSystemEventItem, extractImageAttachments } from "./timeline-helpers.js";
import { api } from "./api.js";

export interface UseClaudeAgentReturn {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  messages: ChatItem[];
  currentTurnBlocks: TurnBlock[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  isSendingPrompt: boolean;
  usage: UsageState | null;
  initInfo: InitInfo | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  permissionMode: string | null;
  currentModel: string | null;
  axonEvents: AxonEventView[];
  timelineEvents: ClaudeTimelineEvent[];
  autoApprovePermissions: boolean;
  pendingControlRequest: PendingControlRequest | null;
  sendMessage: (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => Promise<void>;
  cancel: () => Promise<void>;
  setAutoApprovePermissions: (enabled: boolean) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setPermissionMode: (mode: string) => Promise<void>;
  sendControlResponse: (requestId: string, response: { behavior: string; updatedInput?: unknown }) => Promise<void>;
  shutdown: () => Promise<void>;
}

interface ClaudeState {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  isSendingPrompt: boolean;
  messages: ChatItem[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  usage: UsageState | null;
  initInfo: InitInfo | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  permissionMode: string | null;
  currentModel: string | null;
  pendingControlRequest: PendingControlRequest | null;
  autoApprovePermissions: boolean;
  axonEvents: AxonEventView[];
  timelineEvents: ClaudeTimelineEvent[];
}

const INITIAL_CLAUDE_STATE: ClaudeState = {
  connectionPhase: "idle",
  connectionStatus: null,
  error: null,
  isSendingPrompt: false,
  messages: [],
  isAgentTurn: false,
  isStreaming: false,
  usage: null,
  initInfo: null,
  devboxId: null,
  axonId: null,
  runloopUrl: null,
  permissionMode: null,
  currentModel: null,
  pendingControlRequest: null,
  autoApprovePermissions: true,
  axonEvents: [],
  timelineEvents: [],
};

type ClaudeAction =
  | { type: "RESET" }
  | { type: "SET"; patch: Partial<ClaudeState> }
  | { type: "APPEND_MESSAGE"; message: ChatItem }
  | { type: "APPEND_TIMELINE_EVENT"; event: ClaudeTimelineEvent }
  | { type: "MERGE_USAGE"; delta: Partial<UsageState> };

function claudeReducer(state: ClaudeState, action: ClaudeAction): ClaudeState {
  switch (action.type) {
    case "RESET":
      return INITIAL_CLAUDE_STATE;
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
    case "MERGE_USAGE":
      return {
        ...state,
        usage: {
          inputTokens: action.delta.inputTokens ?? state.usage?.inputTokens ?? 0,
          outputTokens: action.delta.outputTokens ?? state.usage?.outputTokens ?? 0,
          cacheCreationInputTokens: action.delta.cacheCreationInputTokens ?? state.usage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: action.delta.cacheReadInputTokens ?? state.usage?.cacheReadInputTokens ?? 0,
        },
      };
  }
}

export function useClaudeAgent(agentId: string | null): UseClaudeAgentReturn {
  const [s, dispatch] = useReducer(claudeReducer, INITIAL_CLAUDE_STATE);
  const blocks = useBlockManager();
  const wsRef = useRef<WebSocket | null>(null);
  const activeBlockIndexRef = useRef<Map<number, string>>(new Map());
  const initInfoRef = useRef<InitInfo | null>(null);

  function resetAllState() {
    blocks.reset();
    activeBlockIndexRef.current.clear();
    initInfoRef.current = null;
    dispatch({ type: "RESET" });
  }

  function finalizeTurn(stopReason?: string, cost?: number, numTurns?: number, durationMs?: number) {
    const extra: Record<string, unknown> = {};
    if (stopReason) extra.stopReason = stopReason;
    if (cost != null) extra.cost = cost;
    if (numTurns != null) extra.numTurns = numTurns;
    if (durationMs != null) extra.durationMs = durationMs;

    const msg = blocks.flushToMessage(extra);
    if (msg) {
      dispatch({ type: "APPEND_MESSAGE", message: msg });
    }
    activeBlockIndexRef.current.clear();
    // A completed turn can no longer be answered, so drop any prompt (e.g. an
    // AskUserQuestion elicitation) that is still pending.
    dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false, pendingControlRequest: null } });
  }

  function handleSDKMessage(msg: Record<string, unknown>): void {
    const msgType = msg.type as string;

    switch (msgType) {
      case "stream_event": {
        const event = msg.event as Record<string, unknown>;
        if (event) handleStreamEvent(event);
        break;
      }
      case "user":
        handleUserMessage(msg);
        break;
      case "assistant":
        handleAssistantMessage(msg);
        break;
      case "result":
        handleResult(msg);
        break;
      case "system":
        handleSystemMessage(msg);
        break;
      case "control_request":
        handleControlRequest(msg as unknown as SDKControlRequest);
        break;
      case "control_response":
        dispatch({ type: "SET", patch: { pendingControlRequest: null } });
        break;
      case "tool_progress": {
        const toolUseId = msg.tool_use_id as string;
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.type === "tool_call" && b.toolCallId === toolUseId
              ? { ...b, status: "in_progress" as const }
              : b,
          ),
        );
        break;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info as Record<string, unknown>;
        if (info?.status === "rejected") {
          dispatch({ type: "SET", patch: { error: `Rate limited. Resets at: ${info.resetsAt}` } });
        }
        break;
      }
    }
  }

  function handleUserMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown>;
    if (!message) return;
    const content = message.content as Array<Record<string, unknown>>;
    if (!Array.isArray(content)) return;

    const toolUseResult = msg.tool_use_result as Record<string, unknown> | undefined;
    if (toolUseResult?.newTodos) {
      const newTodos = toolUseResult.newTodos as Array<Record<string, unknown>>;
      const entries: PlanEntry[] = newTodos.map((t) => ({
        content: (t.content as string) ?? "",
        status: (t.status as PlanEntry["status"]) ?? "pending",
        priority: (t.priority as PlanEntry["priority"]) ?? "medium",
      }));

      const existingPlan = blocks.blocksRef.current.find((b) => b.type === "plan");
      if (existingPlan) {
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.type === "plan" ? { ...b, entries } : b,
          ),
        );
      } else {
        blocks.pushBlock({ type: "plan", id: nextBlockId("plan"), entries });
      }
    }

    for (const block of content) {
      if (block.type === "tool_result") {
        const toolUseId = block.tool_use_id as string;
        const resultContent = block.content as unknown;
        let outputText = "";
        if (typeof resultContent === "string") {
          outputText = resultContent;
        } else if (Array.isArray(resultContent)) {
          outputText = resultContent
            .filter((c: Record<string, unknown>) => c.type === "text")
            .map((c: Record<string, unknown>) => c.text as string)
            .join("\n");
        }
        const isError = block.is_error === true;

        blocks.updateBlocks((prev) =>
          prev.map((b) => {
            if (b.type !== "tool_call" || b.toolCallId !== toolUseId) return b;
            const tc = b as ToolCallBlock;
            const isFinishing = tc.status !== "completed" && tc.status !== "failed";
            return {
              ...tc,
              rawOutput: outputText || tc.rawOutput,
              content: outputText ? [{ type: "content" as const, text: outputText }] : tc.content,
              status: isError ? "failed" as const : "completed" as const,
              duration: isFinishing
                ? Math.round((Date.now() - tc.startedAt) / 1000 * 10) / 10
                : tc.duration,
            };
          }),
        );
      }
    }
  }

  function handleAssistantMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown>;
    if (!message) return;
    const content = message.content as Array<Record<string, unknown>>;
    if (!Array.isArray(content)) return;

    dispatch({ type: "SET", patch: { isAgentTurn: true } });

    for (const block of content) {
      if (block.type === "thinking") {
        blocks.finalizeThinking();
        blocks.pushBlock({
          type: "thinking",
          id: nextBlockId("think"),
          text: (block.thinking as string) ?? "",
          duration: null,
          isActive: false,
        });
      } else if (block.type === "text") {
        blocks.finalizeThinking();
        blocks.pushBlock({
          type: "text",
          id: nextBlockId("txt"),
          text: (block.text as string) ?? "",
        });
      } else if (block.type === "tool_use") {
        blocks.finalizeThinking();
        const toolName = (block.name as string) ?? "unknown";
        blocks.pushBlock({
          type: "tool_call",
          id: nextBlockId("tc"),
          toolCallId: (block.id as string) ?? "",
          title: toolName,
          kind: inferToolKind(toolName),
          status: "in_progress",
          locations: [],
          content: [],
          rawInput: block.input ?? null,
          rawOutput: null,
          startedAt: Date.now(),
          duration: null,
          extra: { toolName },
        });
      }
    }
  }

  function handleResult(msg: Record<string, unknown>): void {
    const isError = msg.is_error as boolean;
    const stopReason = (msg.stop_reason as string) ?? (isError ? msg.subtype as string : undefined);
    const cost = msg.total_cost_usd as number | undefined;
    const numTurns = msg.num_turns as number | undefined;
    const durationMs = msg.duration_ms as number | undefined;
    const msgUsage = msg.usage as Record<string, number> | undefined;

    if (msgUsage) {
      dispatch({ type: "SET", patch: { usage: {
        inputTokens: msgUsage.input_tokens ?? 0,
        outputTokens: msgUsage.output_tokens ?? 0,
        cacheCreationInputTokens: msgUsage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: msgUsage.cache_read_input_tokens ?? 0,
      } } });
    }

    if (isError) {
      const errors = msg.errors as string[] | undefined;
      const userErrors = errors?.filter((e) => !e.startsWith("[ede_diagnostic]"));
      if (userErrors?.length) {
        dispatch({ type: "SET", patch: { error: userErrors.join("; ") } });
      }
    }

    finalizeTurn(stopReason ?? undefined, cost, numTurns, durationMs);
  }

  function handleSystemMessage(msg: Record<string, unknown>): void {
    const subtype = msg.subtype as string;
    switch (subtype) {
      case "init": {
        const tools = (msg.tools as string[]) ?? [];
        const mcpServers = (msg.mcp_servers as Array<{ name: string; status: string }>) ?? [];
        const initPermissionMode = (msg.permissionMode as string) ?? "default";
        const slashCommands = (msg.slash_commands as string[]) ?? [];
        const initModel = (msg.model as string) ?? "unknown";

        const newInitInfo = { model: initModel, tools, mcpServers, permissionMode: initPermissionMode, slashCommands };
        const isFirstInit = !initInfoRef.current;
        initInfoRef.current = newInitInfo;
        dispatch({ type: "SET", patch: {
          initInfo: newInitInfo,
          currentModel: initModel ?? null,
          permissionMode: initPermissionMode ?? null,
        } });

        if (isFirstInit) {
          const extensions: ClaudeInitExtensions = {
            protocol: "claude",
            tools,
            mcpServers,
            permissionMode: initPermissionMode,
          };
          blocks.pushBlock({
            type: "system_init",
            id: nextBlockId("init"),
            agentName: "Claude Code",
            agentVersion: null,
            model: initModel,
            commands: slashCommands,
            extensions,
            extra: { ...msg },
          });
        }
        break;
      }
      case "status": {
        const mode = msg.permissionMode as string | undefined;
        if (mode) dispatch({ type: "SET", patch: { permissionMode: mode } });
        break;
      }
      case "task_started": {
        blocks.pushBlock({
          type: "task",
          id: nextBlockId("task"),
          taskId: (msg.task_id as string) ?? "",
          description: (msg.description as string) ?? "",
          status: "started",
        });
        dispatch({ type: "SET", patch: { isAgentTurn: true } });
        break;
      }
      case "task_progress": {
        const taskId = msg.task_id as string;
        const description = msg.description as string;
        const taskUsage = msg.usage as Record<string, number> | undefined;
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.type === "task" && b.taskId === taskId
              ? {
                  ...b,
                  status: "in_progress" as const,
                  description,
                  toolUses: taskUsage?.tool_uses,
                }
              : b,
          ),
        );
        break;
      }
      case "task_notification": {
        const taskId = msg.task_id as string;
        const status = msg.status as string;
        const summary = msg.summary as string;
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.type === "task" && b.taskId === taskId
              ? { ...b, status: status as TaskBlock["status"], summary }
              : b,
          ),
        );
        break;
      }
    }
  }

  function handleStreamEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string;

    switch (eventType) {
      case "content_block_start": {
        const index = event.index as number;
        const contentBlock = event.content_block as Record<string, unknown>;
        if (!contentBlock) break;

        const blockType = contentBlock.type as string;

        if (blockType === "thinking") {
          blocks.finalizeThinking();
          blocks.thinkingStartRef.current = Date.now();
          const blockId = nextBlockId("think");
          activeBlockIndexRef.current.set(index, blockId);
          blocks.pushBlock({
            type: "thinking",
            id: blockId,
            text: "",
            duration: null,
            isActive: true,
          });
          dispatch({ type: "SET", patch: { isAgentTurn: true } });
        } else if (blockType === "text") {
          blocks.finalizeThinking();
          const blockId = nextBlockId("txt");
          activeBlockIndexRef.current.set(index, blockId);
          blocks.pushBlock({
            type: "text",
            id: blockId,
            text: "",
          });
          dispatch({ type: "SET", patch: { isStreaming: true } });
          dispatch({ type: "SET", patch: { isAgentTurn: true } });
        } else if (blockType === "tool_use") {
          blocks.finalizeThinking();
          const blockId = nextBlockId("tc");
          activeBlockIndexRef.current.set(index, blockId);
          const toolName = (contentBlock.name as string) ?? "unknown";
          blocks.pushBlock({
            type: "tool_call",
            id: blockId,
            toolCallId: (contentBlock.id as string) ?? "",
            title: toolName,
            kind: inferToolKind(toolName),
            status: "pending",
            locations: [],
            content: [],
            rawInput: null,
            rawOutput: null,
            startedAt: Date.now(),
            duration: null,
            extra: { toolName },
          });
          dispatch({ type: "SET", patch: { isAgentTurn: true } });
        }
        break;
      }

      case "content_block_delta": {
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown>;
        if (!delta) break;

        const blockId = activeBlockIndexRef.current.get(index);
        if (!blockId) break;

        const deltaType = delta.type as string;

        if (deltaType === "thinking_delta") {
          const thinking = delta.thinking as string;
          if (thinking) {
            blocks.updateBlocks((prev) =>
              prev.map((b) =>
                b.id === blockId && b.type === "thinking"
                  ? { ...b, text: b.text + thinking }
                  : b,
              ),
            );
          }
        } else if (deltaType === "text_delta") {
          const text = delta.text as string;
          if (text) {
            blocks.updateBlocks((prev) =>
              prev.map((b) =>
                b.id === blockId && b.type === "text"
                  ? { ...b, text: b.text + text }
                  : b,
              ),
            );
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = event.index as number;
        const blockId = activeBlockIndexRef.current.get(index);
        if (blockId) {
          const block = blocks.blocksRef.current.find((b) => b.id === blockId);
          if (block?.type === "thinking" && block.isActive) {
            blocks.finalizeThinking();
          }
          activeBlockIndexRef.current.delete(index);
        }
        break;
      }

      case "message_start":
        dispatch({ type: "SET", patch: { isAgentTurn: true } });
        break;

      case "message_delta": {
        const deltaUsage = event.usage as Record<string, number> | undefined;
        if (deltaUsage) {
          dispatch({ type: "MERGE_USAGE", delta: {
            outputTokens: deltaUsage.output_tokens,
          } });
        }
        break;
      }

      case "message_stop":
        break;
    }
  }

  function handleControlRequest(msg: SDKControlRequest): void {
    const requestId = msg.request_id;
    const request = msg.request;
    if (request.subtype !== "can_use_tool") return;

    const permReq = request as ControlRequestOfSubtype<"can_use_tool">;
    const questions = (permReq.input?.questions as ControlRequestQuestion[]) ?? [];

    dispatch({ type: "SET", patch: { pendingControlRequest: {
      requestId,
      toolName: permReq.tool_name,
      toolUseId: permReq.tool_use_id,
      questions,
      rawRequest: msg,
    } } });
  }

  function handleTimelineEvent(tlEvent: ClaudeTimelineEvent): void {
    dispatch({ type: "APPEND_TIMELINE_EVENT", event: tlEvent });

    const userMsg = extractClaudeUserMessage(tlEvent.data, tlEvent.axonEvent);
    if (userMsg) {
      const attachments = extractImageAttachments(userMsg.content);
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
      dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false, pendingControlRequest: null } });
      return;
    }

    if (isClaudeProtocolEvent(tlEvent)) {
      handleSDKMessage(tlEvent.data);
      return;
    }

    const sysItem = buildSystemEventItem(tlEvent);
    if (sysItem) {
      dispatch({ type: "APPEND_MESSAGE", message: sysItem });
      return;
    }

    const agentConfig = buildAgentConfigItem(tlEvent);
    if (agentConfig) {
      dispatch({ type: "APPEND_MESSAGE", message: agentConfig });
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
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (parsed.agentId !== agentId) return;

      if (parsed.type === "timeline_event") {
        handleTimelineEvent(parsed.event as ClaudeTimelineEvent);
        return;
      }

      if (parsed.type === "connection_progress") {
        dispatch({ type: "SET", patch: { connectionStatus: parsed.step } });
        return;
      }

      if (parsed.type === "control_request") {
        handleControlRequest(parsed.controlRequest as SDKControlRequest);
      } else if (parsed.type === "turn_error") {
        finalizeTurn();
        dispatch({ type: "SET", patch: { error: parsed.error } });
      }
    };

    socket.onopen = () => {
      dispatch({ type: "SET", patch: { connectionPhase: "ready" } });
      api("/api/subscribe", { agentId }).catch(() => {});
    };

    socket.onclose = () => {
      wsRef.current = null;
    };

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [agentId]);

  const sendMessage = useCallback(async (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => {
    if (!text.trim() && (!content || content.length === 0)) return;

    blocks.reset();
    activeBlockIndexRef.current.clear();
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

  const setModelAction = useCallback(async (model: string) => {
    try { await api("/api/set-model", { agentId, model }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setPermissionModeAction = useCallback(async (mode: string) => {
    try { await api("/api/set-permission-mode", { agentId, mode }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);

  const setAutoApprovePermissions = useCallback(async (enabled: boolean) => {
    dispatch({ type: "SET", patch: { autoApprovePermissions: enabled } });
    try { await api("/api/set-auto-approve-permissions", { agentId, enabled }); } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
    }
  }, [agentId]);


  const sendControlResponse = useCallback(async (requestId: string, response: { behavior: string; updatedInput?: unknown }) => {
    try {
      await api("/api/control-response", { agentId, requestId, response });
      dispatch({ type: "SET", patch: { pendingControlRequest: null } });
    } catch (err) {
      dispatch({ type: "SET", patch: { error: err instanceof Error ? err.message : String(err) } });
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
    connectionPhase: s.connectionPhase,
    connectionStatus: s.connectionStatus,
    error: s.error,
    messages: s.messages,
    currentTurnBlocks: blocks.currentTurnBlocks,
    isAgentTurn: s.isAgentTurn,
    isStreaming: s.isStreaming,
    isSendingPrompt: s.isSendingPrompt,
    usage: s.usage,
    initInfo: s.initInfo,
    devboxId: s.devboxId,
    axonId: s.axonId,
    runloopUrl: s.runloopUrl,
    permissionMode: s.permissionMode,
    currentModel: s.currentModel,
    autoApprovePermissions: s.autoApprovePermissions,
    axonEvents: s.axonEvents,
    timelineEvents: s.timelineEvents,
    pendingControlRequest: s.pendingControlRequest,
    sendMessage,
    cancel,
    setAutoApprovePermissions,
    setModel: setModelAction,
    setPermissionMode: setPermissionModeAction,
    sendControlResponse,
    shutdown,
  };
}

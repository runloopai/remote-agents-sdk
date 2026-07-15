import { useReducer, useRef, useCallback, useEffect } from "react";
import {
  isCodexProtocolEvent,
  isTurnStartedEvent,
  isTurnCompletedEvent,
} from "@runloop/remote-agents-sdk/codex";
import type {
  ApprovalRequest,
  CodexProtocolTimelineEvent,
  CodexTimelineEvent,
  v2,
} from "@runloop/remote-agents-sdk/codex";
import { isFromUser, tryParseTimelinePayload } from "@runloop/remote-agents-sdk/shared";
import type { WsEvent } from "../../shared/ws-events.js";
import type {
  TurnBlock,
  ChatItem,
  UsageState,
  PendingApproval,
  PendingUserInput,
  AxonEventView,
  ToolCallBlock,
  CodexInitExtensions,
  ToolKind,
} from "../types.js";
import { nextBlockId } from "./parsers.js";
import { useBlockManager } from "./useBlockManager.js";
import { buildAgentConfigItem, buildSystemEventItem } from "./timeline-helpers.js";
import { api } from "./api.js";

export interface UseCodexAgentReturn {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  messages: ChatItem[];
  currentTurnBlocks: TurnBlock[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  isSendingPrompt: boolean;
  usage: UsageState | null;
  threadId: string | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  axonEvents: AxonEventView[];
  timelineEvents: CodexTimelineEvent[];
  autoApprovePermissions: boolean;
  pendingApproval: PendingApproval | null;
  pendingUserInput: PendingUserInput | null;
  sendMessage: (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => Promise<void>;
  cancel: () => Promise<void>;
  setAutoApprovePermissions: (enabled: boolean) => Promise<void>;
  respondToApproval: (requestId: string, approve: boolean) => Promise<void>;
  respondToUserInput: (requestId: string, answers: Record<string, string[]>) => Promise<void>;
  shutdown: () => Promise<void>;
}

interface CodexState {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  isSendingPrompt: boolean;
  messages: ChatItem[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  threadId: string | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  pendingApproval: PendingApproval | null;
  pendingUserInput: PendingUserInput | null;
  autoApprovePermissions: boolean;
  axonEvents: AxonEventView[];
  timelineEvents: CodexTimelineEvent[];
}

const INITIAL_CODEX_STATE: CodexState = {
  connectionPhase: "idle",
  connectionStatus: null,
  error: null,
  isSendingPrompt: false,
  messages: [],
  isAgentTurn: false,
  isStreaming: false,
  threadId: null,
  devboxId: null,
  axonId: null,
  runloopUrl: null,
  pendingApproval: null,
  pendingUserInput: null,
  autoApprovePermissions: true,
  axonEvents: [],
  timelineEvents: [],
};

type CodexAction =
  | { type: "RESET" }
  | { type: "SET"; patch: Partial<CodexState> }
  | { type: "APPEND_MESSAGE"; message: ChatItem }
  | { type: "APPEND_TIMELINE_EVENT"; event: CodexTimelineEvent };

function codexReducer(state: CodexState, action: CodexAction): CodexState {
  switch (action.type) {
    case "RESET":
      return INITIAL_CODEX_STATE;
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
  }
}

function toolKindForItem(item: v2.ThreadItem): ToolKind {
  switch (item.type) {
    case "commandExecution":
      return "execute";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "fetch";
    default:
      return "other";
  }
}

function toolTitleForItem(item: v2.ThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return item.command;
    case "fileChange":
      return "Apply file changes";
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "webSearch":
      return item.query || "Web search";
    default:
      return item.type;
  }
}

function summarizeApproval(request: ApprovalRequest): string {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return "Run a command";
    case "item/fileChange/requestApproval":
      return "Apply file changes";
    case "execCommandApproval":
      return Array.isArray(request.params.command)
        ? request.params.command.join(" ")
        : "Run a command";
    case "applyPatchApproval":
      return "Apply a patch";
    case "item/tool/requestUserInput":
      return "Tool input requested";
    case "item/permissions/requestApproval":
      return "Additional permissions requested";
  }
}

export function useCodexAgent(agentId: string | null): UseCodexAgentReturn {
  const [s, dispatch] = useReducer(codexReducer, INITIAL_CODEX_STATE);
  const blocks = useBlockManager();
  const wsRef = useRef<WebSocket | null>(null);
  // Maps a Codex item id to the turn block rendering it.
  const itemBlockIndexRef = useRef<Map<string, string>>(new Map());
  const sawInitRef = useRef(false);

  function resetAllState() {
    blocks.reset();
    itemBlockIndexRef.current.clear();
    sawInitRef.current = false;
    dispatch({ type: "RESET" });
  }

  function finalizeTurn(stopReason?: string) {
    const msg = blocks.flushToMessage(stopReason ? { stopReason } : {});
    if (msg) {
      dispatch({ type: "APPEND_MESSAGE", message: msg });
    }
    itemBlockIndexRef.current.clear();
    dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false } });
  }

  function appendToBlock(itemId: string, delta: string, blockType: "text" | "thinking") {
    const blockId = itemBlockIndexRef.current.get(itemId);
    if (!blockId) {
      const newId = nextBlockId(blockType === "text" ? "txt" : "think");
      itemBlockIndexRef.current.set(itemId, newId);
      if (blockType === "text") {
        blocks.pushBlock({ type: "text", id: newId, text: delta });
      } else {
        blocks.thinkingStartRef.current ??= Date.now();
        blocks.pushBlock({ type: "thinking", id: newId, text: delta, duration: null, isActive: true });
      }
      dispatch({ type: "SET", patch: { isAgentTurn: true, isStreaming: blockType === "text" } });
      return;
    }
    blocks.updateBlocks((prev) =>
      prev.map((b) =>
        b.id === blockId && b.type === blockType ? { ...b, text: b.text + delta } : b,
      ),
    );
  }

  function handleItemStarted(item: v2.ThreadItem) {
    dispatch({ type: "SET", patch: { isAgentTurn: true } });

    switch (item.type) {
      case "agentMessage": {
        const blockId = nextBlockId("txt");
        itemBlockIndexRef.current.set(item.id, blockId);
        blocks.finalizeThinking();
        blocks.pushBlock({ type: "text", id: blockId, text: item.text ?? "" });
        dispatch({ type: "SET", patch: { isStreaming: true } });
        break;
      }
      case "reasoning": {
        const blockId = nextBlockId("think");
        itemBlockIndexRef.current.set(item.id, blockId);
        blocks.thinkingStartRef.current = Date.now();
        blocks.pushBlock({ type: "thinking", id: blockId, text: "", duration: null, isActive: true });
        break;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "webSearch": {
        const blockId = nextBlockId("tc");
        itemBlockIndexRef.current.set(item.id, blockId);
        blocks.finalizeThinking();
        blocks.pushBlock({
          type: "tool_call",
          id: blockId,
          toolCallId: item.id,
          title: toolTitleForItem(item),
          kind: toolKindForItem(item),
          status: "in_progress",
          locations: [],
          content: [],
          rawInput: item,
          rawOutput: null,
          startedAt: Date.now(),
          duration: null,
          extra: { itemType: item.type },
        });
        break;
      }
      default:
        break;
    }
  }

  function handleItemCompleted(item: v2.ThreadItem) {
    const blockId = itemBlockIndexRef.current.get(item.id);

    switch (item.type) {
      case "agentMessage": {
        // The completed item carries the authoritative full text.
        if (blockId) {
          blocks.updateBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId && b.type === "text" ? { ...b, text: item.text } : b,
            ),
          );
        } else {
          blocks.pushBlock({ type: "text", id: nextBlockId("txt"), text: item.text });
        }
        dispatch({ type: "SET", patch: { isStreaming: false } });
        break;
      }
      case "reasoning": {
        blocks.finalizeThinking();
        const fullText = [...item.summary, ...item.content].join("\n").trim();
        if (blockId && fullText) {
          blocks.updateBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId && b.type === "thinking" && !b.text ? { ...b, text: fullText } : b,
            ),
          );
        }
        break;
      }
      case "commandExecution": {
        if (!blockId) break;
        const failed = item.status === "failed" || item.status === "declined";
        const output = item.aggregatedOutput ?? "";
        blocks.updateBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== blockId || b.type !== "tool_call") return b;
            const tc = b as ToolCallBlock;
            return {
              ...tc,
              status: failed ? ("failed" as const) : ("completed" as const),
              rawOutput: output || tc.rawOutput,
              content: output ? [{ type: "content" as const, text: output }] : tc.content,
              duration: item.durationMs != null
                ? Math.round(item.durationMs / 100) / 10
                : Math.round((Date.now() - tc.startedAt) / 100) / 10,
            };
          }),
        );
        break;
      }
      case "fileChange":
      case "mcpToolCall":
      case "webSearch": {
        if (!blockId) break;
        const failed =
          item.type !== "webSearch" &&
          (item.status === "failed" || (item.type === "fileChange" && item.status === "declined"));
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.id === blockId && b.type === "tool_call"
              ? {
                  ...b,
                  status: failed ? ("failed" as const) : ("completed" as const),
                  rawOutput: item.type === "mcpToolCall" ? (item.result ?? item.error) : b.rawOutput,
                  duration: Math.round((Date.now() - (b as ToolCallBlock).startedAt) / 100) / 10,
                }
              : b,
          ),
        );
        break;
      }
      default:
        break;
    }
  }

  function handleCodexProtocolEvent(event: CodexProtocolTimelineEvent): void {
    switch (event.eventType) {
      case "thread/started": {
        const thread = event.data.params.thread;
        dispatch({ type: "SET", patch: { threadId: thread.id } });
        if (!sawInitRef.current) {
          sawInitRef.current = true;
          const extensions: CodexInitExtensions = {
            protocol: "codex",
            threadId: thread.id,
            modelProvider: thread.modelProvider ?? null,
            cwd: (thread.cwd as string | null) ?? null,
          };
          blocks.pushBlock({
            type: "system_init",
            id: nextBlockId("init"),
            agentName: "Codex",
            agentVersion: thread.cliVersion ?? null,
            model: null,
            commands: [],
            extensions,
            extra: { thread },
          });
        }
        break;
      }
      case "turn/started":
        dispatch({ type: "SET", patch: { isAgentTurn: true } });
        break;
      case "turn/completed": {
        const status = event.data.params.turn.status;
        finalizeTurn(status === "completed" ? undefined : status);
        break;
      }
      case "item/started":
        handleItemStarted(event.data.params.item);
        break;
      case "item/completed":
        handleItemCompleted(event.data.params.item);
        break;
      case "item/agentMessage/delta":
        appendToBlock(event.data.params.itemId, event.data.params.delta, "text");
        dispatch({ type: "SET", patch: { isStreaming: true } });
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        appendToBlock(event.data.params.itemId, event.data.params.delta, "thinking");
        break;
      case "item/commandExecution/outputDelta": {
        const { itemId, delta } = event.data.params;
        const blockId = itemBlockIndexRef.current.get(itemId);
        if (!blockId) break;
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.id === blockId && b.type === "tool_call"
              ? { ...b, rawOutput: `${(b.rawOutput as string) ?? ""}${delta}` }
              : b,
          ),
        );
        break;
      }
      case "error": {
        const err = event.data.params.error;
        dispatch({ type: "SET", patch: { error: err?.message ?? "Codex error" } });
        break;
      }
      default:
        // Approval requests surface via the server's approval_request WS
        // message; responses and reasoning part markers need no rendering.
        break;
    }
  }

  function handleTimelineEvent(tlEvent: CodexTimelineEvent): void {
    dispatch({ type: "APPEND_TIMELINE_EVENT", event: tlEvent });

    // Slash-command outcomes are published to the Axon as app/system_note
    // events, so they render live and replay on resubscribe.
    if (tlEvent.axonEvent.event_type === "app/system_note") {
      const payload = tryParseTimelinePayload<{ text?: string }>(tlEvent);
      if (payload?.text) {
        dispatch({ type: "APPEND_MESSAGE", message: {
          id: `note-${tlEvent.axonEvent.sequence}`,
          role: "system" as const,
          itemType: "system_event" as const,
          eventKind: "devbox_lifecycle" as const,
          label: payload.text,
          timestamp: tlEvent.axonEvent.timestamp_ms ?? Date.now(),
        } });
      }
      return;
    }

    // The client's own turn/start frames echo back as unknown USER_EVENTs —
    // render them as user chat messages.
    if (isFromUser(tlEvent.axonEvent) && tlEvent.axonEvent.event_type === "turn/start") {
      const frame = tryParseTimelinePayload<{ params?: { input?: Array<{ type: string; text?: string }> } }>(tlEvent);
      const text = (frame?.params?.input ?? [])
        .filter((i) => i.type === "text" && i.text)
        .map((i) => i.text)
        .join("\n");
      if (text) {
        dispatch({ type: "APPEND_MESSAGE", message: {
          id: `user-${tlEvent.axonEvent.sequence}`,
          role: "user" as const,
          content: text,
        } });
      }
      return;
    }

    if (isTurnStartedEvent(tlEvent)) {
      dispatch({ type: "SET", patch: { isAgentTurn: true } });
      return;
    }

    if (isTurnCompletedEvent(tlEvent)) {
      dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false } });
      return;
    }

    if (isCodexProtocolEvent(tlEvent)) {
      handleCodexProtocolEvent(tlEvent);
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

  function handleApprovalRequest(requestId: string, request: ApprovalRequest): void {
    dispatch({ type: "SET", patch: { pendingApproval: {
      requestId,
      method: request.method,
      summary: summarizeApproval(request),
      rawRequest: request,
    } } });
  }

  function handleUserInputRequest(
    requestId: string,
    request: Extract<ApprovalRequest, { method: "item/tool/requestUserInput" }>,
  ): void {
    dispatch({ type: "SET", patch: { pendingUserInput: {
      requestId,
      questions: request.params.questions,
    } } });
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
        handleTimelineEvent(parsed.event as CodexTimelineEvent);
        return;
      }

      if (parsed.type === "connection_progress") {
        dispatch({ type: "SET", patch: { connectionStatus: parsed.step } });
        return;
      }

      if (parsed.type === "approval_request") {
        handleApprovalRequest(parsed.requestId, parsed.request);
      } else if (parsed.type === "user_input_request") {
        handleUserInputRequest(parsed.requestId, parsed.request);
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
    itemBlockIndexRef.current.clear();
    dispatch({ type: "SET", patch: { isAgentTurn: true, isStreaming: false, isSendingPrompt: true } });

    try {
      if (content && content.length > 0) {
        await api("/api/prompt", { agentId, content });
      } else {
        const result = await api<{ ok: boolean; command?: boolean }>("/api/prompt", { agentId, text });
        // Slash commands don't start a turn — clear the optimistic turn state.
        if (result.command) {
          dispatch({ type: "SET", patch: { isAgentTurn: false } });
        }
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

  // The approval policy is fixed when the thread starts (see codex-manager),
  // so this only tracks the toggle locally for UI display.
  const setAutoApprovePermissions = useCallback(async (enabled: boolean) => {
    dispatch({ type: "SET", patch: { autoApprovePermissions: enabled } });
  }, []);

  const respondToApproval = useCallback(async (requestId: string, approve: boolean) => {
    try {
      await api("/api/approval-response", { agentId, requestId, approve });
    } finally {
      dispatch({ type: "SET", patch: { pendingApproval: null } });
    }
  }, [agentId]);

  const respondToUserInput = useCallback(async (requestId: string, answers: Record<string, string[]>) => {
    try {
      await api("/api/user-input-response", { agentId, requestId, answers });
    } finally {
      dispatch({ type: "SET", patch: { pendingUserInput: null } });
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
    usage: null,
    threadId: s.threadId,
    devboxId: s.devboxId,
    axonId: s.axonId,
    runloopUrl: s.runloopUrl,
    axonEvents: s.axonEvents,
    timelineEvents: s.timelineEvents,
    autoApprovePermissions: s.autoApprovePermissions,
    pendingApproval: s.pendingApproval,
    pendingUserInput: s.pendingUserInput,
    sendMessage,
    cancel,
    setAutoApprovePermissions,
    respondToApproval,
    respondToUserInput,
    shutdown,
  };
}

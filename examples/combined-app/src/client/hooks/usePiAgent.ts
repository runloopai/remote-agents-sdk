import { useReducer, useRef, useCallback, useEffect } from "react";
import {
  isPiProtocolEvent,
  isTurnStartedEvent,
  isTurnCompletedEvent,
} from "@runloop/remote-agents-sdk/pi";
import type {
  AgentMessage,
  PiProtocolTimelineEvent,
  PiSessionState,
  PiTimelineEvent,
} from "@runloop/remote-agents-sdk/pi";
import { isFromUser, tryParseTimelinePayload } from "@runloop/remote-agents-sdk/shared";
import type { WsEvent } from "../../shared/ws-events.js";
import type {
  TurnBlock,
  ChatItem,
  UsageState,
  AxonEventView,
  ToolCallBlock,
  PiInitExtensions,
} from "../types.js";
import { nextBlockId } from "./parsers.js";
import { useBlockManager } from "./useBlockManager.js";
import { buildAgentConfigItem, buildSystemEventItem } from "./timeline-helpers.js";
import { api } from "./api.js";

export interface UsePiAgentReturn {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  messages: ChatItem[];
  currentTurnBlocks: TurnBlock[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  isSendingPrompt: boolean;
  usage: UsageState | null;
  sessionId: string | null;
  sessionFile: string | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  axonEvents: AxonEventView[];
  timelineEvents: PiTimelineEvent[];
  autoApprovePermissions: boolean;
  sendMessage: (text: string, content?: Array<{ type: string; [key: string]: unknown }>) => Promise<void>;
  cancel: () => Promise<void>;
  setAutoApprovePermissions: (enabled: boolean) => Promise<void>;
  shutdown: () => Promise<void>;
}

interface PiState {
  connectionPhase: "idle" | "connecting" | "ready" | "error";
  connectionStatus: string | null;
  error: string | null;
  isSendingPrompt: boolean;
  messages: ChatItem[];
  isAgentTurn: boolean;
  isStreaming: boolean;
  usage: UsageState | null;
  sessionId: string | null;
  sessionFile: string | null;
  devboxId: string | null;
  axonId: string | null;
  runloopUrl: string | null;
  axonEvents: AxonEventView[];
  timelineEvents: PiTimelineEvent[];
}

const INITIAL_PI_STATE: PiState = {
  connectionPhase: "idle",
  connectionStatus: null,
  error: null,
  isSendingPrompt: false,
  messages: [],
  isAgentTurn: false,
  isStreaming: false,
  usage: null,
  sessionId: null,
  sessionFile: null,
  devboxId: null,
  axonId: null,
  runloopUrl: null,
  axonEvents: [],
  timelineEvents: [],
};

type PiAction =
  | { type: "RESET" }
  | { type: "SET"; patch: Partial<PiState> }
  | { type: "APPEND_MESSAGE"; message: ChatItem }
  | { type: "APPEND_TIMELINE_EVENT"; event: PiTimelineEvent };

function piReducer(state: PiState, action: PiAction): PiState {
  switch (action.type) {
    case "RESET":
      return INITIAL_PI_STATE;
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

/** Pi reports tool arguments and results as `unknown`; render them readably. */
function stringifyToolPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function toolTitleFromArgs(toolName: string, args: unknown): string {
  if (args && typeof args === "object" && "command" in args) {
    const command = (args as { command?: unknown }).command;
    if (typeof command === "string" && command) return command;
  }
  return toolName;
}

export function usePiAgent(agentId: string | null): UsePiAgentReturn {
  const [s, dispatch] = useReducer(piReducer, INITIAL_PI_STATE);
  const blocks = useBlockManager();
  const wsRef = useRef<WebSocket | null>(null);
  // Pi identifies streamed content by contentIndex within the current assistant
  // message, and tool executions by toolCallId — both map to a turn block here.
  const blockIndexRef = useRef<Map<string, string>>(new Map());
  const sawInitRef = useRef(false);

  function resetAllState() {
    blocks.reset();
    blockIndexRef.current.clear();
    sawInitRef.current = false;
    dispatch({ type: "RESET" });
  }

  function finalizeTurn(stopReason?: string) {
    const msg = blocks.flushToMessage(stopReason ? { stopReason } : {});
    if (msg) {
      dispatch({ type: "APPEND_MESSAGE", message: msg });
    }
    blockIndexRef.current.clear();
    dispatch({ type: "SET", patch: { isAgentTurn: false, isStreaming: false } });
  }

  function appendToBlock(key: string, delta: string, blockType: "text" | "thinking") {
    const blockId = blockIndexRef.current.get(key);
    if (!blockId) {
      const newId = nextBlockId(blockType === "text" ? "txt" : "think");
      blockIndexRef.current.set(key, newId);
      if (blockType === "text") {
        blocks.finalizeThinking();
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

  /** An assistant message ended: record its usage and close any thinking block. */
  function handleMessageEnd(message: AgentMessage) {
    // contentIndex restarts at 0 for the next message, so the delta keys from
    // this one must not be reused.
    for (const key of [...blockIndexRef.current.keys()]) {
      if (key.startsWith("text:") || key.startsWith("thinking:")) {
        blockIndexRef.current.delete(key);
      }
    }
    if (message.role !== "assistant") return;
    blocks.finalizeThinking();
    dispatch({
      type: "SET",
      patch: {
        isStreaming: false,
        usage: {
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadInputTokens: message.usage.cacheRead,
          cacheCreationInputTokens: message.usage.cacheWrite,
          cost: message.usage.cost.total,
        },
      },
    });
  }

  function handleGetStateResponse(state: PiSessionState) {
    dispatch({
      type: "SET",
      patch: { sessionId: state.sessionId, sessionFile: state.sessionFile ?? null },
    });
    if (sawInitRef.current) return;
    sawInitRef.current = true;
    const extensions: PiInitExtensions = {
      protocol: "pi",
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? null,
      thinkingLevel: state.thinkingLevel,
    };
    blocks.pushBlock({
      type: "system_init",
      id: nextBlockId("init"),
      agentName: "Pi",
      agentVersion: null,
      model: state.model?.id ?? null,
      commands: [],
      extensions,
      extra: { state },
    });
  }

  function handlePiProtocolEvent(event: PiProtocolTimelineEvent): void {
    switch (event.eventType) {
      case "response": {
        // The broker issues `get_state` at spawn and after every turn, so its
        // acknowledgements are where session identity and the model come from.
        if (!event.data.success) {
          dispatch({ type: "SET", patch: { error: event.data.error ?? "Pi command failed" } });
          break;
        }
        if (event.data.command === "get_state" && event.data.data) {
          handleGetStateResponse(event.data.data as PiSessionState);
        }
        break;
      }
      case "turn_start":
      case "agent_start":
        dispatch({ type: "SET", patch: { isAgentTurn: true } });
        break;
      case "message_update": {
        const delta = event.data.assistantMessageEvent;
        switch (delta.type) {
          case "text_delta":
            appendToBlock(`text:${delta.contentIndex}`, delta.delta, "text");
            break;
          case "thinking_delta":
            appendToBlock(`thinking:${delta.contentIndex}`, delta.delta, "thinking");
            break;
          case "error":
            dispatch({
              type: "SET",
              patch: { error: delta.error.errorMessage ?? `Assistant message ${delta.reason}` },
            });
            break;
          default:
            // Start/end markers and tool-call deltas need no rendering: the
            // tool_execution_* events carry the authoritative call.
            break;
        }
        break;
      }
      case "message_end":
        handleMessageEnd(event.data.message);
        break;
      case "tool_execution_start": {
        const { toolCallId, toolName, args } = event.data;
        const blockId = nextBlockId("tc");
        blockIndexRef.current.set(`tool:${toolCallId}`, blockId);
        blocks.finalizeThinking();
        blocks.pushBlock({
          type: "tool_call",
          id: blockId,
          toolCallId,
          title: toolTitleFromArgs(toolName, args),
          kind: "other",
          status: "in_progress",
          locations: [],
          content: [],
          rawInput: args,
          rawOutput: null,
          startedAt: Date.now(),
          duration: null,
          extra: { toolName },
        });
        break;
      }
      case "tool_execution_update": {
        const blockId = blockIndexRef.current.get(`tool:${event.data.toolCallId}`);
        if (!blockId) break;
        const partial = stringifyToolPayload(event.data.partialResult);
        blocks.updateBlocks((prev) =>
          prev.map((b) =>
            b.id === blockId && b.type === "tool_call" ? { ...b, rawOutput: partial } : b,
          ),
        );
        break;
      }
      case "tool_execution_end": {
        const blockId = blockIndexRef.current.get(`tool:${event.data.toolCallId}`);
        if (!blockId) break;
        const output = stringifyToolPayload(event.data.result);
        const isError = event.data.isError;
        blocks.updateBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== blockId || b.type !== "tool_call") return b;
            const tc = b as ToolCallBlock;
            return {
              ...tc,
              status: isError ? ("failed" as const) : ("completed" as const),
              rawOutput: output || tc.rawOutput,
              content: output ? [{ type: "content" as const, text: output }] : tc.content,
              duration: Math.round((Date.now() - tc.startedAt) / 100) / 10,
            };
          }),
        );
        break;
      }
      case "agent_settled":
        // The only event that ends a Pi turn. `agent_end` does not: Pi may
        // auto-retry after it and keep streaming.
        finalizeTurn();
        break;
      default:
        // message_start adds nothing over the deltas that follow it; turn_end
        // and agent_end are informational until agent_settled arrives.
        break;
    }
  }

  function handleTimelineEvent(tlEvent: PiTimelineEvent): void {
    dispatch({ type: "APPEND_TIMELINE_EVENT", event: tlEvent });

    // The client's own turn/start frames echo back as USER_EVENTs — render them
    // as user chat messages.
    if (isFromUser(tlEvent.axonEvent) && tlEvent.axonEvent.event_type === "turn/start") {
      const frame = tryParseTimelinePayload<{ message?: string }>(tlEvent);
      if (frame?.message) {
        dispatch({ type: "APPEND_MESSAGE", message: {
          id: `user-${tlEvent.axonEvent.sequence}`,
          role: "user" as const,
          content: frame.message,
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

    if (isPiProtocolEvent(tlEvent)) {
      handlePiProtocolEvent(tlEvent);
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
        handleTimelineEvent(parsed.event as PiTimelineEvent);
        return;
      }

      if (parsed.type === "connection_progress") {
        dispatch({ type: "SET", patch: { connectionStatus: parsed.step } });
        return;
      }

      if (parsed.type === "turn_error") {
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
    blockIndexRef.current.clear();
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

  // Pi has no approval protocol — every tool runs unattended — so the toggle is
  // display-only here.
  const setAutoApprovePermissions = useCallback(async () => {}, []);

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
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    devboxId: s.devboxId,
    axonId: s.axonId,
    runloopUrl: s.runloopUrl,
    axonEvents: s.axonEvents,
    timelineEvents: s.timelineEvents,
    autoApprovePermissions: true,
    sendMessage,
    cancel,
    setAutoApprovePermissions,
    shutdown,
  };
}

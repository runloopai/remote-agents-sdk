import { useState } from "react";
import {
  createCustomEventGuard,
  isTurnStartedEvent,
  isTurnCompletedEvent,
  isDevboxLifecycleEvent,
  isAgentErrorEvent,
  isBrokerErrorEvent,
  isFromUser,
} from "@runloop/remote-agents-sdk/acp";
import type {
  ACPProtocolTimelineEvent,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@runloop/remote-agents-sdk/acp";
import type {
  ClaudeProtocolTimelineEvent,
  SDKControlRequest,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@runloop/remote-agents-sdk/claude";
import type { CodexProtocolTimelineEvent } from "@runloop/remote-agents-sdk/codex";
import type { PiProtocolTimelineEvent } from "@runloop/remote-agents-sdk/pi";
import type { AgentStartedPayload, TimelineEvent } from "../types.js";
import { PayloadTree, formatTime, originLabel, originBadgeClass } from "./shared.js";

const isAgentStartedEvent = createCustomEventGuard<AgentStartedPayload>("agent_started");

type TimelineKind =
  | "system"
  | "acp_protocol"
  | "claude_protocol"
  | "codex_protocol"
  | "pi_protocol"
  | "unknown";

interface TimelineSummary {
  icon: string;
  label: string;
  summary: string;
  kindClass: string;
}

function summarizeACPProtocol(event: ACPProtocolTimelineEvent): TimelineSummary {
  const isUser = isFromUser(event);

  switch (event.eventType) {
    case "session/update": {
      const d = event.data as SessionNotification;
      const su = d.update?.sessionUpdate ?? d.sessionId ?? "";
      return { icon: "\u{1F4E6}", label: "session/update", summary: su, kindClass: "kind-protocol" };
    }
    case "session/prompt": {
      if (isUser) {
        const d = event.data as PromptRequest;
        const textBlock = d.prompt?.find((p) => p.type === "text");
        const text = textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "";
        const preview = text.length > 60 ? `${text.slice(0, 60)}\u2026` : text;
        return { icon: "\u{1F4AC}", label: "session/prompt", summary: preview, kindClass: "kind-protocol" };
      }
      const d = event.data as PromptResponse;
      return { icon: "\u2705", label: "session/prompt", summary: d.stopReason || "response", kindClass: "kind-protocol" };
    }
    case "initialize": {
      const d = event.data as InitializeRequest | InitializeResponse;
      const name = ("agentInfo" in d ? d.agentInfo?.name : undefined)
        ?? ("clientInfo" in d ? d.clientInfo?.name : undefined);
      return { icon: "\u26A1", label: "initialize", summary: name ?? (isUser ? "client" : "agent"), kindClass: "kind-protocol" };
    }
    case "session/new": {
      if (isUser) {
        const d = event.data as NewSessionRequest;
        return { icon: "\u{1F195}", label: "session/new", summary: d.cwd ?? "", kindClass: "kind-protocol" };
      }
      const d = event.data as NewSessionResponse;
      return { icon: "\u{1F195}", label: "session/new", summary: d.sessionId ? d.sessionId.slice(0, 16) : "", kindClass: "kind-protocol" };
    }
    default: {
      const { eventType } = event;
      if (eventType === "session/request_permission") {
        if (isUser) {
          const d = event.data as RequestPermissionRequest;
          return { icon: "\u{1F512}", label: "Permission Request", summary: d.toolCall?.title ?? "", kindClass: "kind-permission" };
        }
        const d = event.data as RequestPermissionResponse;
        const outcome = d.outcome && "outcome" in d.outcome ? (d.outcome as { outcome?: string }).outcome ?? "" : "";
        return { icon: outcome === "cancelled" ? "\u274C" : "\u2705", label: "Permission Response", summary: outcome, kindClass: "kind-permission" };
      }
      if (eventType === "session/elicitation") {
        const d = event.data as { message?: string };
        const message = d.message ?? "";
        const preview = message.length > 60 ? `${message.slice(0, 60)}\u2026` : message;
        return { icon: "\u2753", label: "Elicitation", summary: preview, kindClass: "kind-permission" };
      }
      return { icon: "\u{1F4E6}", label: eventType, summary: "", kindClass: "kind-protocol" };
    }
  }
}

function summarizeClaudeProtocol(event: ClaudeProtocolTimelineEvent): TimelineSummary {
  const { data } = event;

  switch (event.eventType) {
    case "query":
      return { icon: "\u{1F4AC}", label: "user", summary: "", kindClass: "kind-protocol" };
    case "assistant":
      return { icon: "\u{1F916}", label: "assistant", summary: "", kindClass: "kind-protocol" };
    case "result": {
      const d = data as SDKResultMessage;
      const stopReason = "subtype" in d ? d.subtype : "";
      return { icon: "\u2705", label: "result", summary: stopReason, kindClass: "kind-protocol" };
    }
    case "system": {
      const d = data as SDKSystemMessage;
      return { icon: "\u2699", label: "system", summary: d.subtype ?? "", kindClass: "kind-protocol" };
    }
    case "control_request": {
      const d = data as SDKControlRequest;
      const toolName = d.request && "tool_name" in d.request ? (d.request as { tool_name?: string }).tool_name ?? "" : "";
      return { icon: "\u{1F512}", label: "control_request", summary: toolName, kindClass: "kind-permission" };
    }
    case "control_response":
      return { icon: "\u2705", label: "control_response", summary: "", kindClass: "kind-permission" };
    case "stream_event":
      const streamData = data as SDKPartialAssistantMessage;
      return { icon: "\u{1F4E1}", label: "stream_event", summary: streamData.event?.type ?? "", kindClass: "kind-protocol" };
    case "tool_progress":
      return { icon: "\u{1F527}", label: "tool_progress", summary: "", kindClass: "kind-protocol" };
    default: {
      const d = data as { type?: string };
      const msgType = d.type ?? "";
      return { icon: "\u{1F4E6}", label: msgType || "claude", summary: "", kindClass: "kind-protocol" };
    }
  }
}

function summarizeCodexProtocol(event: CodexProtocolTimelineEvent): TimelineSummary {
  switch (event.eventType) {
    case "thread/started":
      return { icon: "\u{1F195}", label: "thread/started", summary: event.data.params.thread.id.slice(0, 16), kindClass: "kind-protocol" };
    case "turn/started":
      return { icon: "▶️", label: "turn/started", summary: "", kindClass: "kind-protocol" };
    case "turn/completed":
      return { icon: "✅", label: "turn/completed", summary: event.data.params.turn.status, kindClass: "kind-protocol" };
    case "item/started":
    case "item/completed":
      return { icon: "\u{1F4E6}", label: event.eventType, summary: event.data.params.item.type, kindClass: "kind-protocol" };
    case "item/agentMessage/delta": {
      const preview = event.data.params.delta.slice(0, 40);
      return { icon: "\u{1F916}", label: "agentMessage/delta", summary: preview, kindClass: "kind-protocol" };
    }
    case "item/commandExecution/outputDelta":
      return { icon: "\u{1F4BB}", label: "commandExecution/outputDelta", summary: "", kindClass: "kind-protocol" };
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
      return { icon: "\u{1F4AD}", label: event.eventType, summary: "", kindClass: "kind-protocol" };
    case "error":
      return { icon: "⚠️", label: "error", summary: event.data.params.error?.message ?? "", kindClass: "kind-system" };
    case "response":
      return { icon: "✅", label: "response", summary: String(event.data.id ?? ""), kindClass: "kind-protocol" };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/tool/requestUserInput":
    case "item/permissions/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return { icon: "\u{1F512}", label: event.eventType, summary: "approval", kindClass: "kind-permission" };
    default:
      return { icon: "\u{1F4E6}", label: (event as { eventType: string }).eventType, summary: "", kindClass: "kind-protocol" };
  }
}

function summarizePiProtocol(event: PiProtocolTimelineEvent): TimelineSummary {
  switch (event.eventType) {
    case "agent_start":
      return { icon: "\u{1F195}", label: "agent_start", summary: "", kindClass: "kind-protocol" };
    case "turn_start":
      return { icon: "▶️", label: "turn_start", summary: "", kindClass: "kind-protocol" };
    case "turn_end":
      return { icon: "✅", label: "turn_end", summary: "", kindClass: "kind-protocol" };
    case "message_start":
    case "message_end":
      return { icon: "\u{1F4E6}", label: event.eventType, summary: event.data.message.role, kindClass: "kind-protocol" };
    case "message_update": {
      const delta = event.data.assistantMessageEvent;
      switch (delta.type) {
        case "text_delta":
          return { icon: "\u{1F916}", label: "text_delta", summary: delta.delta.slice(0, 40), kindClass: "kind-protocol" };
        case "thinking_delta":
          return { icon: "\u{1F4AD}", label: "thinking_delta", summary: "", kindClass: "kind-protocol" };
        case "error":
          return { icon: "⚠️", label: "message error", summary: delta.reason, kindClass: "kind-system" };
        default:
          return { icon: "\u{1F4E6}", label: delta.type, summary: "", kindClass: "kind-protocol" };
      }
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return { icon: "\u{1F527}", label: event.eventType, summary: event.data.toolName, kindClass: "kind-protocol" };
    case "agent_end":
      // Not a turn boundary: `willRetry` means Pi keeps going.
      return { icon: "⏸️", label: "agent_end", summary: event.data.willRetry ? "willRetry" : "", kindClass: "kind-protocol" };
    case "agent_settled":
      return { icon: "⏹️", label: "agent_settled", summary: "", kindClass: "kind-protocol" };
    case "response": {
      const { command, success, error } = event.data;
      return {
        icon: success ? "✅" : "⚠️",
        label: `response ${command}`,
        summary: success ? "" : (error ?? "failed"),
        kindClass: success ? "kind-protocol" : "kind-system",
      };
    }
    default:
      return { icon: "\u{1F4E6}", label: (event as { eventType: string }).eventType, summary: "", kindClass: "kind-protocol" };
  }
}

function summarizeTimelineEvent(event: TimelineEvent): TimelineSummary {
  if (isTurnStartedEvent(event)) {
    return { icon: "\u25B6\uFE0F", label: "turn.started", summary: "", kindClass: "kind-system" };
  }
  if (isTurnCompletedEvent(event)) {
    const suffix = event.data.stopReason ? ` (${event.data.stopReason})` : "";
    return { icon: "\u23F9\uFE0F", label: "turn.completed", summary: suffix, kindClass: "kind-system" };
  }
  if (isDevboxLifecycleEvent(event)) {
    const { kind, devboxId } = event.data;
    const reason = "reason" in event.data ? (event.data as { reason?: string }).reason : undefined;
    const suffix = reason ? ` (${reason})` : "";
    return { icon: "\u{1F4E6}", label: `devbox.${kind}`, summary: devboxId + suffix, kindClass: "kind-system" };
  }
  if (isAgentErrorEvent(event)) {
    const { devboxId, errorType, message } = event.data;
    const parts = [errorType, message].filter(Boolean).join(": ");
    return { icon: "\u26A0\uFE0F", label: "agent.error", summary: parts || devboxId, kindClass: "kind-system" };
  }
  if (isBrokerErrorEvent(event)) {
    return { icon: "\u26A0\uFE0F", label: "broker.error", summary: event.data.message, kindClass: "kind-system" };
  }

  switch (event.kind) {
    case "system":
      return { icon: "\u2139\uFE0F", label: (event.data as { type: string }).type, summary: "", kindClass: "kind-system" };
    case "acp_protocol":
      return summarizeACPProtocol(event);
    case "claude_protocol":
      return summarizeClaudeProtocol(event);
    case "codex_protocol":
      return summarizeCodexProtocol(event);
    case "pi_protocol":
      return summarizePiProtocol(event);
    case "unknown": {
      if (isAgentStartedEvent(event)) {
        return { icon: "\u2699\uFE0F", label: "Agent Started", summary: event.data.agentType ?? "", kindClass: "kind-custom" };
      }
      return { icon: "\u2753", label: event.axonEvent.event_type, summary: "unclassified", kindClass: "kind-unknown" };
    }
    default:
      return { icon: "\u{1F4E6}", label: "event", summary: "", kindClass: "kind-unknown" };
  }
}

function isCustomEvent(event: TimelineEvent): boolean {
  return isAgentStartedEvent(event);
}

function kindBadgeLabel(kind: TimelineKind, custom: boolean): string {
  if (custom) return "CFG";
  switch (kind) {
    case "system": return "SYS";
    case "acp_protocol": return "ACP";
    case "claude_protocol": return "CLAUDE";
    case "codex_protocol": return "CODEX";
    case "pi_protocol": return "PI";
    case "unknown": return "?";
  }
}

function kindBadgeClass(kind: TimelineKind, custom: boolean): string {
  if (custom) return "tl-kind-custom";
  switch (kind) {
    case "system": return "tl-kind-system";
    case "acp_protocol": return "tl-kind-acp";
    case "claude_protocol": return "tl-kind-claude";
    case "codex_protocol": return "tl-kind-codex";
    case "pi_protocol": return "tl-kind-pi";
    case "unknown": return "tl-kind-unknown";
  }
}

function AgentConfigDetail({ event }: { event: TimelineEvent }) {
  if (!isAgentStartedEvent(event)) return <PayloadTree data={null} />;
  const cfg = event.data;

  const entries: Array<[string, string]> = [];
  if (cfg.agentType) entries.push(["Agent Type", cfg.agentType]);
  if (cfg.agentId) entries.push(["Agent ID", cfg.agentId]);
  if (cfg.model) entries.push(["Model", cfg.model]);
  if (cfg.agentBinary) entries.push(["Agent Binary", String(cfg.agentBinary)]);
  if (cfg.blueprintName) entries.push(["Blueprint", String(cfg.blueprintName)]);
  if (cfg.systemPrompt) entries.push(["System Prompt", String(cfg.systemPrompt)]);
  if (cfg.launchArgs) entries.push(["Launch Args", Array.isArray(cfg.launchArgs) ? cfg.launchArgs.join(" ") : String(cfg.launchArgs)]);
  if (cfg.launchCommands) entries.push(["Launch Commands", Array.isArray(cfg.launchCommands) ? cfg.launchCommands.join("\n") : String(cfg.launchCommands)]);
  const autoApprove = cfg.autoApprovePermissions ?? cfg.dangerouslySkipPermissions;
  if (autoApprove != null) entries.push(["Auto-approve", String(autoApprove)]);

  return (
    <div className="agent-config-detail">
      {entries.map(([key, value]) => (
        <div key={key} className="agent-config-row">
          <span className="agent-config-key">{key}</span>
          <span className="agent-config-val">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function TimelineEventItem({
  event, expanded, onToggle, onCopy,
}: {
  event: TimelineEvent;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const summary = summarizeTimelineEvent(event);
  const ax = event.axonEvent;
  const [showRaw, setShowRaw] = useState(false);
  const custom = isCustomEvent(event);

  return (
    <div className={`event-item ${summary.kindClass} ${expanded ? "event-item-expanded" : ""}`} onClick={onToggle}>
      <div className="axon-event-header">
        <span className="axon-event-seq">#{ax.sequence}</span>
        <span className="axon-event-icon">{summary.icon}</span>
        <span className="axon-event-label">{summary.label}</span>
        <span className={`axon-badge tl-kind-badge ${kindBadgeClass(event.kind, custom)}`}>{kindBadgeLabel(event.kind, custom)}</span>
        <span className={`axon-badge ${originBadgeClass(ax.origin)}`}>{originLabel(ax.origin)}</span>
      </div>

      <div className="axon-event-sub-row">
        <span className="axon-event-summary">{summary.summary}</span>
        <span className="axon-event-time">{formatTime(ax.timestamp_ms)}</span>
      </div>

      {expanded && (
        <div className="axon-event-detail" onClick={(e) => e.stopPropagation()}>
          <div className="axon-detail-section">
            <div className="axon-payload-tree">
              {custom ? (
                <AgentConfigDetail event={event} />
              ) : (
                <PayloadTree data={event.data} />
              )}
            </div>
          </div>

          <div className="axon-detail-meta">
            <div className="axon-detail-meta-item">
              <span className="axon-detail-meta-key">kind</span>
              <span className="axon-detail-meta-val">{custom ? "agent_started" : event.kind}</span>
            </div>
            {(event.kind === "acp_protocol" || event.kind === "claude_protocol") && (
              <div className="axon-detail-meta-item">
                <span className="axon-detail-meta-key">eventType</span>
                <span className="axon-detail-meta-val">{event.eventType}</span>
              </div>
            )}
            <div className="axon-detail-meta-item">
              <span className="axon-detail-meta-key">sequence</span>
              <span className="axon-detail-meta-val">{ax.sequence}</span>
            </div>
          </div>

          <div className="axon-detail-actions">
            <button
              className="btn btn-ghost axon-raw-toggle"
              onClick={() => setShowRaw(!showRaw)}
            >
              {showRaw ? "Hide" : "Show"} Raw JSON
            </button>
            <button
              className="btn btn-ghost axon-copy-btn"
              onClick={(e) => { e.stopPropagation(); onCopy(); }}
            >
              Copy
            </button>
          </div>
          {showRaw && (
            <div className="axon-event-raw">
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

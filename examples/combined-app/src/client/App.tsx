import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import type { AgentType, AgentConfigItem, AgentStartedPayload, AvailableCommand, AxonEventView, SystemEventItem, UserAttachment } from "./types.js";
import { isSystemEventItem, isAgentConfigItem, isErrorSystemEvent } from "./types.js";
import { useAgent } from "./hooks/useAgent.js";
import { useAgentList } from "./hooks/useAgentList.js";
import { useAttachments } from "./hooks/useAttachments.js";
import { SetupCard } from "./components/SetupCard.js";
import { AgentSidebar } from "./components/AgentSidebar.js";
import { ControlsBar } from "./components/ControlsBar.js";
import { AssistantTurn } from "./components/AssistantTurn.js";
import { AttachmentBar } from "./components/AttachmentBar.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { UserInputPrompt } from "./components/UserInputPrompt.js";
import { ElicitationForm } from "./components/ElicitationForm.js";
import { PermissionDialog } from "./components/PermissionDialog.js";
import { ControlRequestPrompt } from "./components/ControlRequestPrompt.js";
import { CommandPicker } from "./components/CommandPicker.js";
import { AxonEventItem } from "./components/AxonEventItem.js";
import { TimelineEventItem } from "./components/TimelineEventItem.js";
import { TurnBlocksInspector } from "./components/TurnBlocksInspector.js";
import { AttachIcon, CancelIcon, SendIcon } from "./components/Icons.js";
import { formatTime } from "./components/shared.js";
import { api } from "./hooks/api.js";

type StartPhase = "idle" | "connecting" | "error";
type RightTab = "activity" | "axon" | "timeline";

function UserAttachments({ attachments }: { attachments: UserAttachment[] }) {
  return (
    <div className="user-attachments">
      {attachments.map((a, i) =>
        a.type === "image" && a.data && a.mimeType ? (
          <div key={i} className="user-attachment-image">
            <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name ?? "attachment"} />
          </div>
        ) : a.type === "file" ? (
          <div key={i} className="user-attachment-file">
            <span className="user-attachment-file-icon">{"\uD83D\uDCC4"}</span>
            <span className="user-attachment-file-name">{a.name ?? "file"}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

const CONFIG_LABELS: Record<string, string> = {
  agentType: "Agent Type",
  agentId: "Agent ID",
  agentBinary: "Agent Binary",
  blueprintName: "Blueprint",
  model: "Model",
  launchArgs: "Launch Args",
  launchCommands: "Launch Commands",
  systemPrompt: "System Prompt",
  autoApprovePermissions: "Auto-approve",
  dangerouslySkipPermissions: "Skip Permissions",
};

function formatConfigValue(val: unknown): string {
  if (Array.isArray(val)) return val.join(" ");
  if (typeof val === "boolean") return val ? "true" : "false";
  return String(val);
}

function buildConfigEntries(cfg: AgentStartedPayload): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const [key, label] of Object.entries(CONFIG_LABELS)) {
    const val = cfg[key];
    seen.add(key);
    if (val == null || val === "") continue;
    entries.push([label, formatConfigValue(val)]);
  }

  for (const [key, val] of Object.entries(cfg)) {
    if (seen.has(key)) continue;
    if (val == null || val === "") continue;
    entries.push([key, formatConfigValue(val)]);
  }

  return entries;
}

function AgentConfigBanner({ item }: { item: AgentConfigItem }) {
  const [expanded, setExpanded] = useState(false);
  const entries = buildConfigEntries(item.config);

  return (
    <div className="chat-config-banner" onClick={() => setExpanded(!expanded)}>
      <div className="chat-config-header">
        <span className="chat-config-icon">{"\u2699\uFE0F"}</span>
        <span className="chat-config-title">Agent Started</span>
        <span className={`chevron chat-config-chevron ${expanded ? "expanded" : ""}`}>{"\u25B6"}</span>
      </div>
      {expanded && (
        <div className="chat-config-body" onClick={(e) => e.stopPropagation()}>
          {entries.map(([label, value]) => (
            <div key={label} className="agent-config-row">
              <span className="agent-config-key">{label}</span>
              <span className="agent-config-val">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EVENT_KIND_ICONS: Record<string, string> = {
  devbox_lifecycle: "\u{1F4E6}",
  agent_error: "\u26A0\uFE0F",
};

function SystemEventBanner({ item }: { item: SystemEventItem }) {
  const icon = EVENT_KIND_ICONS[item.eventKind] ?? "\u2139\uFE0F";
  const isError = isErrorSystemEvent(item);

  return (
    <div className={`chat-system-event ${isError ? "chat-system-event-error" : ""}`}>
      <span className="chat-system-event-icon">{icon}</span>
      <span className="chat-system-event-label">{item.label}</span>
      {item.detail && <span className="chat-system-event-detail">{item.detail}</span>}
      <span className="chat-system-event-time">{formatTime(item.timestamp)}</span>
    </div>
  );
}

export default function App() {
  const agentList = useAgentList();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(true);
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>("acp");

  const [startPhase, setStartPhase] = useState<StartPhase>("idle");
  const [startStatus, setStartStatus] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const startWsRef = useRef<WebSocket | null>(null);

  const selectedEntry = agentList.agents.find((a) => a.id === selectedAgentId);
  const activeAgentType = selectedEntry?.agentType ?? null;

  const agent = useAgent(selectedAgentId, activeAgentType);
  const attach = useAttachments();

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const axonEndRef = useRef<HTMLDivElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [agentBinary, setAgentBinary] = useState("opencode");
  const [launchArgs, setLaunchArgs] = useState("acp");
  const [launchCommands, setLaunchCommands] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blueprintName, setBlueprintName] = useState("");
  const [model, setModel] = useState("");
  const [startAutoApprove, setStartAutoApprove] = useState(true);
  const [inputText, setInputText] = useState("");
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const [expandedAxonEvents, setExpandedAxonEvents] = useState<Set<number>>(new Set());
  const [expandedTimelineEvents, setExpandedTimelineEvents] = useState<Set<number>>(new Set());
  const [rightTab, setRightTab] = useState<RightTab>("activity");
  const [showCommandPicker, setShowCommandPicker] = useState(false);
  const [commandPickerIndex, setCommandPickerIndex] = useState(0);

  useEffect(() => {
    agentList.refresh();
  }, []);

  useEffect(() => {
    const el = chatAreaRef.current;
    if (!el) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 150) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [agent.messages, agent.currentTurnBlocks]);

  useEffect(() => {
    axonEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agent.axonEvents]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agent.timelineEvents]);

  const toggleBlock = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleStart = async () => {
    setStartPhase("connecting");
    setStartStatus("Provisioning sandbox and connecting to agent…");
    setStartError(null);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    startWsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "connection_progress" && data.step) {
          setStartStatus(data.step);
        }
      } catch { /* ignore */ }
    };

    const sharedConfig = {
      launchCommands: launchCommands ? launchCommands.split("\n").filter(Boolean) : undefined,
      workingDir: workingDir || undefined,
      systemPrompt: systemPrompt || undefined,
    };

    const config = selectedAgentType === "acp"
      ? {
          agentBinary,
          launchArgs: launchArgs ? launchArgs.split(/\s+/) : undefined,
          autoApprovePermissions: startAutoApprove,
          ...sharedConfig,
        }
      : selectedAgentType === "codex"
        ? {
            blueprintName: blueprintName || undefined,
            model: model || undefined,
            autoApprovePermissions: startAutoApprove,
            ...sharedConfig,
          }
        : selectedAgentType === "pi"
          ? {
              blueprintName: blueprintName || undefined,
              model: model || undefined,
              ...sharedConfig,
            }
          : {
              blueprintName: blueprintName || undefined,
              model: model || undefined,
              dangerouslySkipPermissions: startAutoApprove,
              ...sharedConfig,
            };

    try {
      const resp = await api<{ agentId: string; agentType: AgentType; [key: string]: unknown }>(
        "/api/start",
        { agentType: selectedAgentType, ...config },
      );

      ws.close();
      startWsRef.current = null;

      agentList.addLocal({
        id: resp.agentId,
        agentType: resp.agentType,
        name: selectedAgentType === "claude"
          ? (blueprintName || "Claude Agent")
          : selectedAgentType === "codex"
            ? (blueprintName || "Codex Agent")
            : selectedAgentType === "pi"
              ? (blueprintName || "Pi Agent")
              : (agentBinary || "ACP Agent"),
        axonId: resp.axonId as string,
        devboxId: resp.devboxId as string,
        createdAt: Date.now(),
      });

      setSelectedAgentId(resp.agentId);
      setShowSetup(false);
      setStartPhase("idle");
      setStartStatus(null);
    } catch (err) {
      ws.close();
      startWsRef.current = null;
      setStartPhase("error");
      setStartStatus(null);
      setStartError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleShutdownAgent = async (agentId: string) => {
    try {
      await api("/api/shutdown", { agentId });
    } catch { /* ignore */ }
    const remaining = agentList.agents.filter((a) => a.id !== agentId);
    agentList.removeLocal(agentId);
    if (selectedAgentId === agentId) {
      if (remaining.length > 0) {
        setSelectedAgentId(remaining[0].id);
        setShowSetup(false);
      } else {
        setSelectedAgentId(null);
        setShowSetup(true);
      }
    }
  };

  const handleNewAgent = () => {
    setShowSetup(true);
    setSelectedAgentId(null);
    setStartPhase("idle");
    setStartStatus(null);
    setStartError(null);
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setShowSetup(false);
  };

  const handleSend = async () => {
    if (!attach.hasContent(inputText)) return;
    setShowCommandPicker(false);
    const text = inputText;
    const content = attach.toContentPayload(text);
    setInputText("");
    attach.clearAttachments();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const hasAttachments = content.some((c) => c.type !== "text");
    await agent.sendMessage(text, hasAttachments ? content : undefined);
  };

  const selectCommand = (cmd: AvailableCommand) => {
    if (cmd.input) {
      setInputText(`/${cmd.name} `);
      setShowCommandPicker(false);
      textareaRef.current?.focus();
    } else {
      setInputText("");
      setShowCommandPicker(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      agent.sendMessage(`/${cmd.name}`);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandPicker && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandPickerIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandPickerIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectCommand(filteredCommands[commandPickerIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowCommandPicker(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const slashFilter =
    inputText.startsWith("/") && !inputText.includes(" ")
      ? inputText.slice(1).toLowerCase()
      : null;
  const filteredCommands =
    slashFilter !== null
      ? agent.availableCommands.filter((c) => c.name.toLowerCase().includes(slashFilter))
      : [];

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    const isSlash = val.startsWith("/") && !val.includes(" ");
    if (isSlash && agent.availableCommands.length > 0) {
      setShowCommandPicker(true);
      setCommandPickerIndex(0);
    } else {
      setShowCommandPicker(false);
    }
  };

  const copyAxonEvent = useCallback((event: AxonEventView) => {
    let parsedPayload: unknown = event.payload;
    try { parsedPayload = JSON.parse(event.payload); } catch { /* keep string */ }
    navigator.clipboard.writeText(JSON.stringify({ ...event, payload: parsedPayload }, null, 2));
  }, []);

  const copyTimelineEvent = useCallback((event: unknown) => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2));
  }, []);

  const copyAllTimelineEvents = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(agent.timelineEvents, null, 2));
  }, [agent.timelineEvents]);

  const copyAllAxonEvents = useCallback(() => {
    const all = agent.axonEvents.map((event) => {
      let parsedPayload: unknown = event.payload;
      try { parsedPayload = JSON.parse(event.payload); } catch { /* keep string */ }
      return { ...event, payload: parsedPayload };
    });
    navigator.clipboard.writeText(JSON.stringify(all, null, 2));
  }, [agent.axonEvents]);

  const handleShutdown = async () => {
    if (selectedAgentId) {
      await handleShutdownAgent(selectedAgentId);
    }
  };

  const showChatView = selectedAgentId && !showSetup && selectedEntry;

  const agentLabel = agent.agentType === "claude"
    ? "Claude Code"
    : agent.agentType === "codex"
      ? "Codex"
      : agent.agentType === "pi"
        ? "Pi"
        : "ACP Agent";

  // Derive devbox status from the last devbox_lifecycle system event in messages
  const lastDevboxEvent = [...agent.messages].reverse().find(
    (m): m is SystemEventItem => isSystemEventItem(m) && m.eventKind === "devbox_lifecycle",
  );

  const [statusDotClass, statusDotTooltip] = (() => {
    if (lastDevboxEvent) {
      const label = lastDevboxEvent.label;
      if (label === "Devbox Running") return ["devbox-running", "Running"] as const;
      if (label === "Devbox Suspended") return ["devbox-suspended", "Suspended"] as const;
      if (label === "Devbox Shutdown") return ["devbox-shutdown", "Shutdown"] as const;
      if (label === "Devbox Failed") return ["devbox-shutdown", "Failed"] as const;
    }
    if (agent.connectionPhase === "ready") return ["ready", "Ready"] as const;
    return ["connecting", "Connecting"] as const;
  })();

  return (
    <div className="app">
      <AgentSidebar
        agents={agentList.agents}
        selectedAgentId={selectedAgentId}
        onSelect={handleSelectAgent}
        onNewAgent={handleNewAgent}
        onShutdown={handleShutdownAgent}
      />

      {showChatView ? (
        <>
          <div className="main-column">
            <div className="header">
              <div className={`status-dot ${statusDotClass}`} title={statusDotTooltip} />
              <h1>{agentLabel}</h1>
              <div className="status-bar">
                <div className="status-ids">
                  {selectedEntry?.devboxId && (
                    <div className="status-id">
                      devbox: <span>{selectedEntry.devboxId}</span>
                    </div>
                  )}
                  {selectedEntry?.axonId && <div className="status-id">axon: <span>{selectedEntry.axonId}</span></div>}
                </div>
                <button className="btn btn-danger" onClick={handleShutdown}>Shutdown</button>
              </div>
            </div>

            <div className="main-area">
              {agent.agentType === "acp" && (
                <ControlsBar
                  availableModes={agent.availableModes}
                  currentMode={agent.currentMode}
                  configOptions={agent.configOptions}
                  availableModels={agent.availableModels}
                  currentModelId={agent.currentModelId}
                  autoApprovePermissions={agent.autoApprovePermissions}
                  onSetMode={agent.setMode}
                  onSetModel={agent.setACPModel}
                  onSetConfigOption={agent.setConfigOption}
                  onSetAutoApprovePermissions={agent.setAutoApprovePermissions}
                />
              )}

              {agent.agentType === "claude" && (
                <div className="controls-bar">
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={agent.autoApprovePermissions}
                      onChange={(e) => agent.setAutoApprovePermissions(e.target.checked)}
                    />
                    <span className="config-toggle-label">Auto-approve permissions</span>
                  </label>
                  {agent.initInfo && (
                    <span className="config-label">Model: {agent.initInfo.model}</span>
                  )}
                </div>
              )}

              {agent.agentType === "pi" && agent.sessionId && (
                <div className="controls-bar">
                  <span className="config-label">Session: {agent.sessionId}</span>
                </div>
              )}

              {agent.agentType === "codex" && agent.threadId && (
                <div className="controls-bar">
                  <span className="config-label">Thread: {agent.threadId}</span>
                </div>
              )}

              <div className="chat-area" ref={chatAreaRef}>
                {agent.messages.length === 0 && agent.currentTurnBlocks.length === 0 && !agent.isAgentTurn && agent.connectionPhase === "ready" && (
                  <div className="empty-state">Send a message to start chatting</div>
                )}

                {agent.messages.map((msg) =>
                  isSystemEventItem(msg) ? (
                    <SystemEventBanner key={msg.id} item={msg} />
                  ) : isAgentConfigItem(msg) ? (
                    <AgentConfigBanner key={msg.id} item={msg} />
                  ) : msg.role === "user" ? (
                    <div key={msg.id} className="message user">
                      <div className="message-text">{msg.content}</div>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <UserAttachments attachments={msg.attachments} />
                      )}
                    </div>
                  ) : (
                    <AssistantTurn
                      key={msg.id}
                      blocks={msg.blocks ?? []}
                      expandedBlocks={expandedBlocks}
                      onToggleBlock={toggleBlock}
                      terminals={agent.agentType === "acp" ? agent.terminals : undefined}
                      isLive={false}
                      stopReason={msg.stopReason}
                    />
                  ),
                )}

                {agent.currentTurnBlocks.length > 0 && (
                  <AssistantTurn
                    blocks={agent.currentTurnBlocks}
                    expandedBlocks={expandedBlocks}
                    onToggleBlock={toggleBlock}
                    terminals={agent.agentType === "acp" ? agent.terminals : undefined}
                    isLive={agent.isAgentTurn}
                  />
                )}

                {agent.agentType === "claude" && agent.pendingControlRequest && (
                  <ControlRequestPrompt
                    request={agent.pendingControlRequest}
                    onRespond={agent.sendControlResponse}
                  />
                )}

                {agent.agentType === "codex" && agent.pendingApproval && (
                  <ApprovalPrompt
                    approval={agent.pendingApproval}
                    onRespond={agent.respondToApproval}
                  />
                )}

                {agent.agentType === "codex" && agent.pendingUserInput && (
                  <UserInputPrompt
                    key={agent.pendingUserInput.requestId}
                    userInput={agent.pendingUserInput}
                    onRespond={agent.respondToUserInput}
                  />
                )}

                {agent.agentType === "acp" && agent.pendingPermission && (
                  <PermissionDialog
                    permission={agent.pendingPermission}
                    onAllow={agent.respondToPermission}
                    onCancel={agent.cancelPermission}
                  />
                )}

                {agent.agentType === "acp" && agent.pendingElicitation && (
                  <ElicitationForm
                    elicitation={agent.pendingElicitation}
                    onRespond={agent.respondToElicitation}
                  />
                )}

                <div ref={chatEndRef} />
              </div>

              <div className="input-bar">
                {showCommandPicker && filteredCommands.length > 0 && (
                  <CommandPicker
                    commands={filteredCommands}
                    selectedIndex={commandPickerIndex}
                    onSelect={selectCommand}
                    onHover={setCommandPickerIndex}
                  />
                )}
                <div className="input-composer">
                  <AttachmentBar
                    attachments={attach.attachments}
                    onRemove={attach.removeAttachment}
                  />
                  <textarea
                    ref={textareaRef}
                    value={inputText}
                    onChange={handleTextareaInput}
                    onKeyDown={handleKeyDown}
                    onPaste={attach.handlePaste}
                    placeholder="Send a message, paste images, or drop files"
                    rows={1}
                    disabled={agent.connectionPhase !== "ready" || agent.isAgentTurn || agent.isSendingPrompt}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    accept="image/*,.txt,.md,.json,.csv,.xml,.yaml,.yml,.ts,.js,.py,.html,.css,.sh,.toml,.cfg,.log"
                    onChange={(e) => {
                      if (e.target.files) attach.addFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }}
                  />
                  <div className="input-composer-actions">
                    <button
                      className="composer-btn composer-btn-attach"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={agent.connectionPhase !== "ready" || agent.isAgentTurn}
                      title="Attach files"
                    >
                      <AttachIcon />
                    </button>
                    {agent.isAgentTurn ? (
                      <button className="composer-btn composer-btn-cancel" onClick={agent.cancel} title="Cancel">
                        <CancelIcon />
                      </button>
                    ) : (
                      <button
                        className="composer-btn composer-btn-send"
                        onClick={handleSend}
                        disabled={!attach.hasContent(inputText) || agent.connectionPhase !== "ready" || agent.isSendingPrompt}
                        title={agent.isSendingPrompt ? "Sending…" : "Send message"}
                      >
                        <SendIcon />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="events-sidebar">
            <div className="sidebar-tabs">
              <button
                className={`sidebar-tab ${rightTab === "activity" ? "active" : ""}`}
                onClick={() => setRightTab("activity")}
              >
                Activity
                {agent.messages.length + agent.currentTurnBlocks.length > 0 && (
                  <span className="tab-count">
                    {agent.messages.reduce((s, m) => s + ("blocks" in m ? (m.blocks?.length ?? 0) : 0), 0) + agent.currentTurnBlocks.length}
                  </span>
                )}
              </button>
              <button
                className={`sidebar-tab ${rightTab === "timeline" ? "active" : ""}`}
                onClick={() => setRightTab("timeline")}
              >
                Timeline
                {agent.timelineEvents.length > 0 && (
                  <span className="tab-count">{agent.timelineEvents.length}</span>
                )}
              </button>
              <button
                className={`sidebar-tab ${rightTab === "axon" ? "active" : ""}`}
                onClick={() => setRightTab("axon")}
              >
                Axon
                {agent.axonEvents.length > 0 && (
                  <span className="tab-count">{agent.axonEvents.length}</span>
                )}
              </button>
            </div>

            {rightTab === "activity" ? (
              <div className="events-list">
                <TurnBlocksInspector
                  messages={agent.messages}
                  currentTurnBlocks={agent.currentTurnBlocks}
                  isAgentTurn={agent.isAgentTurn}
                />
              </div>
            ) : rightTab === "timeline" ? (
              <div className="events-list">
                {agent.timelineEvents.length > 0 && (
                  <div className="events-list-toolbar">
                    <button className="btn btn-ghost btn-copy-all" onClick={copyAllTimelineEvents}>Copy All</button>
                  </div>
                )}
                {agent.timelineEvents.length === 0 && (
                  <div className="empty-state">No timeline events yet</div>
                )}
                {agent.timelineEvents.map((event) => (
                  <TimelineEventItem
                    key={event.axonEvent.sequence}
                    event={event}
                    expanded={expandedTimelineEvents.has(event.axonEvent.sequence)}
                    onToggle={() =>
                      setExpandedTimelineEvents((prev) => {
                        const next = new Set(prev);
                        const seq = event.axonEvent.sequence;
                        next.has(seq) ? next.delete(seq) : next.add(seq);
                        return next;
                      })
                    }
                    onCopy={() => copyTimelineEvent(event)}
                  />
                ))}
                <div ref={timelineEndRef} />
              </div>
            ) : (
              <div className="events-list">
                {agent.axonEvents.length > 0 && (
                  <div className="events-list-toolbar">
                    <button className="btn btn-ghost btn-copy-all" onClick={copyAllAxonEvents}>Copy All</button>
                  </div>
                )}
                {agent.axonEvents.length === 0 && (
                  <div className="empty-state">No axon events yet</div>
                )}
                {agent.axonEvents.map((event) => (
                  <AxonEventItem
                    key={event.sequence}
                    event={event}
                    expanded={expandedAxonEvents.has(event.sequence)}
                    onToggle={() =>
                      setExpandedAxonEvents((prev) => {
                        const next = new Set(prev);
                        const seq = event.sequence;
                        next.has(seq) ? next.delete(seq) : next.add(seq);
                        return next;
                      })
                    }
                    onCopy={() => copyAxonEvent(event)}
                  />
                ))}
                <div ref={axonEndRef} />
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="setup-panel">
          <SetupCard
            agentType={selectedAgentType}
            setAgentType={setSelectedAgentType}
            agentBinary={agentBinary}
            setAgentBinary={setAgentBinary}
            launchArgs={launchArgs}
            setLaunchArgs={setLaunchArgs}
            launchCommands={launchCommands}
            setLaunchCommands={setLaunchCommands}
            workingDir={workingDir}
            setWorkingDir={setWorkingDir}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            blueprintName={blueprintName}
            setBlueprintName={setBlueprintName}
            model={model}
            setModel={setModel}
            autoApprovePermissions={startAutoApprove}
            setAutoApprovePermissions={setStartAutoApprove}
            onStart={handleStart}
            connectionPhase={startPhase}
            connectionStatus={startStatus}
            error={startError}
          />
        </div>
      )}
    </div>
  );
}

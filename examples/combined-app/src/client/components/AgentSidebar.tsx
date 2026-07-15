import type { AgentListItem } from "../hooks/useAgentList.js";

interface AgentSidebarProps {
  agents: AgentListItem[];
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
  onNewAgent: () => void;
  onShutdown: (agentId: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AgentSidebar({
  agents,
  selectedAgentId,
  onSelect,
  onNewAgent,
  onShutdown,
}: AgentSidebarProps) {
  return (
    <div className="agent-sidebar">
      <div className="agent-sidebar-header">
        <h3>Agents</h3>
        <button className="btn btn-ghost agent-sidebar-new" onClick={onNewAgent}>
          + New
        </button>
      </div>
      <div className="agent-sidebar-list">
        {agents.length === 0 && (
          <div className="empty-state" style={{ fontSize: 12, padding: "16px 8px" }}>
            No agents running
          </div>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`agent-sidebar-item ${agent.id === selectedAgentId ? "active" : ""}`}
            onClick={() => onSelect(agent.id)}
          >
            <div className="agent-sidebar-item-top">
              <span className="agent-sidebar-type-badge">
                {agent.agentType === "claude" ? "C" : agent.agentType === "codex" ? "X" : "A"}
              </span>
              <span className="agent-sidebar-item-name">{agent.name}</span>
              <button
                className="agent-sidebar-shutdown"
                onClick={(e) => {
                  e.stopPropagation();
                  onShutdown(agent.id);
                }}
                title="Shutdown agent"
              >
                ×
              </button>
            </div>
            <div className="agent-sidebar-item-meta">
              <span className="agent-sidebar-item-id">{agent.id}</span>
              <span className="agent-sidebar-item-time">{formatTime(agent.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

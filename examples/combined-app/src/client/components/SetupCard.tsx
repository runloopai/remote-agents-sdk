import { useState } from "react";
import type { AgentType, ConnectionPhase } from "../types.js";

export function SetupCard({
  agentType, setAgentType,
  agentBinary, setAgentBinary,
  launchArgs, setLaunchArgs,
  launchCommands, setLaunchCommands,
  workingDir, setWorkingDir,
  systemPrompt, setSystemPrompt,
  blueprintName, setBlueprintName,
  model, setModel,
  autoApprovePermissions, setAutoApprovePermissions,
  onStart,
  connectionPhase,
  connectionStatus,
  error,
}: {
  agentType: AgentType; setAgentType: (v: AgentType) => void;
  agentBinary: string; setAgentBinary: (v: string) => void;
  launchArgs: string; setLaunchArgs: (v: string) => void;
  launchCommands: string; setLaunchCommands: (v: string) => void;
  workingDir: string; setWorkingDir: (v: string) => void;
  systemPrompt: string; setSystemPrompt: (v: string) => void;
  blueprintName: string; setBlueprintName: (v: string) => void;
  model: string; setModel: (v: string) => void;
  autoApprovePermissions: boolean; setAutoApprovePermissions: (v: boolean) => void;
  onStart: () => void;
  connectionPhase: ConnectionPhase;
  connectionStatus: string | null;
  error: string | null;
}) {
  const connecting = connectionPhase === "connecting";

  return (
    <div className="setup-card">
      <div className="setup-header">
        <h2>Combined App</h2>
        <p className="setup-subtitle">
          Launch a <strong>Claude Code</strong>, <strong>Codex</strong>, or <strong>ACP</strong> agent in a secure cloud sandbox and interact through a unified interface.
        </p>
      </div>

      <div className="setup-architecture">
        <div className="arch-label">How it works</div>
        <div className="arch-diagram">
          <div className="arch-node">
            <div className="arch-node-label">This browser</div>
            <div className="arch-node-desc">React UI</div>
          </div>
          <div className="arch-arrow">
            <span className="arch-arrow-line" />
            <span className="arch-arrow-proto">WebSocket</span>
          </div>
          <div className="arch-node">
            <div className="arch-node-label">Express server</div>
            <div className="arch-node-desc">SDK client</div>
          </div>
          <div className="arch-arrow">
            <span className="arch-arrow-line" />
            <span className="arch-arrow-proto">Axon (SSE)</span>
          </div>
          <div className="arch-node arch-node-cloud">
            <div className="arch-node-label">Runloop Sandbox</div>
            <div className="arch-node-desc">Agent process</div>
          </div>
        </div>
      </div>

      <div className="setup-form-section">
        <div className="form-group">
          <label>Agent Type</label>
          <div className="form-hint">Choose which agent protocol to use.</div>
          <div className="agent-type-picker">
            <button
              className={`agent-type-btn ${agentType === "claude" ? "active" : ""}`}
              onClick={() => setAgentType("claude")}
              disabled={connecting}
            >
              Claude Code
            </button>
            <button
              className={`agent-type-btn ${agentType === "codex" ? "active" : ""}`}
              onClick={() => setAgentType("codex")}
              disabled={connecting}
            >
              Codex
            </button>
            <button
              className={`agent-type-btn ${agentType === "acp" ? "active" : ""}`}
              onClick={() => setAgentType("acp")}
              disabled={connecting}
            >
              ACP Agent
            </button>
          </div>
        </div>

        {agentType === "acp" && (
          <>
            <div className="form-group">
              <label>Agent Binary</label>
              <div className="form-hint">The coding agent to launch, e.g. <code>opencode</code>, <code>codex</code>.</div>
              <input value={agentBinary} onChange={(e) => setAgentBinary(e.target.value)} placeholder="opencode" disabled={connecting} />
            </div>
            <div className="form-group">
              <label>Launch Args</label>
              <div className="form-hint">Command-line arguments passed to the agent binary. Space-separated.</div>
              <input value={launchArgs} onChange={(e) => setLaunchArgs(e.target.value)} placeholder="acp" disabled={connecting} />
            </div>
          </>
        )}

        {(agentType === "claude" || agentType === "codex") && (
          <>
            <div className="form-group">
              <label>Blueprint Name</label>
              <div className="form-hint">Runloop blueprint for the sandbox. Defaults to <code>axon-agents</code>.</div>
              <input value={blueprintName} onChange={(e) => setBlueprintName(e.target.value)} placeholder="axon-agents" disabled={connecting} />
            </div>
            <div className="form-group">
              <label>Model</label>
              <div className="form-hint">
                {agentType === "claude" ? "Claude model to use. Leave empty for default." : "Codex model to use. Leave empty for default."}
              </div>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={agentType === "claude" ? "claude-sonnet-4-20250514" : "gpt-5.1-codex"}
                disabled={connecting}
              />
            </div>
          </>
        )}

        <div className="form-group">
          <label>Launch Commands</label>
          <div className="form-hint">Shell commands to run in the sandbox before starting the agent (one per line).</div>
          <textarea className="setup-textarea" value={launchCommands} onChange={(e) => setLaunchCommands(e.target.value)} placeholder="git clone https://..." disabled={connecting} rows={2} />
        </div>
        <div className="form-group">
          <label>Working Directory</label>
          <div className="form-hint">Set the working directory for the agent process. Leave blank to use the default.</div>
          <input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="/home/user/my-project" disabled={connecting} />
        </div>
        <div className="form-group">
          <label>System Prompt</label>
          <div className="form-hint">Custom instructions prepended to every conversation.</div>
          <textarea className="setup-textarea" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a senior engineer..." disabled={connecting} rows={3} />
        </div>
        <label className="config-toggle">
          <input
            type="checkbox"
            checked={autoApprovePermissions}
            onChange={(e) => setAutoApprovePermissions(e.target.checked)}
            disabled={connecting}
          />
          <span className="config-toggle-label">
            {agentType === "claude"
              ? "Skip permissions (--dangerously-skip-permissions)"
              : agentType === "codex"
                ? "Auto-approve approvals"
                : "Auto-approve permissions"}
          </span>
        </label>
      </div>

      <button className="btn btn-primary" onClick={onStart} disabled={connecting}>
        {connecting ? "Connecting" : "Create Sandbox & Start"}
      </button>
      {connecting && (
        <div className="phase-indicator">
          <div className="phase-spinner" />
          <span>{connectionStatus ?? "Provisioning sandbox and connecting to agent"}</span>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

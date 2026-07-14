import type { SystemInitBlock } from "../../types.js";
import { ExtraDataView } from "../ExtraDataView.js";
import { InitKVRow, InitPillSection, InitCapsBadges } from "./shared.js";

function buildSummaryParts(block: SystemInitBlock): string[] {
  const ext = block.extensions;
  const parts: string[] = [];
  if (ext?.protocol === "claude") {
    parts.push(`${ext.tools.length} tools`);
    if (ext.mcpServers.length > 0)
      parts.push(`${ext.mcpServers.length} MCP servers`);
  }
  if (ext?.protocol === "acp") {
    parts.push(`${ext.modes.length} modes`);
    parts.push(`${ext.models.length} models`);
    if (ext.configOptions.length > 0)
      parts.push(`${ext.configOptions.length} config options`);
  }
  if (block.commands.length > 0)
    parts.push(`${block.commands.length} commands`);
  return parts;
}

function ClaudeInitSections({ block }: { block: SystemInitBlock }) {
  const ext = block.extensions;
  if (ext?.protocol !== "claude") return null;
  return (
    <>
      <div className="init-kv-rows">
        {block.model && (
          <InitKVRow icon={"\u2699"} label="Model" value={block.model} />
        )}
        {ext.permissionMode && (
          <InitKVRow
            icon={"\u25CB"}
            label="Permissions"
            value={ext.permissionMode}
          />
        )}
      </div>
      <InitPillSection
        icon={"\u{1F527}"}
        label="Tools"
        count={ext.tools.length}
        items={ext.tools}
      />
      {ext.mcpServers.length > 0 && (
        <InitPillSection
          icon={"\u26A1"}
          label="MCP Servers"
          count={ext.mcpServers.length}
          items={ext.mcpServers.map((s) => s.name)}
        />
      )}
    </>
  );
}

function ACPInitSections({ block }: { block: SystemInitBlock }) {
  const ext = block.extensions;
  if (ext?.protocol !== "acp") return null;
  return (
    <>
      <div className="init-kv-rows">
        {block.model && (
          <InitKVRow icon={"\u2699"} label="Model" value={block.model} />
        )}
        {ext.protocolVersion != null && (
          <InitKVRow
            icon={"\u{1F4E1}"}
            label="Protocol"
            value={`v${ext.protocolVersion}`}
          />
        )}
      </div>
      <InitPillSection
        icon={"\u{1F3AD}"}
        label="Modes"
        count={ext.modes.length}
        items={ext.modes.map((m) => m.name ?? m.id)}
      />
      <InitPillSection
        icon={"\u{1F916}"}
        label="Models"
        count={ext.models.length}
        items={ext.models.map((m) => m.name ?? m.modelId)}
      />
      {ext.configOptions.length > 0 && (
        <InitPillSection
          icon={"\u2699"}
          label="Config"
          count={ext.configOptions.length}
          items={ext.configOptions.map(
            (o) => `${o.name}: ${o.currentValue ?? "-"}`,
          )}
        />
      )}
      {ext.agentCapabilities && (
        <div className="init-pill-section">
          <div className="init-pill-section-header">
            <span className="init-pill-section-icon">{"\u{1F527}"}</span>
            <span className="init-pill-section-label">Agent Capabilities</span>
          </div>
          <InitCapsBadges caps={ext.agentCapabilities} />
        </div>
      )}
      {ext.clientCapabilities && (
        <div className="init-pill-section">
          <div className="init-pill-section-header">
            <span className="init-pill-section-icon">{"\u{1F4BB}"}</span>
            <span className="init-pill-section-label">Client Capabilities</span>
          </div>
          <InitCapsBadges caps={ext.clientCapabilities} />
        </div>
      )}
    </>
  );
}

function CodexInitSections({ block }: { block: SystemInitBlock }) {
  const ext = block.extensions;
  if (ext?.protocol !== "codex") return null;
  return (
    <div className="init-kv-rows">
      {ext.threadId && (
        <InitKVRow icon={"\u{1F9F5}"} label="Thread" value={ext.threadId} />
      )}
      {ext.modelProvider && (
        <InitKVRow icon={"⚙"} label="Provider" value={ext.modelProvider} />
      )}
      {ext.cwd && <InitKVRow icon={"\u{1F4C1}"} label="Working Dir" value={ext.cwd} />}
    </div>
  );
}

export function SystemInitBlockView({
  block,
  expanded,
  onToggle,
}: {
  block: SystemInitBlock;
  expanded: boolean;
  onToggle: () => void;
}) {
  const title = [
    block.agentName,
    block.agentVersion ? `v${block.agentVersion}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const summaryParts = buildSummaryParts(block);

  return (
    <div className="turn-block system-init-block system-init-session">
      <div
        className="init-session-header"
        onClick={onToggle}
        style={{ cursor: "pointer" }}
      >
        <span className="init-session-dot" />
        <span className="init-session-title">
          <strong>{title || "Session initialized"}</strong>
        </span>
        <span className={`chevron init-chevron ${expanded ? "expanded" : ""}`}>
          {"\u25B6"}
        </span>
      </div>
      {expanded && (
        <div className="init-session-body">
          <ClaudeInitSections block={block} />
          <ACPInitSections block={block} />
          <CodexInitSections block={block} />
          {block.commands.length > 0 && (
            <InitPillSection
              icon={"\u{1F4AC}"}
              label="Commands"
              count={block.commands.length}
              items={block.commands}
            />
          )}
          {summaryParts.length > 0 && (
            <div className="init-session-footer">
              {summaryParts.join(" \u00b7 ")}
            </div>
          )}
          <ExtraDataView extra={block.extra} />
        </div>
      )}
    </div>
  );
}

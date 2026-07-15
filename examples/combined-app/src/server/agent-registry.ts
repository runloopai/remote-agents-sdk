import { randomUUID } from "node:crypto";
import type { ClaudeConnectionManager } from "./claude-manager.ts";
import type { ACPConnectionManager } from "./acp-manager.ts";
import type { CodexConnectionManager } from "./codex-manager.ts";

export interface AgentEntry {
  id: string;
  agentType: "claude" | "acp" | "codex";
  name: string;
  axonId: string;
  devboxId: string;
  createdAt: number;
  claudeManager?: ClaudeConnectionManager;
  acpManager?: ACPConnectionManager;
  codexManager?: CodexConnectionManager;
}

export interface AgentListItem {
  id: string;
  agentType: "claude" | "acp" | "codex";
  name: string;
  axonId: string;
  devboxId: string;
  createdAt: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentEntry>();

  generateId(): string {
    return randomUUID().slice(0, 8);
  }

  add(entry: AgentEntry): void {
    this.agents.set(entry.id, entry);
  }

  get(id: string): AgentEntry | undefined {
    return this.agents.get(id);
  }

  remove(id: string): boolean {
    return this.agents.delete(id);
  }

  list(): AgentListItem[] {
    return [...this.agents.values()].map(({ id, agentType, name, axonId, devboxId, createdAt }) => ({
      id,
      agentType,
      name,
      axonId,
      devboxId,
      createdAt,
    }));
  }

  async shutdown(id: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) return;
    if (entry.claudeManager) await entry.claudeManager.shutdown();
    if (entry.acpManager) await entry.acpManager.shutdown();
    if (entry.codexManager) await entry.codexManager.shutdown();
    this.agents.delete(id);
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.shutdown(id)));
  }
}

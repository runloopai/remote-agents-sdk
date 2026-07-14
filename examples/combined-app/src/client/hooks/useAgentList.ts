import { useState, useCallback } from "react";
import { api } from "./api.js";

export interface AgentListItem {
  id: string;
  agentType: "claude" | "acp" | "codex";
  name: string;
  axonId: string;
  devboxId: string;
  createdAt: number;
}

export interface UseAgentListReturn {
  agents: AgentListItem[];
  isLoading: boolean;
  refresh: () => Promise<void>;
  addLocal: (agent: AgentListItem) => void;
  removeLocal: (agentId: string) => void;
}

export function useAgentList(): UseAgentListReturn {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await api<{ agents: AgentListItem[] }>("/api/agents");
      setAgents(resp.agents);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addLocal = useCallback((agent: AgentListItem) => {
    setAgents((prev) => {
      if (prev.some((a) => a.id === agent.id)) return prev;
      return [...prev, agent];
    });
  }, []);

  const removeLocal = useCallback((agentId: string) => {
    setAgents((prev) => prev.filter((a) => a.id !== agentId));
  }, []);

  return { agents, isLoading, refresh, addLocal, removeLocal };
}

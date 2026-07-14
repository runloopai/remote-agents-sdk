import { useCallback } from "react";
import { useClaudeAgent } from "./useClaudeAgent.js";
import { useACPAgent } from "./useACPAgent.js";
import { useCodexAgent } from "./useCodexAgent.js";
import type { AgentType, IdleAgentState, UseAgentReturn } from "../types.js";

const NOOP_ASYNC = async () => {};

const IDLE_DEFAULTS: Omit<IdleAgentState, "shutdown"> = {
  agentType: null,
  connectionPhase: "idle",
  connectionStatus: null,
  error: null,
  messages: [],
  currentTurnBlocks: [],
  isAgentTurn: false,
  isStreaming: false,
  isSendingPrompt: false,
  usage: null,
  autoApprovePermissions: true,
  devboxId: null,
  axonId: null,
  runloopUrl: null,
  axonEvents: [],
  timelineEvents: [],
  availableCommands: [],
  sendMessage: NOOP_ASYNC,
  cancel: NOOP_ASYNC,
  setAutoApprovePermissions: NOOP_ASYNC,
};

export function useAgent(agentId: string | null, agentType: AgentType | null): UseAgentReturn {
  // React's rules of hooks require that hooks are called unconditionally in the
  // same order every render. We pass null as agentId to the inactive hook so it
  // stays idle (no WebSocket, no state updates) while satisfying the constraint.
  const claude = useClaudeAgent(agentType === "claude" ? agentId : null);
  const acp = useACPAgent(agentType === "acp" ? agentId : null);
  const codex = useCodexAgent(agentType === "codex" ? agentId : null);

  const shutdown = useCallback(async () => {
    if (agentType === "claude") {
      await claude.shutdown();
    } else if (agentType === "acp") {
      await acp.shutdown();
    } else if (agentType === "codex") {
      await codex.shutdown();
    }
  }, [agentType, claude.shutdown, acp.shutdown, codex.shutdown]);

  if (agentType === "claude") {
    const { shutdown: _, ...rest } = claude;
    return {
      ...rest,
      agentType: "claude" as const,
      shutdown,
      availableCommands: (claude.initInfo?.slashCommands ?? []).map((name) => ({ name, description: "" })),
    };
  }

  if (agentType === "codex") {
    const { shutdown: _, ...rest } = codex;
    return {
      ...rest,
      agentType: "codex" as const,
      shutdown,
      availableCommands: [],
    };
  }

  if (agentType === "acp") {
    const { shutdown: _, setModel, respondToElicitation, ...rest } = acp;
    return {
      ...rest,
      agentType: "acp" as const,
      shutdown,
      setACPModel: setModel,
      fileOps: [] as never[],
      terminals: new Map() as Map<string, never>,
      respondToElicitation: respondToElicitation as (requestId: string, action: unknown) => Promise<void>,
    };
  }

  return { ...IDLE_DEFAULTS, shutdown };
}

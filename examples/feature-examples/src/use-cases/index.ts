import type { UseCase } from "../types.js";
import agentViaBlueprint from "./agent-via-blueprint.js";
import elicitationAcp from "./elicitation-acp.js";
import elicitationClaude from "./elicitation-claude.js";
import mcpServer from "./mcp-server.js";
import singlePrompt from "./single-prompt.js";

export const USE_CASES: UseCase[] = [
  agentViaBlueprint,
  elicitationAcp,
  elicitationClaude,
  mcpServer,
  singlePrompt,
];

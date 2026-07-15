import type { UseCase } from "../types.js";
import agentViaBlueprint from "./agent-via-blueprint.js";
import approvalCodex from "./approval-codex.js";
import elicitationAcp from "./elicitation-acp.js";
import elicitationClaude from "./elicitation-claude.js";
import singlePrompt from "./single-prompt.js";
import threadResumeCodex from "./thread-resume-codex.js";

export const USE_CASES: UseCase[] = [
  agentViaBlueprint,
  approvalCodex,
  elicitationAcp,
  elicitationClaude,
  singlePrompt,
  threadResumeCodex,
];

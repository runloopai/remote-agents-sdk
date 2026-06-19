# Remote Agents SDK — Compatibility Matrix

SDK Version: 0.4.3

## Protocol × Feature

| Use Case | ACP | Claude |
|----------|-----|--------|
| agent-via-blueprint | fail | pass |
| elicitation-acp | xfail | N/A |
| elicitation-claude | N/A | pass |
| mcp-server | pass | pass |
| single-prompt | fail | pass |

## ACP Agent × Feature

| Use Case | opencode | codex-acp | qwen | gemini-cli |
|----------|------------|------------|------------|------------|
| agent-via-blueprint | pass | fail | skip | skip |
| elicitation-acp | xfail | xfail | xfail | xfail |
| mcp-server | pass | pass | pass | skip |
| single-prompt | fail | pass | pass | skip |

---

## Run Details

| Agent | Use Case | Status | Duration | Notes |
|-------|----------|--------|----------|-------|
| opencode | agent-via-blueprint | pass | 5.4s |  |
| opencode | elicitation-acp | xfail | 19.5s | [xfail: ACP protocol has not added full elicitation support yet] Agent did not trigger session_elicitation |
| opencode | mcp-server | pass | 11.6s |  |
| opencode | single-prompt | fail | 0.0s | Long poll timed out after 180000ms. Last result: undefined |
| codex-acp | agent-via-blueprint | fail | 0.0s | Long poll timed out after 180000ms. Last result: undefined |
| codex-acp | elicitation-acp | xfail | 0.0s | [xfail: codex-acp does not advertise or send session/elicitation (uses permission requests instead)] Long poll timed out after 180000ms. Last result: undefined |
| codex-acp | mcp-server | pass | 5.3s |  |
| codex-acp | single-prompt | pass | 2.0s |  |
| qwen | agent-via-blueprint | skip | 0.0s | No blueprint override defined for qwen — add an entry to BLUEPRINT_OVERRIDES to test this agent via blueprint |
| qwen | elicitation-acp | xfail | 12.2s | [xfail: qwen does not advertise or send session/elicitation] Agent did not trigger session_elicitation |
| qwen | mcp-server | pass | 6.7s |  |
| qwen | single-prompt | pass | 2.6s |  |
| gemini-cli | agent-via-blueprint | skip | 0.0s | No blueprint override defined for gemini-cli — add an entry to BLUEPRINT_OVERRIDES to test this agent via blueprint |
| gemini-cli | elicitation-acp | xfail | 0.5s | [xfail: gemini-cli does not advertise or send session/elicitation] [-32000] You have exhausted your daily quota on this model. {"event_type":"turn.failed"} |
| gemini-cli | mcp-server | skip | 0.0s | Cannot verify on this account: Gemini API quota exhausted (verified working with sufficient quota) |
| gemini-cli | single-prompt | skip | 0.0s | Cannot verify on this account: Gemini API quota exhausted (verified working with sufficient quota) |
| claude-code | agent-via-blueprint | pass | 1.4s |  |
| claude-code | elicitation-claude | pass | 21.2s |  |
| claude-code | mcp-server | pass | 7.4s |  |
| claude-code | single-prompt | pass | 1.4s |  |

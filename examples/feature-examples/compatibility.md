# Remote Agents SDK — Compatibility Matrix

SDK Version: 0.4.3

## Protocol × Feature

| Use Case | ACP | Claude | Codex |
|----------|-----|--------|-------|
| agent-via-blueprint | pass | pass | N/A |
| approval-codex | N/A | N/A | pending |
| elicitation-acp | xfail | N/A | N/A |
| elicitation-claude | N/A | pass | N/A |
| single-prompt | pass | pass | N/A |
| thread-resume-codex | N/A | N/A | pending |

## ACP Agent × Feature

| Use Case | opencode | codex-acp | qwen | gemini-cli |
|----------|------------|------------|------------|------------|
| agent-via-blueprint | pass | pass | skip | skip |
| elicitation-acp | xfail | xfail | xfail | xfail |
| single-prompt | pass | pass | pass | pass |

---

## Run Details

| Agent | Use Case | Status | Duration | Notes |
|-------|----------|--------|----------|-------|
| opencode | agent-via-blueprint | pass | 1.8s |  |
| opencode | elicitation-acp | xfail | 9.9s | [xfail: ACP protocol has not added full elicitation support yet] Agent did not trigger session_elicitation |
| opencode | single-prompt | pass | 2.1s |  |
| codex-acp | agent-via-blueprint | pass | 2.4s |  |
| codex-acp | elicitation-acp | xfail | 10.0s | [xfail: codex-acp does not advertise or send session/elicitation (uses permission requests instead)] Agent did not trigger session_elicitation |
| codex-acp | single-prompt | pass | 1.3s |  |
| qwen | agent-via-blueprint | skip | 0.0s | No blueprint override defined for qwen — add an entry to BLUEPRINT_OVERRIDES to test this agent via blueprint |
| qwen | elicitation-acp | xfail | 11.7s | [xfail: qwen does not advertise or send session/elicitation] Agent did not trigger session_elicitation |
| qwen | single-prompt | pass | 2.2s |  |
| gemini-cli | agent-via-blueprint | skip | 0.0s | No blueprint override defined for gemini-cli — add an entry to BLUEPRINT_OVERRIDES to test this agent via blueprint |
| gemini-cli | elicitation-acp | xfail | 12.9s | [xfail: gemini-cli does not advertise or send session/elicitation] Agent did not trigger session_elicitation |
| gemini-cli | single-prompt | pass | 4.0s |  |
| claude-code | agent-via-blueprint | pass | 3.8s |  |
| claude-code | elicitation-claude | pass | 16.0s |  |
| claude-code | single-prompt | pass | 1.6s |  |

import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { describe, expect, it } from "vitest";
import { classifyCodexAxonEvent, isCodexProtocolEventType } from "./classify-codex-axon-event.js";
import {
  isCodexAgentMessageDeltaEvent,
  isCodexApprovalRequestEvent,
  isCodexItemCompletedEvent,
  isCodexResponseEvent,
  isCodexThreadStartedEvent,
  isTurnCompletedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";

function frame(
  eventType: string,
  payload: unknown,
  origin: AxonEventView["origin"] = "AGENT_EVENT",
): AxonEventView {
  return {
    axon_id: "axn_codex",
    event_type: eventType,
    origin,
    payload: JSON.stringify(payload),
    sequence: 7,
    source: "codex",
    timestamp_ms: 1_752_192_000_000,
  };
}

const threadStarted = {
  method: "thread/started",
  params: {
    thread: {
      id: "0197f58a-865d-7b20-b33c-20b1fd895971",
      sessionId: "0197f58a-865d-7b20-b33c-20b1fd895971",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1_752_192_000,
      updatedAt: 1_752_192_000,
      recencyAt: null,
      status: { type: "idle" },
      path: null,
      cwd: "/workspace",
      cliVersion: "0.144.1",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
  },
};

const agentDelta = {
  method: "item/agentMessage/delta",
  params: { threadId: "thr-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
};

const commandApproval = {
  method: "item/commandExecution/requestApproval",
  id: 41,
  params: {
    threadId: "thr-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1_752_192_000_000,
    environmentId: null,
    reason: "requires network",
    networkApprovalContext: null,
    command: "curl https://example.com",
    cwd: "/workspace",
    commandActions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  },
};

describe("classifyCodexAxonEvent", () => {
  it("classifies a wire thread/started notification", () => {
    const event = classifyCodexAxonEvent(frame("thread/started", threadStarted));
    expect(isCodexThreadStartedEvent(event)).toBe(true);
    if (isCodexThreadStartedEvent(event)) expect(event.data.params.thread.id).toMatch(/^0197/);
  });

  it("classifies item deltas and completed items", () => {
    const delta = classifyCodexAxonEvent(frame("item/agentMessage/delta", agentDelta));
    expect(isCodexAgentMessageDeltaEvent(delta)).toBe(true);
    if (isCodexAgentMessageDeltaEvent(delta)) expect(delta.data.params.delta).toBe("hello");

    const completedFrame = {
      method: "item/completed",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "hello", phase: "final" },
        startedAtMs: 1_752_192_000_000,
        completedAtMs: 1_752_192_000_100,
      },
    };
    expect(
      isCodexItemCompletedEvent(classifyCodexAxonEvent(frame("item/completed", completedFrame))),
    ).toBe(true);
  });

  it("classifies server-initiated approval request frames including their id", () => {
    const event = classifyCodexAxonEvent(
      frame("item/commandExecution/requestApproval", commandApproval),
    );
    expect(isCodexApprovalRequestEvent(event)).toBe(true);
    if (isCodexApprovalRequestEvent(event)) expect(event.data.id).toBe(41);
  });

  it("classifies methodless JSON-RPC responses using the broker response event type", () => {
    const event = classifyCodexAxonEvent(
      frame("response", { id: "sdk-1", result: { thread: {} } }),
    );
    expect(isCodexResponseEvent(event)).toBe(true);
    if (isCodexResponseEvent(event)) expect(event.data.id).toBe("sdk-1");
  });

  it("prefers shared SYSTEM_EVENT classification", () => {
    const event = classifyCodexAxonEvent(
      frame("turn.completed", { turn_id: "turn-1", stop_reason: "end_turn" }, "SYSTEM_EVENT"),
    );
    expect(isTurnCompletedEvent(event)).toBe(true);
  });

  it("preserves unknown events", () => {
    expect(
      isUnknownTimelineEvent(classifyCodexAxonEvent(frame("custom/event", { value: 1 }))),
    ).toBe(true);
  });
});

describe("isCodexProtocolEventType", () => {
  it("recognizes notifications, approvals, errors, and responses", () => {
    expect(isCodexProtocolEventType("turn/started")).toBe(true);
    expect(isCodexProtocolEventType("item/reasoning/textDelta")).toBe(true);
    expect(isCodexProtocolEventType("applyPatchApproval")).toBe(true);
    expect(isCodexProtocolEventType("error")).toBe(true);
    expect(isCodexProtocolEventType("response")).toBe(true);
    expect(isCodexProtocolEventType("custom/event")).toBe(false);
  });
});

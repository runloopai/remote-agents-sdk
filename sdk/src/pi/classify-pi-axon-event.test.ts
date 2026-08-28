import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { describe, expect, it } from "vitest";
import { assistantMessage, toolResultMessage } from "../__test-utils__/pi-fixtures.js";
import { classifyPiAxonEvent, isPiProtocolEventType } from "./classify-pi-axon-event.js";
import { PI_EVENT_TYPES } from "./protocol/index.js";
import {
  isPiAgentEndEvent,
  isPiAgentSettledEvent,
  isPiMessageUpdateEvent,
  isPiResponseEvent,
  isPiToolExecutionEndEvent,
  isTurnCompletedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";

function frame(
  eventType: string,
  payload: unknown,
  origin: AxonEventView["origin"] = "AGENT_EVENT",
): AxonEventView {
  return {
    axon_id: "axn_pi",
    event_type: eventType,
    origin,
    payload: JSON.stringify(payload),
    sequence: 7,
    source: "pi",
    timestamp_ms: 1_752_192_000_000,
  };
}

/** One wire-correct payload per modelled event type, keyed by `event_type`. */
const EVENT_PAYLOADS: Record<string, unknown> = {
  agent_start: { type: "agent_start" },
  message_start: {
    type: "message_start",
    message: { role: "user", content: "hello", timestamp: 1_700_000_000_000 },
  },
  message_update: {
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "Hi" }], "stop"),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hi",
      partial: assistantMessage([{ type: "text", text: "Hi" }], "stop"),
    },
  },
  message_end: {
    type: "message_end",
    message: assistantMessage(
      [
        { type: "thinking", thinking: "checking" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
      ],
      "toolUse",
    ),
  },
  tool_execution_start: {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "pwd" },
  },
  tool_execution_update: {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "pwd" },
    partialResult: { content: [{ type: "text", text: "/work" }] },
  },
  tool_execution_end: {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "/work" }] },
    isError: false,
  },
  turn_start: { type: "turn_start" },
  turn_end: {
    type: "turn_end",
    message: assistantMessage([{ type: "text", text: "done" }], "stop"),
    toolResults: [toolResultMessage()],
  },
  agent_end: {
    type: "agent_end",
    messages: [assistantMessage([{ type: "text", text: "retrying" }], "error")],
    willRetry: true,
  },
  agent_settled: { type: "agent_settled" },
};

describe("classifyPiAxonEvent", () => {
  it.each(PI_EVENT_TYPES)("classifies the %s event as pi_protocol", (eventType) => {
    const event = classifyPiAxonEvent(frame(eventType, EVENT_PAYLOADS[eventType]));
    expect(event.kind).toBe("pi_protocol");
    if (event.kind === "pi_protocol") expect(event.eventType).toBe(eventType);
  });

  it("classifies a message_update carrying its streaming delta", () => {
    const event = classifyPiAxonEvent(frame("message_update", EVENT_PAYLOADS.message_update));
    expect(isPiMessageUpdateEvent(event)).toBe(true);
    if (isPiMessageUpdateEvent(event)) {
      const delta = event.data.assistantMessageEvent;
      expect(delta.type).toBe("text_delta");
      if (delta.type === "text_delta") expect(delta.delta).toBe("Hi");
    }
  });

  it("classifies a tool_execution_end result and its error flag", () => {
    const event = classifyPiAxonEvent(
      frame("tool_execution_end", EVENT_PAYLOADS.tool_execution_end),
    );
    expect(isPiToolExecutionEndEvent(event)).toBe(true);
    if (isPiToolExecutionEndEvent(event)) {
      expect(event.data.toolCallId).toBe("call-1");
      expect(event.data.isError).toBe(false);
    }
  });

  it("classifies agent_end with its retry flag separately from agent_settled", () => {
    const end = classifyPiAxonEvent(frame("agent_end", EVENT_PAYLOADS.agent_end));
    expect(isPiAgentEndEvent(end)).toBe(true);
    if (isPiAgentEndEvent(end)) expect(end.data.willRetry).toBe(true);
    expect(isPiAgentSettledEvent(end)).toBe(false);
    expect(
      isPiAgentSettledEvent(classifyPiAxonEvent(frame("agent_settled", { type: "agent_settled" }))),
    ).toBe(true);
  });

  it("classifies a get_state acknowledgement including its session state", () => {
    const event = classifyPiAxonEvent(
      frame("response", {
        type: "response",
        id: "req-1",
        command: "get_state",
        success: true,
        data: {
          model: null,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: "/sessions/current.jsonl",
          sessionId: "session-1",
          autoCompactionEnabled: true,
          messageCount: 5,
          pendingMessageCount: 0,
        },
      }),
    );
    expect(isPiResponseEvent(event)).toBe(true);
    if (isPiResponseEvent(event)) {
      expect(event.data.command).toBe("get_state");
      expect(event.data.success).toBe(true);
    }
  });

  it("classifies a rejected prompt acknowledgement with its error", () => {
    const event = classifyPiAxonEvent(
      frame("response", {
        type: "response",
        command: "prompt",
        success: false,
        error: "agent is streaming",
      }),
    );
    expect(isPiResponseEvent(event)).toBe(true);
    if (isPiResponseEvent(event)) expect(event.data.error).toBe("agent is streaming");
  });

  it("prefers shared SYSTEM_EVENT classification", () => {
    const event = classifyPiAxonEvent(
      frame("turn.completed", { turn_id: "turn-1", stop_reason: "end_turn" }, "SYSTEM_EVENT"),
    );
    expect(isTurnCompletedEvent(event)).toBe(true);
  });

  it("leaves unmodelled Pi frames unknown with the payload reachable", () => {
    const event = classifyPiAxonEvent(frame("queue_update", { type: "queue_update", queued: 2 }));
    expect(isUnknownTimelineEvent(event)).toBe(true);
    expect(event.data).toEqual({ type: "queue_update", queued: 2 });
    expect(event.axonEvent.payload).toBe(JSON.stringify({ type: "queue_update", queued: 2 }));
  });

  it("falls through to unknown when a protocol payload is not an object", () => {
    expect(isUnknownTimelineEvent(classifyPiAxonEvent(frame("agent_settled", "not-a-frame")))).toBe(
      true,
    );
  });
});

describe("isPiProtocolEventType", () => {
  it.each(PI_EVENT_TYPES)("recognizes %s", (eventType) => {
    expect(isPiProtocolEventType(eventType)).toBe(true);
  });

  it("recognizes response and rejects unmodelled and outbound event types", () => {
    expect(isPiProtocolEventType("response")).toBe(true);
    expect(isPiProtocolEventType("queue_update")).toBe(false);
    expect(isPiProtocolEventType("auto_retry_start")).toBe(false);
    // Outbound broker control names never arrive as agent events.
    expect(isPiProtocolEventType("turn/start")).toBe(false);
    expect(isPiProtocolEventType("cancel")).toBe(false);
  });
});

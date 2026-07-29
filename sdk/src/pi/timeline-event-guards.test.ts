import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { describe, expect, it } from "vitest";
import { assistantMessage, messageUpdate } from "../__test-utils__/pi-fixtures.js";
import type { PiEvent, PiResponse } from "./protocol/index.js";
import {
  isPiAgentEndEvent,
  isPiAgentSettledEvent,
  isPiAgentStartEvent,
  isPiAssistantTextDeltaEvent,
  isPiAssistantThinkingDeltaEvent,
  isPiMessageEndEvent,
  isPiMessageStartEvent,
  isPiMessageUpdateEvent,
  isPiProtocolEvent,
  isPiResponseEvent,
  isPiToolExecutionEndEvent,
  isPiToolExecutionStartEvent,
  isPiToolExecutionUpdateEvent,
  isPiTurnEndEvent,
  isPiTurnStartEvent,
  isSystemTimelineEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
import type { PiProtocolTimelineEvent, PiTimelineEvent } from "./types.js";

function axonEvent(eventType: string, payload: unknown): AxonEventView {
  return {
    axon_id: "axn_pi",
    event_type: eventType,
    origin: "AGENT_EVENT",
    payload: JSON.stringify(payload),
    sequence: 3,
    source: "pi",
    timestamp_ms: 1_752_192_000_000,
  };
}

function protocolEvent(frame: PiEvent | PiResponse): PiTimelineEvent {
  return {
    kind: "pi_protocol",
    eventType: frame.type,
    data: frame,
    axonEvent: axonEvent(frame.type, frame),
  } as PiProtocolTimelineEvent;
}

const systemEvent: PiTimelineEvent = {
  kind: "system",
  data: { type: "turn.started", turnId: "turn-1" },
  axonEvent: axonEvent("turn.started", { turn_id: "turn-1" }),
};

const unknownEvent: PiTimelineEvent = {
  kind: "unknown",
  data: { type: "queue_update" },
  axonEvent: axonEvent("queue_update", { type: "queue_update" }),
};

describe("Pi protocol guards", () => {
  it.each([
    [isPiAgentStartEvent, { type: "agent_start" } as PiEvent],
    [
      isPiMessageStartEvent,
      { type: "message_start", message: assistantMessage([], "stop") } as PiEvent,
    ],
    [
      isPiMessageUpdateEvent,
      messageUpdate({ type: "start", partial: assistantMessage([], "stop") }) as PiEvent,
    ],
    [
      isPiMessageEndEvent,
      { type: "message_end", message: assistantMessage([], "stop") } as PiEvent,
    ],
    [
      isPiToolExecutionStartEvent,
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} } as PiEvent,
    ],
    [
      isPiToolExecutionUpdateEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "bash",
        args: {},
        partialResult: {},
      } as PiEvent,
    ],
    [
      isPiToolExecutionEndEvent,
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: {},
        isError: false,
      } as PiEvent,
    ],
    [isPiTurnStartEvent, { type: "turn_start" } as PiEvent],
    [
      isPiTurnEndEvent,
      { type: "turn_end", message: assistantMessage([], "stop"), toolResults: [] } as PiEvent,
    ],
    [isPiAgentEndEvent, { type: "agent_end", messages: [], willRetry: false } as PiEvent],
    [isPiAgentSettledEvent, { type: "agent_settled" } as PiEvent],
  ])("matches only its own event type", (guard, frame) => {
    const event = protocolEvent(frame);
    expect(guard(event)).toBe(true);
    expect(isPiProtocolEvent(event)).toBe(true);
    expect(guard(systemEvent)).toBe(false);
    expect(guard(unknownEvent)).toBe(false);
    // Every guard is exclusive: no other modelled frame satisfies it.
    expect(guard(protocolEvent({ type: "response", command: "prompt", success: true }))).toBe(
      false,
    );
  });

  it("matches acknowledgement frames", () => {
    const event = protocolEvent({ type: "response", command: "prompt", success: true });
    expect(isPiResponseEvent(event)).toBe(true);
    if (isPiResponseEvent(event)) expect(event.data.command).toBe("prompt");
    expect(isPiResponseEvent(protocolEvent({ type: "agent_settled" }))).toBe(false);
  });

  it("narrows message_update to text and thinking deltas", () => {
    const partial = assistantMessage([{ type: "text", text: "Hi" }], "stop");
    const text = protocolEvent(
      messageUpdate({ type: "text_delta", contentIndex: 0, delta: "Hi", partial }),
    );
    const thinking = protocolEvent(
      messageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "hmm", partial }),
    );
    const start = protocolEvent(messageUpdate({ type: "start", partial }));

    expect(isPiAssistantTextDeltaEvent(text)).toBe(true);
    if (isPiAssistantTextDeltaEvent(text)) expect(text.data.assistantMessageEvent.delta).toBe("Hi");
    expect(isPiAssistantThinkingDeltaEvent(thinking)).toBe(true);
    if (isPiAssistantThinkingDeltaEvent(thinking))
      expect(thinking.data.assistantMessageEvent.delta).toBe("hmm");

    expect(isPiAssistantTextDeltaEvent(thinking)).toBe(false);
    expect(isPiAssistantThinkingDeltaEvent(text)).toBe(false);
    expect(isPiAssistantTextDeltaEvent(start)).toBe(false);
    expect(isPiAssistantThinkingDeltaEvent(start)).toBe(false);
    expect(isPiAssistantTextDeltaEvent(unknownEvent)).toBe(false);
  });

  it("re-exports the shared system and unknown guards", () => {
    expect(isSystemTimelineEvent(systemEvent)).toBe(true);
    expect(isTurnStartedEvent(systemEvent)).toBe(true);
    expect(isUnknownTimelineEvent(unknownEvent)).toBe(true);
    expect(isPiProtocolEvent(systemEvent)).toBe(false);
  });
});

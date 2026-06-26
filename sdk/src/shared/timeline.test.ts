import { describe, expect, it, vi } from "vitest";
import { makeFullAxonEvent as makeAxonEvent } from "../__test-utils__/mock-axon.js";
import {
  createClassifier,
  isTurnFailedAxonEvent,
  tryParseSystemEvent,
  tryParseTimelinePayload,
} from "./timeline.js";

describe("tryParseTimelinePayload", () => {
  it("parses a JSON string payload", () => {
    const ev = makeAxonEvent({ payload: '{"key":"value"}' });
    expect(tryParseTimelinePayload({ axonEvent: ev })).toEqual({ key: "value" });
  });

  it("returns the payload as-is when it is already an object", () => {
    const ev = makeAxonEvent({ payload: { key: "value" } as unknown as string });
    expect(tryParseTimelinePayload({ axonEvent: ev })).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON and logs a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = makeAxonEvent({
      payload: "not json",
      event_type: "custom.bad",
      sequence: 99,
    });
    expect(tryParseTimelinePayload({ axonEvent: ev })).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("custom.bad");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("sequence=99");
    warnSpy.mockRestore();
  });

  it("returns null for undefined payload", () => {
    const ev = makeAxonEvent({ payload: undefined as unknown as string });
    expect(tryParseTimelinePayload({ axonEvent: ev })).toBeNull();
  });
});

describe("tryParseSystemEvent", () => {
  it("parses turn.started", () => {
    const ev = makeAxonEvent({
      event_type: "turn.started",
      payload: JSON.stringify({ turn_id: "t-1" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({ type: "turn.started", turnId: "t-1" });
  });

  it("parses turn.completed with stopReason", () => {
    const ev = makeAxonEvent({
      event_type: "turn.completed",
      payload: JSON.stringify({ turn_id: "t-2", stop_reason: "end_turn" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "turn.completed",
      turnId: "t-2",
      stopReason: "end_turn",
    });
  });

  it("parses turn.completed without stopReason", () => {
    const ev = makeAxonEvent({
      event_type: "turn.completed",
      payload: JSON.stringify({ turn_id: "t-3" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "turn.completed",
      turnId: "t-3",
      stopReason: undefined,
    });
  });

  it("parses turn.failed with full payload", () => {
    const ev = makeAxonEvent({
      event_type: "turn.failed",
      payload: JSON.stringify({
        turn_id: "t-4",
        error: "You have exhausted your daily quota on this model.",
        stop_reason: "Error",
      }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "turn.failed",
      turnId: "t-4",
      error: "You have exhausted your daily quota on this model.",
      stopReason: "Error",
    });
  });

  it("parses turn.failed with missing turn_id and stop_reason", () => {
    const ev = makeAxonEvent({
      event_type: "turn.failed",
      payload: JSON.stringify({ error: "boom" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "turn.failed",
      turnId: "",
      error: "boom",
      stopReason: undefined,
    });
  });

  it("parses turn.failed missing error field falls back to stringified payload", () => {
    const ev = makeAxonEvent({
      event_type: "turn.failed",
      payload: JSON.stringify({ turn_id: "t-5", stop_reason: "Error" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "turn.failed",
      turnId: "t-5",
      error: JSON.stringify({ turn_id: "t-5", stop_reason: "Error" }),
      stopReason: "Error",
    });
  });

  it("parses turn.failed with raw string payload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ev = makeAxonEvent({
        event_type: "turn.failed",
        payload: "raw failure string",
      });
      expect(tryParseSystemEvent(ev)).toEqual({
        type: "turn.failed",
        turnId: "",
        error: "raw failure string",
        stopReason: undefined,
      });
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("parses broker.error with message field", () => {
    const ev = makeAxonEvent({
      event_type: "broker.error",
      payload: JSON.stringify({ message: "something went wrong" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "broker.error",
      message: "something went wrong",
    });
  });

  it("parses broker.error falling back to stringified payload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = makeAxonEvent({
      event_type: "broker.error",
      payload: "raw error string",
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "broker.error",
      message: "raw error string",
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("parses broker.error with JSON object missing message key", () => {
    const ev = makeAxonEvent({
      event_type: "broker.error",
      payload: JSON.stringify({ code: 500 }),
    });
    const result = tryParseSystemEvent(ev);
    expect(result).toEqual({
      type: "broker.error",
      message: JSON.stringify({ code: 500 }),
    });
  });

  it("returns null for invalid JSON on turn events", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = makeAxonEvent({
      event_type: "turn.started",
      payload: "not json",
    });
    expect(tryParseSystemEvent(ev)).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns null for unrecognized event_type", () => {
    const ev = makeAxonEvent({ event_type: "custom.event" });
    expect(tryParseSystemEvent(ev)).toBeNull();
  });

  it("parses devbox.running", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.running",
      payload: JSON.stringify({ devbox_id: "dbx_1" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "devbox.lifecycle",
      kind: "running",
      devboxId: "dbx_1",
    });
  });

  it("parses devbox.suspended", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.suspended",
      payload: JSON.stringify({ devbox_id: "dbx_2" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "devbox.lifecycle",
      kind: "suspended",
      devboxId: "dbx_2",
    });
  });

  it("parses devbox.shutdown", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.shutdown",
      payload: JSON.stringify({ devbox_id: "dbx_3" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "devbox.lifecycle",
      kind: "shutdown",
      devboxId: "dbx_3",
    });
  });

  it("parses devbox.failed with reason", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.failed",
      payload: JSON.stringify({ devbox_id: "dbx_4", reason: "deadline exceeded" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "devbox.lifecycle",
      kind: "failed",
      devboxId: "dbx_4",
      reason: "deadline exceeded",
    });
  });

  it("parses devbox.failed with missing reason leaves it undefined", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.failed",
      payload: JSON.stringify({ devbox_id: "dbx_5" }),
    });
    const result = tryParseSystemEvent(ev);
    expect(result).toEqual({
      type: "devbox.lifecycle",
      kind: "failed",
      devboxId: "dbx_5",
      reason: undefined,
    });
  });

  it("returns null for devbox event missing devbox_id", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.running",
      payload: JSON.stringify({}),
    });
    expect(tryParseSystemEvent(ev)).toBeNull();
  });

  it("returns null for unrecognized devbox.* suffix", () => {
    const ev = makeAxonEvent({
      event_type: "devbox.unknown_state",
      payload: JSON.stringify({ devbox_id: "dbx_6" }),
    });
    expect(tryParseSystemEvent(ev)).toBeNull();
  });

  it("parses agent.error", () => {
    const ev = makeAxonEvent({
      event_type: "agent.error",
      payload: JSON.stringify({ devbox_id: "dbx_7", type: "launch", message: "failed to start" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "agent.error",
      devboxId: "dbx_7",
      errorType: "launch",
      message: "failed to start",
    });
  });

  it("parses agent.error with missing optional fields leaves them undefined", () => {
    const ev = makeAxonEvent({
      event_type: "agent.error",
      payload: JSON.stringify({ devbox_id: "dbx_8" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "agent.error",
      devboxId: "dbx_8",
      errorType: undefined,
      message: undefined,
    });
  });

  it("returns null for agent.error missing devbox_id", () => {
    const ev = makeAxonEvent({
      event_type: "agent.error",
      payload: JSON.stringify({ type: "launch", message: "boom" }),
    });
    expect(tryParseSystemEvent(ev)).toBeNull();
  });

  it("parses agent.log with log_type and message", () => {
    const ev = makeAxonEvent({
      event_type: "agent.log",
      payload: JSON.stringify({ log_type: "stderr", message: "something happened" }),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "agent.log",
      logType: "stderr",
      message: "something happened",
    });
  });

  it("parses agent.log with missing optional fields uses defaults", () => {
    const ev = makeAxonEvent({
      event_type: "agent.log",
      payload: JSON.stringify({}),
    });
    expect(tryParseSystemEvent(ev)).toEqual({
      type: "agent.log",
      logType: "stderr",
      message: "",
    });
  });

  it("returns null for agent.log with unparseable payload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = makeAxonEvent({
      event_type: "agent.log",
      payload: "not json",
    });
    expect(tryParseSystemEvent(ev)).toBeNull();
    warnSpy.mockRestore();
  });
});

describe("isTurnFailedAxonEvent", () => {
  it("returns true for SYSTEM_EVENT origin with turn.failed event_type", () => {
    const ev = makeAxonEvent({
      origin: "SYSTEM_EVENT",
      event_type: "turn.failed",
      payload: JSON.stringify({ error: "boom" }),
    });
    expect(isTurnFailedAxonEvent(ev)).toBe(true);
  });

  it("returns false for SYSTEM_EVENT with a different event_type", () => {
    const ev = makeAxonEvent({
      origin: "SYSTEM_EVENT",
      event_type: "turn.completed",
      payload: JSON.stringify({ turn_id: "t-1" }),
    });
    expect(isTurnFailedAxonEvent(ev)).toBe(false);
  });

  it("returns false for turn.failed event_type with a non-SYSTEM origin", () => {
    const ev = makeAxonEvent({
      origin: "AGENT_EVENT",
      event_type: "turn.failed",
      payload: JSON.stringify({ error: "boom" }),
    });
    expect(isTurnFailedAxonEvent(ev)).toBe(false);
  });

  it("returns false for unrelated SYSTEM_EVENTs", () => {
    const ev = makeAxonEvent({
      origin: "SYSTEM_EVENT",
      event_type: "broker.error",
      payload: "agent crashed",
    });
    expect(isTurnFailedAxonEvent(ev)).toBe(false);
  });
});

describe("createClassifier", () => {
  const classify = createClassifier<{ kind: "test"; data: unknown; axonEvent: unknown }>({
    label: "testClassifier",
    isProtocolEventType: (t) => t.startsWith("test."),
    toProtocolEvent: (data, ev) => ({ kind: "test", data, axonEvent: ev }),
  });

  it("classifies SYSTEM_EVENT origin as system timeline events", () => {
    const ev = makeAxonEvent({
      origin: "SYSTEM_EVENT",
      event_type: "turn.started",
      payload: JSON.stringify({ turn_id: "t-1" }),
    });
    const result = classify(ev);
    expect(result.kind).toBe("system");
  });

  it("classifies known protocol event types as protocol events", () => {
    const ev = makeAxonEvent({
      origin: "AGENT_EVENT",
      event_type: "test.foo",
      payload: JSON.stringify({ bar: 1 }),
    });
    const result = classify(ev);
    expect(result.kind).toBe("test");
    expect(result.data).toEqual({ bar: 1 });
  });

  it("classifies unknown event types as unknown", () => {
    const ev = makeAxonEvent({
      origin: "AGENT_EVENT",
      event_type: "other.event",
      payload: "{}",
    });
    const result = classify(ev);
    expect(result.kind).toBe("unknown");
  });

  it("routes parse errors to onError callback instead of console.warn", () => {
    const onError = vi.fn();
    const classifyWithHandler = createClassifier({
      label: "errTest",
      isProtocolEventType: (t) => t === "bad.json",
      toProtocolEvent: () => null,
      onError,
    });

    const ev = makeAxonEvent({
      origin: "AGENT_EVENT",
      event_type: "bad.json",
      payload: "not valid json",
    });
    classifyWithHandler(ev);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain("[errTest] Failed to parse payload");
  });

  it("handles non-string payload as-is", () => {
    const ev = makeAxonEvent({
      origin: "AGENT_EVENT",
      event_type: "test.obj",
      payload: { nested: true } as unknown as string,
    });
    const result = classify(ev);
    expect(result.kind).toBe("test");
    expect(result.data).toEqual({ nested: true });
  });
});

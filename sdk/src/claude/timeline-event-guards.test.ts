import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { describe, expect, it } from "vitest";
import {
  isBrokerErrorEvent,
  isClaudeAssistantEvent,
  isClaudeAssistantTextEvent,
  isClaudeControlRequestEvent,
  isClaudeControlResponseEvent,
  isClaudeProtocolEvent,
  isClaudeQueryEvent,
  isClaudeResultEvent,
  isClaudeSystemInitEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
import type { ClaudeTimelineEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeAxonEvent(eventType: string, origin: "AGENT_EVENT" | "USER_EVENT"): AxonEventView {
  return {
    axon_id: "axn_test",
    event_type: eventType,
    origin,
    payload: JSON.stringify({ test: true }),
    sequence: 1,
    source: "test",
    timestamp_ms: Date.now(),
  };
}

function makeProtocolTimelineEvent(
  eventType: string,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  data: any = { test: true },
): ClaudeTimelineEvent {
  return {
    kind: "claude_protocol",
    eventType,
    data,
    axonEvent: makeAxonEvent(eventType, "AGENT_EVENT"),
  } as ClaudeTimelineEvent;
}

function makeSystemTimelineEvent(
  type: "turn.started" | "turn.completed" | "turn.failed" | "broker.error",
): ClaudeTimelineEvent {
  const data =
    type === "turn.started"
      ? { type, turnId: "t-1" }
      : type === "turn.completed"
        ? { type, turnId: "t-1" }
        : type === "turn.failed"
          ? { type, turnId: "t-1", error: "boom" }
          : { type, message: "test error" };
  return {
    kind: "system",
    data,
    axonEvent: makeAxonEvent(type, "AGENT_EVENT"),
  };
}

function makeUnknownTimelineEvent(): ClaudeTimelineEvent {
  return {
    kind: "unknown",
    data: null,
    axonEvent: makeAxonEvent("custom/unknown", "AGENT_EVENT"),
  };
}

// ---------------------------------------------------------------------------
// System event guards
// ---------------------------------------------------------------------------

describe("isSystemTimelineEvent", () => {
  it("returns true for system events", () => {
    expect(isSystemTimelineEvent(makeSystemTimelineEvent("turn.started"))).toBe(true);
    expect(isSystemTimelineEvent(makeSystemTimelineEvent("turn.completed"))).toBe(true);
    expect(isSystemTimelineEvent(makeSystemTimelineEvent("broker.error"))).toBe(true);
  });

  it("returns false for protocol events", () => {
    expect(isSystemTimelineEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });

  it("returns false for unknown events", () => {
    expect(isSystemTimelineEvent(makeUnknownTimelineEvent())).toBe(false);
  });
});

describe("isTurnStartedEvent", () => {
  it("returns true for turn.started system events", () => {
    expect(isTurnStartedEvent(makeSystemTimelineEvent("turn.started"))).toBe(true);
  });

  it("returns false for other system events", () => {
    expect(isTurnStartedEvent(makeSystemTimelineEvent("turn.completed"))).toBe(false);
    expect(isTurnStartedEvent(makeSystemTimelineEvent("broker.error"))).toBe(false);
  });

  it("returns false for protocol events", () => {
    expect(isTurnStartedEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });
});

describe("isTurnCompletedEvent", () => {
  it("returns true for turn.completed system events", () => {
    expect(isTurnCompletedEvent(makeSystemTimelineEvent("turn.completed"))).toBe(true);
  });

  it("returns false for other system events", () => {
    expect(isTurnCompletedEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
    expect(isTurnCompletedEvent(makeSystemTimelineEvent("turn.failed"))).toBe(false);
    expect(isTurnCompletedEvent(makeSystemTimelineEvent("broker.error"))).toBe(false);
  });

  it("returns false for protocol events", () => {
    expect(isTurnCompletedEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });
});

describe("isTurnFailedEvent", () => {
  it("returns true for turn.failed system events", () => {
    expect(isTurnFailedEvent(makeSystemTimelineEvent("turn.failed"))).toBe(true);
  });

  it("returns false for other system events", () => {
    expect(isTurnFailedEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
    expect(isTurnFailedEvent(makeSystemTimelineEvent("turn.completed"))).toBe(false);
    expect(isTurnFailedEvent(makeSystemTimelineEvent("broker.error"))).toBe(false);
  });

  it("returns false for protocol events", () => {
    expect(isTurnFailedEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });

  it("returns false for unknown events", () => {
    expect(isTurnFailedEvent(makeUnknownTimelineEvent())).toBe(false);
  });
});

describe("isBrokerErrorEvent", () => {
  it("returns true for broker.error system events", () => {
    expect(isBrokerErrorEvent(makeSystemTimelineEvent("broker.error"))).toBe(true);
  });

  it("returns false for other system events", () => {
    expect(isBrokerErrorEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
    expect(isBrokerErrorEvent(makeSystemTimelineEvent("turn.completed"))).toBe(false);
  });

  it("returns false for protocol events", () => {
    expect(isBrokerErrorEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claude protocol event guards
// ---------------------------------------------------------------------------

describe("isClaudeProtocolEvent", () => {
  it("returns true for claude_protocol events", () => {
    expect(isClaudeProtocolEvent(makeProtocolTimelineEvent("assistant"))).toBe(true);
    expect(isClaudeProtocolEvent(makeProtocolTimelineEvent("result"))).toBe(true);
  });

  it("returns false for system events", () => {
    expect(isClaudeProtocolEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });

  it("returns false for unknown events", () => {
    expect(isClaudeProtocolEvent(makeUnknownTimelineEvent())).toBe(false);
  });
});

describe("isClaudeAssistantEvent", () => {
  it("returns true for assistant events", () => {
    expect(isClaudeAssistantEvent(makeProtocolTimelineEvent("assistant"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeAssistantEvent(makeProtocolTimelineEvent("result"))).toBe(false);
    expect(isClaudeAssistantEvent(makeProtocolTimelineEvent("query"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isClaudeAssistantEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeAssistantTextEvent", () => {
  it("returns true for assistant events with non-empty text", () => {
    const event = makeProtocolTimelineEvent("assistant", {
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(isClaudeAssistantTextEvent(event)).toBe(true);
  });

  it("returns false for assistant events with empty text", () => {
    const event = makeProtocolTimelineEvent("assistant", {
      message: { content: [{ type: "text", text: "   " }] },
    });
    expect(isClaudeAssistantTextEvent(event)).toBe(false);
  });

  it("returns false for assistant events with no text blocks", () => {
    const event = makeProtocolTimelineEvent("assistant", {
      message: { content: [{ type: "tool_use", id: "t1", name: "test" }] },
    });
    expect(isClaudeAssistantTextEvent(event)).toBe(false);
  });

  it("returns false for assistant events with missing content", () => {
    const event = makeProtocolTimelineEvent("assistant", { message: {} });
    expect(isClaudeAssistantTextEvent(event)).toBe(false);
  });

  it("returns false for non-assistant events", () => {
    expect(isClaudeAssistantTextEvent(makeProtocolTimelineEvent("result"))).toBe(false);
    expect(isClaudeAssistantTextEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeResultEvent", () => {
  it("returns true for result events", () => {
    expect(isClaudeResultEvent(makeProtocolTimelineEvent("result"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeResultEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
    expect(isClaudeResultEvent(makeProtocolTimelineEvent("query"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isClaudeResultEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeQueryEvent", () => {
  it("returns true for query events", () => {
    expect(isClaudeQueryEvent(makeProtocolTimelineEvent("query"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeQueryEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
    expect(isClaudeQueryEvent(makeProtocolTimelineEvent("result"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isClaudeQueryEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeSystemInitEvent", () => {
  it("returns true for system init events", () => {
    expect(isClaudeSystemInitEvent(makeProtocolTimelineEvent("system"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeSystemInitEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
    expect(isClaudeSystemInitEvent(makeProtocolTimelineEvent("result"))).toBe(false);
  });

  it("returns false for system timeline events", () => {
    expect(isClaudeSystemInitEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeControlRequestEvent", () => {
  it("returns true for control_request events", () => {
    expect(isClaudeControlRequestEvent(makeProtocolTimelineEvent("control_request"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeControlRequestEvent(makeProtocolTimelineEvent("control_response"))).toBe(false);
    expect(isClaudeControlRequestEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isClaudeControlRequestEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isClaudeControlResponseEvent", () => {
  it("returns true for control_response events", () => {
    expect(isClaudeControlResponseEvent(makeProtocolTimelineEvent("control_response"))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isClaudeControlResponseEvent(makeProtocolTimelineEvent("control_request"))).toBe(false);
    expect(isClaudeControlResponseEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isClaudeControlResponseEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown event guard
// ---------------------------------------------------------------------------

describe("isUnknownTimelineEvent", () => {
  it("returns true for unknown events", () => {
    expect(isUnknownTimelineEvent(makeUnknownTimelineEvent())).toBe(true);
  });

  it("returns false for protocol events", () => {
    expect(isUnknownTimelineEvent(makeProtocolTimelineEvent("assistant"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isUnknownTimelineEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

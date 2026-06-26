import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { AxonEventView } from "@runloop/api-client/resources/axons";
import { describe, expect, it } from "vitest";
import {
  isACPProtocolEvent,
  isBrokerErrorEvent,
  isElicitationCompleteEvent,
  isElicitationRequestEvent,
  isElicitationResponseEvent,
  isInitializeEvent,
  isNewSessionEvent,
  isPromptEvent,
  isSessionUpdateEvent,
  isSystemTimelineEvent,
  isTurnCompletedEvent,
  isTurnFailedEvent,
  isTurnStartedEvent,
  isUnknownTimelineEvent,
} from "./timeline-event-guards.js";
import type { ACPTimelineEvent } from "./types.js";

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
  origin: "AGENT_EVENT" | "USER_EVENT" = "AGENT_EVENT",
): ACPTimelineEvent {
  return {
    kind: "acp_protocol",
    eventType,
    data: { test: true },
    axonEvent: makeAxonEvent(eventType, origin),
  };
}

function makeSystemTimelineEvent(
  type: "turn.started" | "turn.completed" | "turn.failed" | "broker.error",
  extra: Record<string, unknown> = {},
): ACPTimelineEvent {
  const data =
    type === "turn.started"
      ? { type, turnId: "t-1" }
      : type === "turn.completed"
        ? { type, turnId: "t-1", ...extra }
        : type === "turn.failed"
          ? { type, turnId: "t-1", error: "boom", ...extra }
          : { type, message: "test error" };
  return {
    kind: "system",
    data,
    axonEvent: makeAxonEvent(type, "AGENT_EVENT"),
  };
}

function makeUnknownTimelineEvent(): ACPTimelineEvent {
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
    expect(isSystemTimelineEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
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
    expect(isTurnStartedEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
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
    expect(isTurnCompletedEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
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
    expect(isTurnFailedEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
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
    expect(isBrokerErrorEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACP protocol event guards
// ---------------------------------------------------------------------------

describe("isACPProtocolEvent", () => {
  it("returns true for acp_protocol events", () => {
    expect(isACPProtocolEvent(makeProtocolTimelineEvent("session/update"))).toBe(true);
    expect(isACPProtocolEvent(makeProtocolTimelineEvent("initialize"))).toBe(true);
  });

  it("returns false for system events", () => {
    expect(isACPProtocolEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });

  it("returns false for unknown events", () => {
    expect(isACPProtocolEvent(makeUnknownTimelineEvent())).toBe(false);
  });
});

describe("isSessionUpdateEvent", () => {
  it("returns true for session/update events", () => {
    expect(isSessionUpdateEvent(makeProtocolTimelineEvent(CLIENT_METHODS.session_update))).toBe(
      true,
    );
  });

  it("returns false for other protocol events", () => {
    expect(isSessionUpdateEvent(makeProtocolTimelineEvent(AGENT_METHODS.initialize))).toBe(false);
    expect(isSessionUpdateEvent(makeProtocolTimelineEvent(AGENT_METHODS.session_prompt))).toBe(
      false,
    );
  });

  it("returns false for system events", () => {
    expect(isSessionUpdateEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isInitializeEvent", () => {
  it("returns true for initialize events", () => {
    expect(isInitializeEvent(makeProtocolTimelineEvent(AGENT_METHODS.initialize))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isInitializeEvent(makeProtocolTimelineEvent(CLIENT_METHODS.session_update))).toBe(false);
    expect(isInitializeEvent(makeProtocolTimelineEvent(AGENT_METHODS.session_prompt))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isInitializeEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isPromptEvent", () => {
  it("returns true for session/prompt events", () => {
    expect(isPromptEvent(makeProtocolTimelineEvent(AGENT_METHODS.session_prompt))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isPromptEvent(makeProtocolTimelineEvent(AGENT_METHODS.initialize))).toBe(false);
    expect(isPromptEvent(makeProtocolTimelineEvent(CLIENT_METHODS.session_update))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isPromptEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

describe("isNewSessionEvent", () => {
  it("returns true for session/new events", () => {
    expect(isNewSessionEvent(makeProtocolTimelineEvent(AGENT_METHODS.session_new))).toBe(true);
  });

  it("returns false for other protocol events", () => {
    expect(isNewSessionEvent(makeProtocolTimelineEvent(AGENT_METHODS.initialize))).toBe(false);
    expect(isNewSessionEvent(makeProtocolTimelineEvent(AGENT_METHODS.session_prompt))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isNewSessionEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
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
    expect(isUnknownTimelineEvent(makeProtocolTimelineEvent("session/update"))).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isUnknownTimelineEvent(makeSystemTimelineEvent("turn.started"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Elicitation event guards
// ---------------------------------------------------------------------------

describe("isElicitationRequestEvent", () => {
  it("returns true for session/elicitation AGENT_EVENT", () => {
    const event = makeProtocolTimelineEvent(CLIENT_METHODS.session_elicitation, "AGENT_EVENT");
    expect(isElicitationRequestEvent(event)).toBe(true);
  });

  it("returns false for session/elicitation USER_EVENT (response)", () => {
    const event = makeProtocolTimelineEvent(CLIENT_METHODS.session_elicitation, "USER_EVENT");
    expect(isElicitationRequestEvent(event)).toBe(false);
  });

  it("returns false for other protocol events", () => {
    const event = makeProtocolTimelineEvent("session/update", "AGENT_EVENT");
    expect(isElicitationRequestEvent(event)).toBe(false);
  });

  it("returns false for system events", () => {
    const event = makeSystemTimelineEvent("turn.started");
    expect(isElicitationRequestEvent(event)).toBe(false);
  });

  it("returns false for unknown events", () => {
    const event = makeUnknownTimelineEvent();
    expect(isElicitationRequestEvent(event)).toBe(false);
  });
});

describe("isElicitationResponseEvent", () => {
  it("returns true for session/elicitation USER_EVENT", () => {
    const event = makeProtocolTimelineEvent(CLIENT_METHODS.session_elicitation, "USER_EVENT");
    expect(isElicitationResponseEvent(event)).toBe(true);
  });

  it("returns false for session/elicitation AGENT_EVENT (request)", () => {
    const event = makeProtocolTimelineEvent(CLIENT_METHODS.session_elicitation, "AGENT_EVENT");
    expect(isElicitationResponseEvent(event)).toBe(false);
  });

  it("returns false for other protocol events", () => {
    const event = makeProtocolTimelineEvent("session/update", "USER_EVENT");
    expect(isElicitationResponseEvent(event)).toBe(false);
  });

  it("returns false for system events", () => {
    const event = makeSystemTimelineEvent("turn.started");
    expect(isElicitationResponseEvent(event)).toBe(false);
  });

  it("returns false for unknown events", () => {
    const event = makeUnknownTimelineEvent();
    expect(isElicitationResponseEvent(event)).toBe(false);
  });
});

describe("isElicitationCompleteEvent", () => {
  it("returns true for session/elicitation/complete AGENT_EVENT", () => {
    const event = makeProtocolTimelineEvent(
      CLIENT_METHODS.session_elicitation_complete,
      "AGENT_EVENT",
    );
    expect(isElicitationCompleteEvent(event)).toBe(true);
  });

  it("returns true for session/elicitation/complete USER_EVENT", () => {
    const event = makeProtocolTimelineEvent(
      CLIENT_METHODS.session_elicitation_complete,
      "USER_EVENT",
    );
    expect(isElicitationCompleteEvent(event)).toBe(true);
  });

  it("returns false for session/elicitation events", () => {
    const event = makeProtocolTimelineEvent(CLIENT_METHODS.session_elicitation, "AGENT_EVENT");
    expect(isElicitationCompleteEvent(event)).toBe(false);
  });

  it("returns false for other protocol events", () => {
    const event = makeProtocolTimelineEvent("session/update", "AGENT_EVENT");
    expect(isElicitationCompleteEvent(event)).toBe(false);
  });

  it("returns false for system events", () => {
    const event = makeSystemTimelineEvent("turn.started");
    expect(isElicitationCompleteEvent(event)).toBe(false);
  });

  it("returns false for unknown events", () => {
    const event = makeUnknownTimelineEvent();
    expect(isElicitationCompleteEvent(event)).toBe(false);
  });
});

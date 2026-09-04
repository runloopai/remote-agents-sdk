import { describe, expect, it } from "vitest";
import { makeFullAxonEvent as makeAxonEvent } from "../__test-utils__/mock-axon.js";
import { isBackgroundChangedEvent, isTurnResumedEvent } from "./timeline-event-guards.js";
import type { BaseTimelineEvent, SystemEvent } from "./types.js";

function systemEvent(data: SystemEvent): BaseTimelineEvent {
  return {
    kind: "system",
    data,
    axonEvent: makeAxonEvent({ event_type: data.type, origin: "SYSTEM_EVENT" }),
  } as BaseTimelineEvent;
}

describe("isTurnResumedEvent", () => {
  it("narrows turn.resumed and rejects other system events", () => {
    expect(isTurnResumedEvent(systemEvent({ type: "turn.resumed", turnId: "t-1" }))).toBe(true);
    expect(isTurnResumedEvent(systemEvent({ type: "turn.started", turnId: "t-1" }))).toBe(false);
  });
});

describe("isBackgroundChangedEvent", () => {
  it("narrows background.changed and rejects other system events", () => {
    expect(
      isBackgroundChangedEvent(
        systemEvent({ type: "background.changed", active: [{ id: "a", kind: "agent" }] }),
      ),
    ).toBe(true);
    expect(isBackgroundChangedEvent(systemEvent({ type: "turn.resumed", turnId: "t-1" }))).toBe(
      false,
    );
  });

  it("rejects non-system events", () => {
    const ev = {
      kind: "unknown",
      data: { type: "background.changed" },
      axonEvent: makeAxonEvent({ event_type: "background.changed" }),
    } as BaseTimelineEvent;
    expect(isBackgroundChangedEvent(ev)).toBe(false);
  });
});

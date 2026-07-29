import { describe, expect, it } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeUserEvent,
} from "../__test-utils__/mock-axon.js";
import { PiAxonTransport } from "./transport.js";

function setup(replayTargetSequence?: number) {
  const ctrl = createControllableStream(true);
  const { axon, published } = createMockAxon(ctrl);
  const transport = new PiAxonTransport(
    axon as never,
    replayTargetSequence != null ? { replayTargetSequence } : {},
  );
  return { ctrl, published, transport };
}

describe("PiAxonTransport", () => {
  it("publishes a prompt as turn/start with the frame verbatim", async () => {
    const { published, transport } = setup();
    await transport.connect();
    await transport.write({ type: "prompt", id: "pi-sdk-1", message: "hi" });
    expect(published[0]).toMatchObject({
      event_type: "turn/start",
      origin: "USER_EVENT",
      source: "pi-sdk-client",
    });
    expect(JSON.parse(published[0]?.payload ?? "null")).toEqual({
      type: "prompt",
      id: "pi-sdk-1",
      message: "hi",
    });
  });

  it("maps abort to cancel and leaves every other command as itself", async () => {
    const { published, transport } = setup();
    await transport.connect();
    await transport.write({ type: "abort", id: "pi-sdk-1" });
    await transport.write({ type: "steer", id: "pi-sdk-2", message: "actually" });
    await transport.write({ type: "follow_up", id: "pi-sdk-3", message: "and then" });
    await transport.write({ type: "get_state", id: "pi-sdk-4" });
    expect(published.map((call) => call.event_type)).toEqual([
      "cancel",
      "steer",
      "follow_up",
      "get_state",
    ]);
  });

  it("falls back to unknown for a frame with no type", async () => {
    const { published, transport } = setup();
    await transport.connect();
    await transport.write({ id: "pi-sdk-1" });
    expect(published[0]?.event_type).toBe("unknown");
  });

  it("rejects broker-reserved command ids", async () => {
    const { transport } = setup();
    await transport.connect();
    await expect(
      transport.write({ type: "prompt", id: "broker-1", message: "hi" }),
    ).rejects.toThrow("reserved");
  });

  // Pi has no server-initiated requests, so PiAxonTransport omits the four
  // replay-request callbacks and the shared transport buffers nothing.
  it("buffers nothing across the replay window", async () => {
    const { ctrl, transport } = setup(2);
    await transport.connect();
    ctrl.push(makeAgentEvent("agent_start", { type: "agent_start" }, 1));
    ctrl.push(makeUserEvent("turn/start", { type: "prompt", id: "pi-sdk-1", message: "hi" }, 2));
    ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }, 3));
    ctrl.end();
    const frames = [];
    for await (const frame of transport.readMessages()) frames.push(frame);
    expect(frames).toEqual([{ type: "agent_settled" }]);
  });

  it("skips unparseable payloads and reports readiness", async () => {
    const { ctrl, transport } = setup();
    expect(transport.isReady()).toBe(false);
    await transport.connect();
    expect(transport.isReady()).toBe(true);
    ctrl.push({ event_type: "agent_start", payload: "not json", origin: "AGENT_EVENT" });
    ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    ctrl.end();
    const frames = [];
    for await (const frame of transport.readMessages()) frames.push(frame);
    expect(frames).toEqual([{ type: "agent_settled" }]);
    await transport.close();
    expect(transport.isReady()).toBe(false);
  });
});

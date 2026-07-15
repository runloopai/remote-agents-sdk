import { describe, expect, it } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeUserEvent,
} from "../__test-utils__/mock-axon.js";
import { CodexAxonTransport } from "./transport.js";

describe("CodexAxonTransport", () => {
  it("publishes the complete frame using the method as event type", async () => {
    const ctrl = createControllableStream(true);
    const { axon, published } = createMockAxon(ctrl);
    const transport = new CodexAxonTransport(axon as never);
    await transport.connect();
    await transport.write({ method: "turn/start", id: "codex-sdk-1", params: { threadId: "t" } });
    expect(published[0]).toMatchObject({
      event_type: "turn/start",
      origin: "USER_EVENT",
      source: "codex-sdk-client",
    });
    expect(JSON.parse(published[0]?.payload ?? "null")).toEqual({
      method: "turn/start",
      id: "codex-sdk-1",
      params: { threadId: "t" },
    });
  });

  it("uses response for outbound response frames", async () => {
    const ctrl = createControllableStream(true);
    const { axon, published } = createMockAxon(ctrl);
    const transport = new CodexAxonTransport(axon as never);
    await transport.connect();
    await transport.write({ id: 7, result: { decision: "approved" } });
    expect(published[0]?.event_type).toBe("response");
  });

  it("rejects broker-reserved request ids", async () => {
    const ctrl = createControllableStream(true);
    const { axon } = createMockAxon(ctrl);
    const transport = new CodexAxonTransport(axon as never);
    await transport.connect();
    await expect(transport.write({ method: "x", id: "runloop-broker-1" })).rejects.toThrow(
      "reserved",
    );
  });

  it("buffers only unanswered server requests during replay", async () => {
    const ctrl = createControllableStream(true);
    const { axon } = createMockAxon(ctrl);
    const transport = new CodexAxonTransport(axon as never, { replayTargetSequence: 3 });
    await transport.connect();
    ctrl.push(makeAgentEvent("item/tool/call", { method: "item/tool/call", id: 1 }, 1));
    ctrl.push(makeUserEvent("response", { id: 1, result: {} }, 2));
    ctrl.push(
      makeAgentEvent(
        "item/commandExecution/requestApproval",
        { method: "item/commandExecution/requestApproval", id: 2, params: {} },
        3,
      ),
    );
    ctrl.end();
    const frames = [];
    for await (const frame of transport.readMessages()) frames.push(frame);
    expect(frames).toEqual([
      { method: "item/commandExecution/requestApproval", id: 2, params: {} },
    ]);
  });

  // Pins current behavior: an answer replayed before its request resolves
  // nothing, so the request is flushed as unanswered and the connection will
  // answer it again. Axon sequences are monotonic, so this should only occur
  // with out-of-order historical writes.
  it("flushes a replayed request whose answer arrived earlier in the stream", async () => {
    const ctrl = createControllableStream(true);
    const { axon } = createMockAxon(ctrl);
    const transport = new CodexAxonTransport(axon as never, { replayTargetSequence: 2 });
    await transport.connect();
    ctrl.push(makeUserEvent("response", { id: 1, result: {} }, 1));
    ctrl.push(makeAgentEvent("item/tool/call", { method: "item/tool/call", id: 1 }, 2));
    ctrl.end();
    const frames = [];
    for await (const frame of transport.readMessages()) frames.push(frame);
    expect(frames).toEqual([{ method: "item/tool/call", id: 1 }]);
  });
});

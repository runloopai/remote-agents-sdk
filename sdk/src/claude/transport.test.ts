import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeSystemEventWithRawPayload,
  makeUserEvent,
} from "../__test-utils__/mock-axon.js";
import { SystemError } from "../shared/errors/system-error.js";
import {
  AxonTransport,
  isControlRequest,
  isControlResponse,
  MESSAGE_TYPE_TO_EVENT_TYPE,
} from "./transport.js";

// ---------------------------------------------------------------------------
// MESSAGE_TYPE_TO_EVENT_TYPE constant tests (preserved from original)
// ---------------------------------------------------------------------------

describe("MESSAGE_TYPE_TO_EVENT_TYPE", () => {
  const expectedMappings: Record<string, string> = {
    user: "query",
    assistant: "assistant",
    result: "result",
    system: "system",
    control_request: "control_request",
    control_response: "control_response",
  };

  it("contains all expected keys", () => {
    expect(Object.keys(MESSAGE_TYPE_TO_EVENT_TYPE).sort()).toEqual(
      Object.keys(expectedMappings).sort(),
    );
  });

  for (const [msgType, eventType] of Object.entries(expectedMappings)) {
    it(`maps "${msgType}" to "${eventType}"`, () => {
      expect(MESSAGE_TYPE_TO_EVENT_TYPE[msgType]).toBe(eventType);
    });
  }
});

// ---------------------------------------------------------------------------
// isControlRequest / isControlResponse
// ---------------------------------------------------------------------------

describe("isControlRequest", () => {
  it("returns true when event_type is control_request", () => {
    expect(isControlRequest({ event_type: "control_request" } as never)).toBe(true);
  });

  it("returns false for other event types", () => {
    expect(isControlRequest({ event_type: "control_response" } as never)).toBe(false);
    expect(isControlRequest({ event_type: "query" } as never)).toBe(false);
  });
});

describe("isControlResponse", () => {
  it("returns true when event_type is control_response", () => {
    expect(isControlResponse({ event_type: "control_response" } as never)).toBe(true);
  });

  it("returns false for other event types", () => {
    expect(isControlResponse({ event_type: "control_request" } as never)).toBe(false);
    expect(isControlResponse({ event_type: "result" } as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AxonTransport class tests
// ---------------------------------------------------------------------------

describe("AxonTransport", () => {
  let ctrl: ReturnType<typeof createControllableStream>;
  let axon: ReturnType<typeof createMockAxon>["axon"];
  let transport: AxonTransport;

  beforeEach(() => {
    ctrl = createControllableStream(true);
    const mock = createMockAxon(ctrl);
    axon = mock.axon;
    transport = new AxonTransport(axon as never);
  });

  describe("connect()", () => {
    it("subscribes to the Axon SSE stream", async () => {
      await transport.connect();
      expect(axon.subscribeSse).toHaveBeenCalledOnce();
    });

    it("sets isReady() to true after connect", async () => {
      expect(transport.isReady()).toBe(false);
      await transport.connect();
      expect(transport.isReady()).toBe(true);
    });
  });

  describe("write()", () => {
    it("throws when transport is not ready", async () => {
      await expect(transport.write(JSON.stringify({ type: "user" }))).rejects.toThrow(
        "Transport is not ready",
      );
    });

    it("resolves event_type from message JSON type field", async () => {
      await transport.connect();
      await transport.write(
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      );

      expect(axon.publish).toHaveBeenCalledOnce();
      expect(axon.publish.mock.calls[0][0]).toMatchObject({
        event_type: "query",
        origin: "USER_EVENT",
        source: "claude-sdk-client",
      });
    });

    it("uses a custom source when provided via options", async () => {
      const custom = new AxonTransport(axon as never, { source: "my-custom-client" });
      await custom.connect();
      await custom.write(JSON.stringify({ type: "user" }));

      expect(axon.publish.mock.calls[0][0].source).toBe("my-custom-client");
    });

    it("resolves the source lazily on each write when given a resolver", async () => {
      let current = "first";
      const custom = new AxonTransport(axon as never, { source: () => current });
      await custom.connect();

      await custom.write(JSON.stringify({ type: "user" }));
      current = "second";
      await custom.write(JSON.stringify({ type: "user" }));

      expect(axon.publish.mock.calls[0][0].source).toBe("first");
      expect(axon.publish.mock.calls[1][0].source).toBe("second");
    });

    it("falls back to the default when the resolver returns undefined", async () => {
      const custom = new AxonTransport(axon as never, { source: () => undefined });
      await custom.connect();
      await custom.write(JSON.stringify({ type: "user" }));

      expect(axon.publish.mock.calls[0][0].source).toBe("claude-sdk-client");
    });

    it("uses the type value itself when not in mapping table", async () => {
      await transport.connect();
      await transport.write(JSON.stringify({ type: "custom_type" }));

      expect(axon.publish.mock.calls[0][0].event_type).toBe("custom_type");
    });

    it("falls back to 'query' for messages without a type field", async () => {
      await transport.connect();
      await transport.write(JSON.stringify({ content: "no type" }));

      expect(axon.publish.mock.calls[0][0].event_type).toBe("query");
    });

    it("falls back to 'query' when data is not valid JSON", async () => {
      await transport.connect();
      await transport.write("not json {{{");

      expect(axon.publish.mock.calls[0][0].event_type).toBe("query");
    });

    it("publishes the raw data string as payload", async () => {
      await transport.connect();
      const data = JSON.stringify({ type: "user", message: "hello" });
      await transport.write(data);

      expect(axon.publish.mock.calls[0][0].payload).toBe(data);
    });
  });

  describe("readMessages()", () => {
    it("throws if called before connect()", async () => {
      const gen = transport.readMessages();
      await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow("Transport not connected");
    });

    it("yields parsed JSON from AGENT_EVENT events", async () => {
      await transport.connect();

      const data = { type: "assistant", content: "hello" };
      ctrl.push(makeAgentEvent("assistant", data));
      ctrl.end();

      const messages: unknown[] = [];
      for await (const msg of transport.readMessages()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(data);
    });

    it("skips USER_EVENT events", async () => {
      await transport.connect();

      ctrl.push(makeUserEvent("query", { type: "user" }));
      ctrl.push(makeAgentEvent("assistant", { type: "assistant", text: "hi" }));
      ctrl.end();

      const messages: unknown[] = [];
      for await (const msg of transport.readMessages()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "assistant" });
    });

    it("skips events with unparseable payloads", async () => {
      await transport.connect();

      ctrl.push({
        event_type: "assistant",
        payload: "NOT VALID JSON",
        origin: "AGENT_EVENT",
      });
      ctrl.push(makeAgentEvent("result", { type: "result" }));
      ctrl.end();

      const messages: unknown[] = [];
      for await (const msg of transport.readMessages()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "result" });
    });

    it("stops yielding when transport is closed", async () => {
      await transport.connect();

      ctrl.push(makeAgentEvent("assistant", { n: 1 }));

      const gen = transport.readMessages()[Symbol.asyncIterator]();
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ n: 1 });

      await transport.close();
      ctrl.push(makeAgentEvent("assistant", { n: 2 }));
      ctrl.end();

      const second = await gen.next();
      expect(second.done).toBe(true);
    });

    it("throws on broker.error SYSTEM_EVENT with the payload as the error message", async () => {
      await transport.connect();

      ctrl.push(
        makeSystemEventWithRawPayload(
          "broker.error",
          "agent failed: agent binary 'nonexistent_binary' not found on PATH",
        ),
      );
      ctrl.end();

      const gen = transport.readMessages()[Symbol.asyncIterator]();
      await expect(gen.next()).rejects.toThrow(
        "agent failed: agent binary 'nonexistent_binary' not found on PATH",
      );
    });

    it("throws a SystemError with event metadata on broker.error", async () => {
      await transport.connect();

      ctrl.push(makeSystemEventWithRawPayload("broker.error", "agent failed: process crashed", 99));
      ctrl.end();

      const gen = transport.readMessages()[Symbol.asyncIterator]();
      try {
        await gen.next();
        expect.fail("Expected SystemError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SystemError);
        const sysErr = err as SystemError;
        expect(sysErr.message).toBe("agent failed: process crashed");
        expect(sysErr.eventType).toBe("broker.error");
        expect(sysErr.sequence).toBe(99);
      }
    });

    it("calls onAxonEvent listener for system error events before throwing", async () => {
      const onAxonEvent = vi.fn();
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const transport2 = new AxonTransport(mock.axon as never, { onAxonEvent });

      await transport2.connect();

      ctrl2.push(makeSystemEventWithRawPayload("broker.error", "agent failed: something bad"));
      ctrl2.end();

      const gen = transport2.readMessages()[Symbol.asyncIterator]();
      await expect(gen.next()).rejects.toThrow("agent failed: something bad");

      expect(onAxonEvent).toHaveBeenCalledOnce();
      expect(onAxonEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: "SYSTEM_EVENT",
          event_type: "broker.error",
          payload: "agent failed: something bad",
        }),
      );
    });
  });

  describe("close()", () => {
    it("sets isReady() to false", async () => {
      await transport.connect();
      expect(transport.isReady()).toBe(true);

      await transport.close();
      expect(transport.isReady()).toBe(false);
    });

    it("aborts the SSE stream controller", async () => {
      await transport.connect();
      await transport.close();

      expect(ctrl.stream.controller?.abort).toHaveBeenCalledOnce();
    });

    it("is idempotent — second close is a no-op", async () => {
      await transport.connect();
      await transport.close();
      await transport.close();

      expect(ctrl.stream.controller?.abort).toHaveBeenCalledOnce();
    });
  });

  describe("reconnect()", () => {
    it("re-subscribes to the Axon SSE stream", async () => {
      await transport.connect();

      const ctrl2 = createControllableStream(true);
      axon.subscribeSse.mockResolvedValueOnce(ctrl2.stream);

      await transport.reconnect();

      expect(axon.subscribeSse).toHaveBeenCalledTimes(2);
    });

    it("passes after_sequence from last seen event on re-subscribe", async () => {
      await transport.connect();

      ctrl.push(makeAgentEvent("assistant", { type: "assistant", text: "hi" }, 42));
      ctrl.push(makeAgentEvent("result", { type: "result" }, 43));
      ctrl.end();

      for await (const _msg of transport.readMessages()) {
        // drain
      }

      const ctrl2 = createControllableStream(true);
      axon.subscribeSse.mockResolvedValueOnce(ctrl2.stream);

      await transport.reconnect();

      expect(axon.subscribeSse).toHaveBeenCalledTimes(2);
      expect(axon.subscribeSse).toHaveBeenNthCalledWith(1);
      expect(axon.subscribeSse).toHaveBeenNthCalledWith(2, { after_sequence: 43 });
    });

    it("passes no after_sequence when no events were received", async () => {
      await transport.connect();

      const ctrl2 = createControllableStream(true);
      axon.subscribeSse.mockResolvedValueOnce(ctrl2.stream);

      await transport.reconnect();

      expect(axon.subscribeSse).toHaveBeenNthCalledWith(2, undefined);
    });

    it("no-ops after close()", async () => {
      await transport.connect();
      await transport.close();

      await transport.reconnect();

      expect(axon.subscribeSse).toHaveBeenCalledTimes(1);
      expect(transport.isReady()).toBe(false);
    });
  });

  describe("readMessages() — edge cases", () => {
    it("skips AGENT_EVENT with null payload", async () => {
      await transport.connect();

      ctrl.push({ event_type: "assistant", payload: null as never, origin: "AGENT_EVENT" });
      ctrl.push(makeAgentEvent("result", { type: "result" }));
      ctrl.end();

      const messages: unknown[] = [];
      for await (const msg of transport.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "result" });
    });

    it("skips AGENT_EVENT with non-object payload (e.g. string)", async () => {
      await transport.connect();

      ctrl.push({ event_type: "assistant", payload: '"just a string"', origin: "AGENT_EVENT" });
      ctrl.push(makeAgentEvent("result", { type: "result" }));
      ctrl.end();

      const messages: unknown[] = [];
      for await (const msg of transport.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "result" });
    });

    it("calls onAxonEvent for every event including skipped ones", async () => {
      const onAxonEvent = vi.fn();
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { onAxonEvent });

      await t.connect();

      ctrl2.push(makeUserEvent("query", { type: "user" }, 1));
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant" }, 2));
      ctrl2.end();

      for await (const _msg of t.readMessages()) {
        /* drain */
      }
      expect(onAxonEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("readMessages() — replay", () => {
    it("buffers control_request during replay and yields unresolved ones after", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", text: "hi" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ request_id: "req-1" });
    });

    it("resolves control_request when matching control_response seen during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 10 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "control_response",
        payload: JSON.stringify({ response: { request_id: "req-1", permission: "allow" } }),
        origin: "USER_EVENT",
        sequence: 2,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", text: "done" }),
        origin: "AGENT_EVENT",
        sequence: 10,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });

    it("yields live events after replay completes", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 2 });
      await t.connect();

      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", text: "replayed" }),
        origin: "AGENT_EVENT",
        sequence: 2,
      });
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live" }, 3));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: "live" });
    });

    it("skips replay control_request with null payload", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: null as never,
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });

    it("handles unparseable control_request payload during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: "NOT JSON",
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });

    it("handles unparseable control_response payload during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "control_response",
        payload: "NOT JSON",
        origin: "USER_EVENT",
        sequence: 2,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ request_id: "req-1" });
    });

    it("handles control_response with null payload during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "control_response",
        payload: null as never,
        origin: "USER_EVENT",
        sequence: 2,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ request_id: "req-1" });
    });

    it("skips control_request without request_id during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });

    it("flushes unresolved requests when stream ends before replay target", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 100 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ request_id: "req-1" });
    });

    it("fires onAxonEvent during replay", async () => {
      const onAxonEvent = vi.fn();
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, {
        onAxonEvent,
        replayTargetSequence: 3,
      });
      await t.connect();

      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 3,
      });
      ctrl2.end();

      for await (const _msg of t.readMessages()) {
        /* drain */
      }
      expect(onAxonEvent).toHaveBeenCalledTimes(2);
    });

    it("connects with afterSequence when provided", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { afterSequence: 42 });
      await t.connect();

      expect(mock.axon.subscribeSse).toHaveBeenCalledWith({ after_sequence: 42 });
    });

    it("bounded replay: subscribes after afterSequence while keeping the replay target", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, {
        afterSequence: 40,
        replayTargetSequence: 45,
      });
      await t.connect();

      expect(mock.axon.subscribeSse).toHaveBeenCalledOnce();
      expect(mock.axon.subscribeSse).toHaveBeenCalledWith({ after_sequence: 40 });
    });

    it("bounded replay: does not yield a request answered within (afterSequence, target]", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, {
        afterSequence: 40,
        replayTargetSequence: 45,
      });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-41", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 41,
      });
      ctrl2.push({
        event_type: "control_response",
        payload: JSON.stringify({ response: { request_id: "req-41", permission: "allow" } }),
        origin: "USER_EVENT",
        sequence: 42,
      });
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "replayed" }, 45));
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live" }, 46));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: "live" });
    });

    it("bounded replay: yields an unanswered request from the range after the target", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, {
        afterSequence: 40,
        replayTargetSequence: 45,
      });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-43", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 43,
      });
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "replayed" }, 45));
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live" }, 46));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ request_id: "req-43" });
      expect(messages[1]).toMatchObject({ text: "live" });
    });

    it("bounded replay: yields the first live frame when the head is at or below afterSequence", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      // Head (50) <= afterSequence (50): nothing to replay, the range is empty.
      const t = new AxonTransport(mock.axon as never, {
        afterSequence: 50,
        replayTargetSequence: 50,
      });
      await t.connect();

      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live-51" }, 51));
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live-52" }, 52));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ text: "live-51" });
      expect(messages[1]).toMatchObject({ text: "live-52" });
    });

    it("handles replay with gap — first live event after target flushes buffer", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: JSON.stringify({ request_id: "req-1", type: "can_use_tool" }),
        origin: "AGENT_EVENT",
        sequence: 3,
      });
      // Gap: no event with sequence 5 — jump directly to 7 (live)
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live" }, 7));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ request_id: "req-1" });
      expect(messages[1]).toMatchObject({ text: "live" });
    });

    it("handles control_request with non-object parsed payload during replay", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 5 });
      await t.connect();

      ctrl2.push({
        event_type: "control_request",
        payload: "42",
        origin: "AGENT_EVENT",
        sequence: 1,
      });
      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 5,
      });
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });

    it("handles replay with no unresolved requests — logs completion", async () => {
      const ctrl2 = createControllableStream(true);
      const mock = createMockAxon(ctrl2);
      const t = new AxonTransport(mock.axon as never, { replayTargetSequence: 2 });
      await t.connect();

      ctrl2.push({
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant" }),
        origin: "AGENT_EVENT",
        sequence: 2,
      });
      ctrl2.push(makeAgentEvent("assistant", { type: "assistant", text: "live" }, 3));
      ctrl2.end();

      const messages: unknown[] = [];
      for await (const msg of t.readMessages()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: "live" });
    });
  });

  describe("abortStream()", () => {
    it("aborts the SSE controller and allows reconnect", async () => {
      await transport.connect();
      transport.abortStream();
      expect(ctrl.stream.controller?.abort).toHaveBeenCalledOnce();
      expect(transport.isReady()).toBe(true);
    });

    it("no-ops when called before connect", () => {
      transport.abortStream();
    });
  });

  describe("isReady()", () => {
    it("returns false before connect", () => {
      expect(transport.isReady()).toBe(false);
    });

    it("returns true after connect", async () => {
      await transport.connect();
      expect(transport.isReady()).toBe(true);
    });

    it("returns false after close", async () => {
      await transport.connect();
      await transport.close();
      expect(transport.isReady()).toBe(false);
    });
  });
});

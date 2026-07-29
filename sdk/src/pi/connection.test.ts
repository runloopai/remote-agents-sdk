import { describe, expect, it, vi } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeSystemEventWithRawPayload,
} from "../__test-utils__/mock-axon.js";
import type { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { SystemError } from "../shared/errors/system-error.js";
import { PiAxonConnection, PiCommandError } from "./connection.js";
import type { PiSessionState } from "./protocol/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const SESSION_STATE: PiSessionState = {
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
};

function setup(options: Record<string, unknown> = {}) {
  const ctrl = createControllableStream(true);
  const mock = createMockAxon(ctrl);
  const conn = new PiAxonConnection(mock.axon as never, { id: "dbx-test" } as never, {
    replay: false,
    ...options,
  });
  const frames = () => mock.axon.publish.mock.calls.map(([event]) => JSON.parse(event.payload));
  return { ctrl, mock, conn, frames };
}

/** Acks every published command, mirroring its `type` as the ack `command`. */
function ackAll(
  { ctrl, mock }: Pick<ReturnType<typeof setup>, "ctrl" | "mock">,
  ack: (type: string) => { success?: boolean; error?: string; data?: unknown } = () => ({}),
) {
  mock.axon.publish.mockImplementation(async (event: { payload: string }) => {
    const frame = JSON.parse(event.payload) as { type: string; id: string };
    const { success = true, error, data } = ack(frame.type);
    ctrl.push(
      makeAgentEvent("response", {
        type: "response",
        id: frame.id,
        command: frame.type,
        success,
        ...(error != null ? { error } : {}),
        ...(data !== undefined ? { data } : {}),
      }),
    );
  });
}

describe("PiAxonConnection", () => {
  it("connects without a handshake, rejects a duplicate connect, and disconnects", async () => {
    const { conn } = setup();
    await conn.connect();
    expect(conn.isConnected).toBe(true);
    await expect(conn.connect()).rejects.toMatchObject({ code: "already_connected" });
    await conn.disconnect();
    expect(conn.isDisconnected).toBe(true);
  });

  it("rejects commands before connect", async () => {
    const { conn } = setup();
    await expect(conn.getState()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("publishes exactly one turn/start prompt frame and resolves on its ack", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await ctx.conn.send("hi");
    expect(ctx.mock.axon.publish.mock.calls).toHaveLength(1);
    const [event] = ctx.mock.axon.publish.mock.calls[0] as [Record<string, string>];
    expect(event).toMatchObject({
      event_type: "turn/start",
      origin: "USER_EVENT",
      source: "pi-sdk-client",
    });
    const frame = JSON.parse(event.payload as string);
    expect(frame).toEqual({ type: "prompt", id: expect.stringMatching(/^pi-sdk-/), message: "hi" });
  });

  it("passes prompt images and streamingBehavior through", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await ctx.conn.send("look", {
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      streamingBehavior: "steer",
    });
    expect(ctx.frames()[0]).toMatchObject({
      type: "prompt",
      message: "look",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      streamingBehavior: "steer",
    });
  });

  it("rejects send with a PiCommandError carrying Pi's error string", async () => {
    const ctx = setup();
    ackAll(ctx, () => ({ success: false, error: "agent is streaming" }));
    await ctx.conn.connect();
    const error = await ctx.conn.send("hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiCommandError);
    expect(error).toMatchObject({
      command: "prompt",
      error: "agent is streaming",
      message: "agent is streaming",
    });
  });

  it("falls back to a synthesized message when a rejection carries no error", async () => {
    const ctx = setup();
    ackAll(ctx, () => ({ success: false }));
    await ctx.conn.connect();
    await expect(ctx.conn.getState()).rejects.toThrow("Pi rejected the get_state command");
  });

  it("routes interrupt, steer and followUp to their own event types", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await ctx.conn.interrupt();
    await ctx.conn.steer("actually, stop");
    await ctx.conn.followUp("and then this", [
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
    const events = ctx.mock.axon.publish.mock.calls.map(([event]) => event.event_type);
    expect(events).toEqual(["cancel", "steer", "follow_up"]);
    expect(events).not.toContain("turn/start");
    expect(ctx.frames()).toEqual([
      { type: "abort", id: expect.any(String) },
      { type: "steer", id: expect.any(String), message: "actually, stop" },
      {
        type: "follow_up",
        id: expect.any(String),
        message: "and then this",
        images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      },
    ]);
  });

  it("refuses to publish a broker-reserved command id", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await expect(ctx.conn.command({ type: "prompt", id: "broker-1" })).rejects.toThrow("reserved");
  });

  it("terminates receiveTurn at agent_settled, not at a retrying agent_end", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await ctx.conn.send("hi");
    ctx.ctrl.push(makeAgentEvent("turn_start", { type: "turn_start" }));
    ctx.ctrl.push(
      makeAgentEvent("agent_end", { type: "agent_end", messages: [], willRetry: true }),
    );
    ctx.ctrl.push(makeAgentEvent("turn_start", { type: "turn_start" }));
    ctx.ctrl.push(
      makeAgentEvent("agent_end", { type: "agent_end", messages: [], willRetry: false }),
    );
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    ctx.ctrl.push(makeAgentEvent("turn_start", { type: "turn_start" }));
    const frames = [];
    for await (const frame of ctx.conn.receiveTurn()) frames.push(frame.type);
    expect(frames).toEqual(["turn_start", "agent_end", "turn_start", "agent_end", "agent_settled"]);
  });

  it("terminates receiveTurn on a rejected prompt ack", async () => {
    const ctx = setup();
    ackAll(ctx, (type) => (type === "prompt" ? { success: false, error: "busy" } : {}));
    await ctx.conn.connect();
    await expect(ctx.conn.send("hi")).rejects.toBeInstanceOf(PiCommandError);
    const frames = [];
    for await (const frame of ctx.conn.receiveTurn()) frames.push(frame);
    expect(frames).toEqual([
      {
        type: "response",
        id: expect.any(String),
        command: "prompt",
        success: false,
        error: "busy",
      },
    ]);
  });

  it("does not let an undrained rejection terminate a later accepted turn", async () => {
    const ctx = setup();
    let rejectPrompt = true;
    ackAll(ctx, (type) =>
      type === "prompt" && rejectPrompt ? { success: false, error: "busy" } : {},
    );
    await ctx.conn.connect();
    // The first prompt is rejected and its caller never drains the turn, so
    // the rejection ack is left sitting in the queue.
    await expect(ctx.conn.send("first")).rejects.toBeInstanceOf(PiCommandError);
    rejectPrompt = false;
    await ctx.conn.send("second");
    ctx.ctrl.push(makeAgentEvent("turn_start", { type: "turn_start" }));
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    const frames = [];
    for await (const frame of ctx.conn.receiveTurn()) frames.push(frame);
    // The stale rejection is skipped; the accepted turn runs to agent_settled.
    expect(frames.map((frame) => frame.type)).toEqual(["turn_start", "agent_settled"]);
  });

  it("bounds the pull queue when frames are consumed only through listeners", async () => {
    const ctx = setup({ maxQueuedFrames: 10, onError: () => {} });
    const seen: string[] = [];
    ctx.conn.onTimelineEvent(() => seen.push("event"));
    await ctx.conn.connect();
    for (let index = 0; index < 50; index++)
      ctx.ctrl.push(
        makeAgentEvent("message_update", {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${index}` },
        }),
      );
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    await tick();
    // Every frame reached the listener, but the pull queue kept only the cap.
    expect(seen).toHaveLength(51);
    const frames = [];
    for await (const frame of ctx.conn.receiveTurn()) frames.push(frame);
    expect(frames).toHaveLength(10);
    expect(frames.at(-1)?.type).toBe("agent_settled");
  });

  it("generates an id for a blank caller-supplied id", async () => {
    const ctx = setup();
    ackAll(ctx);
    await ctx.conn.connect();
    await ctx.conn.command({ type: "prompt", id: "  ", message: "hi" });
    expect(ctx.frames()).toEqual([
      { type: "prompt", id: expect.stringMatching(/^pi-sdk-/), message: "hi" },
    ]);
  });

  it("resolves getState and captures session identity from the ack", async () => {
    const ctx = setup();
    ackAll(ctx, () => ({ data: SESSION_STATE }));
    await ctx.conn.connect();
    expect(ctx.conn.sessionId).toBeUndefined();
    expect(await ctx.conn.getState()).toEqual(SESSION_STATE);
    expect(ctx.conn.sessionId).toBe("session-1");
    expect(ctx.conn.sessionFile).toBe("/sessions/current.jsonl");
  });

  it("captures session identity from acks seen during replay", async () => {
    const ctrl = createControllableStream(true);
    ctrl.push(
      makeAgentEvent(
        "response",
        {
          type: "response",
          id: "broker-1",
          command: "get_state",
          success: true,
          data: SESSION_STATE,
        },
        1,
      ),
    );
    const mock = createMockAxon(ctrl);
    Object.assign(mock.axon, {
      client: { get: vi.fn().mockResolvedValue({ events: [], has_more: false, total_count: 1 }) },
    });
    const conn = new PiAxonConnection(mock.axon as never, { id: "dbx" } as never);
    await conn.connect();
    await tick();
    expect(conn.sessionId).toBe("session-1");
    expect(conn.sessionFile).toBe("/sessions/current.jsonl");
  });

  it("queues acks it did not ask for rather than swallowing them", async () => {
    const ctx = setup();
    await ctx.conn.connect();
    // The adapter's own `get_state`, both id-less and `broker-N` stamped.
    ctx.ctrl.push(
      makeAgentEvent("response", { type: "response", command: "get_state", success: true }),
    );
    ctx.ctrl.push(
      makeAgentEvent("response", {
        type: "response",
        id: "broker-2",
        command: "get_state",
        success: true,
      }),
    );
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    const frames = [];
    for await (const frame of ctx.conn.receiveTurn()) frames.push([frame.type, frame.id]);
    expect(frames).toEqual([
      ["response", undefined],
      ["response", "broker-2"],
      ["agent_settled", undefined],
    ]);
  });

  it("returns SessionChange from newSession and switchSession", async () => {
    const ctx = setup();
    ackAll(ctx, () => ({ data: { cancelled: false } }));
    await ctx.conn.connect();
    expect(await ctx.conn.newSession("/sessions/parent.jsonl")).toEqual({ cancelled: false });
    expect(await ctx.conn.switchSession("/sessions/other.jsonl")).toEqual({ cancelled: false });
    expect(ctx.frames()).toEqual([
      { type: "new_session", id: expect.any(String), parentSession: "/sessions/parent.jsonl" },
      { type: "switch_session", id: expect.any(String), sessionPath: "/sessions/other.jsonl" },
    ]);
  });

  it("sends unwrapped commands through the escape hatch", async () => {
    const ctx = setup();
    ackAll(ctx, () => ({ data: { model: "glm-5.2" } }));
    await ctx.conn.connect();
    expect(await ctx.conn.command({ type: "set_model", model: "glm-5.2" })).toEqual({
      model: "glm-5.2",
    });
    expect(ctx.frames()[0]).toMatchObject({ type: "set_model", model: "glm-5.2" });
  });

  it("emits raw and classified events to listeners", async () => {
    const ctx = setup();
    const axonEvents = vi.fn();
    const timelineEvents = vi.fn();
    ctx.conn.onAxonEvent(axonEvents);
    ctx.conn.onTimelineEvent(timelineEvents);
    await ctx.conn.connect();
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    await tick();
    expect(axonEvents).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "agent_settled" }),
    );
    expect(timelineEvents).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pi_protocol", eventType: "agent_settled" }),
    );
  });

  it("streams classified timeline events until the stream ends", async () => {
    const ctx = setup();
    await ctx.conn.connect();
    const events = ctx.conn.receiveTimelineEvents();
    ctx.ctrl.push(makeAgentEvent("agent_settled", { type: "agent_settled" }));
    const first = await events.next();
    expect(first.value).toMatchObject({ eventType: "agent_settled" });
    await ctx.conn.disconnect();
  });

  it("treats broker errors as fatal and refuses to reconnect", async () => {
    const onError = vi.fn();
    const { ctrl, conn } = setup({ onError });
    await conn.connect();
    ctrl.push(makeSystemEventWithRawPayload("broker.error", "boom", 1));
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.any(SystemError));
    await expect(conn.getState()).rejects.toEqual(
      expect.objectContaining<Partial<ConnectionStateError>>({ code: "terminated" }),
    );
    await expect(conn.connect()).rejects.toMatchObject({ code: "terminated" });
  });

  it("rejects a pending command when a broker error kills the read loop", async () => {
    const onError = vi.fn();
    const { ctrl, mock, conn } = setup({ onError });
    mock.axon.publish.mockImplementation(async () => {
      ctrl.push(makeSystemEventWithRawPayload("broker.error", "boom", 1));
    });
    await conn.connect();
    await expect(conn.getState()).rejects.toBeInstanceOf(SystemError);
  });

  it("keeps frames buffered before a fatal broker error drainable", async () => {
    const onError = vi.fn();
    const { ctrl, conn } = setup({ onError });
    await conn.connect();
    ctrl.push(makeAgentEvent("turn_start", { type: "turn_start" }, 1));
    ctrl.push(
      makeAgentEvent("agent_end", { type: "agent_end", messages: [], willRetry: false }, 2),
    );
    ctrl.push(makeSystemEventWithRawPayload("broker.error", "boom", 3));
    await tick();
    const frames = [];
    for await (const frame of conn.receiveAgentEvents()) frames.push(frame.type);
    expect(frames).toEqual(["turn_start", "agent_end"]);
  });

  it("auto-reconnects once after a transient stream error", async () => {
    const second = createControllableStream(true);
    const failing = {
      controller: { abort: vi.fn() },
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("network blip");
          },
        };
      },
    };
    const axon = {
      id: "axon",
      publish: vi.fn(),
      subscribeSse: vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(second.stream),
    };
    const conn = new PiAxonConnection(axon as never, { id: "dbx" } as never, {
      replay: false,
      onError: vi.fn(),
    });
    await conn.connect();
    await tick();
    expect(axon.subscribeSse).toHaveBeenCalledTimes(2);
    second.end();
  });

  it("aborts only the current stream and publishes raw events", async () => {
    const ctx = setup();
    await ctx.conn.connect();
    await ctx.conn.publish({ event_type: "custom", origin: "USER_EVENT", payload: "{}" } as never);
    expect(ctx.mock.published[0]).toMatchObject({ event_type: "custom" });
    ctx.conn.abortStream();
    await ctx.conn.disconnect();
    expect(ctx.conn.isConnected).toBe(false);
  });

  it("times out a command that is never acknowledged", async () => {
    const { conn, mock } = setup({ requestTimeoutMs: 10 });
    mock.axon.publish.mockImplementation(async () => {});
    await conn.connect();
    await expect(conn.getState()).rejects.toThrow("Command timeout: get_state");
  });

  it("drops the pending entry when publishing fails", async () => {
    const { conn, mock } = setup();
    mock.axon.publish.mockRejectedValue(new Error("publish failed"));
    await conn.connect();
    await expect(conn.getState()).rejects.toThrow("publish failed");
    // A dropped entry means the same generated id space stays usable.
    await expect(conn.getState()).rejects.toThrow("publish failed");
  });
});

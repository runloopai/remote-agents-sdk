import { describe, expect, it, vi } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeSystemEventWithRawPayload,
  makeUserEvent,
} from "../__test-utils__/mock-axon.js";
import type { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { SystemError } from "../shared/errors/system-error.js";
import { CodexAxonConnection } from "./connection.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: Record<string, unknown> = {}) {
  const ctrl = createControllableStream(true);
  const mock = createMockAxon(ctrl);
  const conn = new CodexAxonConnection(mock.axon as never, { id: "dbx-test" } as never, {
    replay: false,
    ...options,
  });
  return { ctrl, mock, conn };
}

describe("CodexAxonConnection", () => {
  it("connects, disconnects, and rejects a duplicate connect", async () => {
    const { conn } = setup();
    await conn.connect();
    expect(conn.isConnected).toBe(true);
    await expect(conn.connect()).rejects.toMatchObject({ code: "already_connected" });
    await conn.disconnect();
    expect(conn.isDisconnected).toBe(true);
  });

  it("runs the initialize handshake then sends turn/start and interrupt frames", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      if (frame.id == null) return; // notifications get no response
      if (frame.method === "thread/start") {
        ctrl.push(
          makeAgentEvent("response", { id: frame.id, result: { thread: { id: "thr-1" } } }),
        );
      } else {
        ctrl.push(makeAgentEvent("response", { id: frame.id, result: {} }));
      }
    });
    await conn.connect();
    expect(conn.isInitialized).toBe(false);
    await conn.initialize();
    expect(conn.isInitialized).toBe(true);
    expect(await conn.startThread()).toBe("thr-1");
    await conn.send("hello");
    await conn.interrupt();
    const frames = mock.axon.publish.mock.calls.map(([event]) => JSON.parse(event.payload));
    expect(frames[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "runloop-remote-agents-sdk" },
        capabilities: null,
      },
    });
    expect(frames[1]).toMatchObject({ method: "initialized" });
    expect(frames[1].id).toBeUndefined();
    expect(frames[3]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thr-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      },
    });
    expect(frames[4]).toMatchObject({ method: "turn/interrupt", params: {} });
    expect(frames.every((frame) => !String(frame.id).startsWith("runloop-broker-"))).toBe(true);
  });

  it("guards initialize ordering and duplicate calls", async () => {
    const { ctrl, mock, conn } = setup();
    await expect(conn.initialize()).rejects.toMatchObject({ code: "not_connected" });
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      if (frame.id != null) ctrl.push(makeAgentEvent("response", { id: frame.id, result: {} }));
    });
    await conn.connect();
    await conn.initialize();
    await expect(conn.initialize()).rejects.toMatchObject({ code: "already_initialized" });
    await conn.disconnect();
    expect(conn.isInitialized).toBe(false);
  });

  it("treats a server-side 'already initialized' rejection as success", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      if (frame.method === "initialize") {
        ctrl.push(
          makeAgentEvent("response", {
            id: frame.id,
            error: { code: -32600, message: "Already initialized" },
          }),
        );
      }
    });
    await conn.connect();
    await conn.initialize();
    expect(conn.isInitialized).toBe(true);
  });

  it("propagates other initialize errors", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      if (frame.method === "initialize") {
        ctrl.push(
          makeAgentEvent("response", {
            id: frame.id,
            error: { code: -32600, message: "Not initialized" },
          }),
        );
      }
    });
    await conn.connect();
    await expect(conn.initialize()).rejects.toThrow(/Not initialized/);
    expect(conn.isInitialized).toBe(false);
  });

  it("recovers the last thread id from replay", async () => {
    const ctrl = createControllableStream(true);
    ctrl.push(
      makeAgentEvent(
        "thread/started",
        { method: "thread/started", params: { thread: { id: "replayed" } } },
        1,
      ),
    );
    const mock = createMockAxon(ctrl);
    Object.assign(mock.axon, {
      client: { get: vi.fn().mockResolvedValue({ events: [], has_more: false, total_count: 1 }) },
    });
    const conn = new CodexAxonConnection(mock.axon as never, { id: "dbx" } as never);
    await conn.connect();
    await tick();
    expect(conn.threadId).toBe("replayed");
  });

  it("ignores historical broker errors while replaying a recovered channel", async () => {
    const ctrl = createControllableStream(true);
    ctrl.push(makeSystemEventWithRawPayload("broker.error", "historical crash", 1));
    ctrl.push(
      makeAgentEvent(
        "thread/started",
        { method: "thread/started", params: { thread: { id: "recovered" } } },
        2,
      ),
    );
    const mock = createMockAxon(ctrl);
    Object.assign(mock.axon, {
      client: { get: vi.fn().mockResolvedValue({ events: [], has_more: false, total_count: 2 }) },
    });
    const onError = vi.fn();
    const conn = new CodexAxonConnection(mock.axon as never, { id: "dbx" } as never, { onError });
    await conn.connect();
    await tick();
    expect(conn.threadId).toBe("recovered");
    expect(onError).not.toHaveBeenCalledWith(expect.any(SystemError));
  });

  it("does not capture a user-origin thread/started event", async () => {
    const { ctrl, conn } = setup();
    await conn.connect();
    ctrl.push(
      makeUserEvent("thread/started", {
        method: "thread/started",
        params: { thread: { id: "spoofed" } },
      }),
    );
    await tick();
    expect(conn.threadId).toBeUndefined();
  });

  it("correlates responses by JSON-RPC id", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      ctrl.push(makeAgentEvent("response", { id: frame.id, result: { ok: true } }));
    });
    await conn.connect();
    await expect(conn.readConfig()).resolves.toEqual({ ok: true });
  });

  it("deduplicates concurrent automatic thread starts", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      ctrl.push(
        makeAgentEvent("response", {
          id: frame.id,
          result: frame.method === "thread/start" ? { thread: { id: "only-thread" } } : {},
        }),
      );
    });
    await conn.connect();
    await Promise.all([conn.send("one"), conn.send("two")]);
    const methods = mock.axon.publish.mock.calls.map(([event]) => JSON.parse(event.payload).method);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
  });

  it("round-trips approval handlers with the matching id", async () => {
    const { ctrl, mock, conn } = setup();
    conn.onApprovalRequest("execCommandApproval", async () => ({ decision: "denied" }));
    await conn.connect();
    ctrl.push(
      makeAgentEvent("execCommandApproval", { method: "execCommandApproval", id: 9, params: {} }),
    );
    await tick();
    expect(JSON.parse(mock.published[0]?.payload ?? "null")).toEqual({
      id: 9,
      result: { decision: "denied" },
    });
  });

  it.each([
    ["item/commandExecution/requestApproval", {}, { decision: "accept" }],
    ["item/fileChange/requestApproval", {}, { decision: "accept" }],
    ["item/tool/requestUserInput", {}, { answers: {} }],
    [
      "item/permissions/requestApproval",
      { permissions: { network: null, fileSystem: null } },
      { permissions: {}, scope: "turn" },
    ],
    ["execCommandApproval", {}, { decision: "approved" }],
    ["applyPatchApproval", {}, { decision: "approved" }],
  ])("uses the wire-correct default for %s", async (method, params, expected) => {
    const { ctrl, mock, conn } = setup();
    await conn.connect();
    ctrl.push(makeAgentEvent(method, { method, id: 12, params }));
    await tick();
    expect(JSON.parse(mock.published[0]?.payload ?? "null")).toEqual({ id: 12, result: expected });
  });

  it("answers unsupported server requests with a JSON-RPC error", async () => {
    const { ctrl, mock, conn } = setup();
    await conn.connect();
    ctrl.push(makeAgentEvent("item/tool/call", { method: "item/tool/call", id: 4, params: {} }));
    await tick();
    expect(JSON.parse(mock.published[0]?.payload ?? "null")).toMatchObject({
      id: 4,
      error: { code: -32601 },
    });
  });

  it("declines approval handlers that do not answer before the timeout", async () => {
    const { ctrl, mock, conn } = setup({ requestTimeoutMs: 5 });
    conn.onApprovalRequest("execCommandApproval", () => new Promise(() => undefined));
    await conn.connect();
    ctrl.push(
      makeAgentEvent("execCommandApproval", { method: "execCommandApproval", id: 5, params: {} }),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(JSON.parse(mock.published[0]?.payload ?? "null")).toEqual({
      id: 5,
      result: { decision: "denied" },
    });
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
    const conn = new CodexAxonConnection(axon as never, { id: "dbx" } as never, {
      replay: false,
      onError: vi.fn(),
    });
    await conn.connect();
    await tick();
    expect(axon.subscribeSse).toHaveBeenCalledTimes(2);
    second.end();
  });

  it("treats broker errors as fatal", async () => {
    const onError = vi.fn();
    const { ctrl, conn } = setup({ onError });
    await conn.connect();
    ctrl.push(makeSystemEventWithRawPayload("broker.error", "boom", 1));
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.any(SystemError));
    await expect(conn.readConfig()).rejects.toEqual(
      expect.objectContaining<Partial<ConnectionStateError>>({ code: "terminated" }),
    );
  });

  it("rejects a timed-out thread start without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { conn } = setup({ requestTimeoutMs: 10 });
      await conn.connect();
      await expect(conn.startThread()).rejects.toThrow("Request timeout: thread/start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps frames buffered before a fatal broker error drainable", async () => {
    const onError = vi.fn();
    const { ctrl, conn } = setup({ onError });
    await conn.connect();
    ctrl.push(makeAgentEvent("turn/started", { method: "turn/started", params: {} }));
    ctrl.push(makeAgentEvent("turn/completed", { method: "turn/completed", params: {} }));
    ctrl.push(makeSystemEventWithRawPayload("broker.error", "boom", 3));
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.any(SystemError));
    const frames = [];
    for await (const frame of conn.receiveAgentEvents()) frames.push(frame);
    expect(frames.map((frame) => frame.method)).toEqual(["turn/started", "turn/completed"]);
  });

  it("supports a connect → disconnect → connect cycle on the same instance", async () => {
    const ctrls = [createControllableStream(true), createControllableStream(true)];
    let active = 0;
    const axon = {
      id: "axon",
      publish: vi.fn().mockImplementation(async (event: { payload: string }) => {
        const frame = JSON.parse(event.payload);
        ctrls[active]?.push(
          makeAgentEvent("response", {
            id: frame.id,
            result: frame.method === "thread/start" ? { thread: { id: "thr-1" } } : {},
          }),
        );
      }),
      subscribeSse: vi.fn().mockImplementation(async () => ctrls[active]?.stream),
    };
    const conn = new CodexAxonConnection(axon as never, { id: "dbx" } as never, { replay: false });
    await conn.connect();
    await conn.send("first");
    await conn.disconnect();
    ctrls[0]?.end();
    expect(conn.isDisconnected).toBe(true);
    active = 1;
    await conn.connect();
    expect(conn.isConnected).toBe(true);
    await conn.send("second");
    const methods = axon.publish.mock.calls.map(([event]) => JSON.parse(event.payload).method);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
  });

  it("rejects in-flight requests after the single reconnect attempt also fails", async () => {
    const createFailableStream = () => {
      let failWith: ((error: Error) => void) | undefined;
      return {
        stream: {
          controller: { abort: vi.fn() },
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<never>((_, reject) => {
                  failWith = reject;
                }),
            };
          },
        },
        fail: (error: Error) => failWith?.(error),
      };
    };
    const first = createFailableStream();
    const second = createFailableStream();
    const axon = {
      id: "axon",
      publish: vi.fn(),
      subscribeSse: vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream),
    };
    const conn = new CodexAxonConnection(axon as never, { id: "dbx" } as never, {
      replay: false,
      onError: vi.fn(),
    });
    await conn.connect();
    const observed = conn.readConfig().then(
      () => undefined,
      (error: Error) => error,
    );
    first.fail(new Error("blip 1"));
    await tick();
    second.fail(new Error("blip 2"));
    await tick();
    expect(axon.subscribeSse).toHaveBeenCalledTimes(2);
    expect(await observed).toMatchObject({ message: "blip 2" });
  });

  it("answers with a JSON-RPC error when an approval handler throws", async () => {
    const { ctrl, mock, conn } = setup();
    conn.onApprovalRequest("execCommandApproval", async () => {
      throw new Error("handler exploded");
    });
    await conn.connect();
    ctrl.push(
      makeAgentEvent("execCommandApproval", { method: "execCommandApproval", id: 3, params: {} }),
    );
    await tick();
    expect(JSON.parse(mock.published[0]?.payload ?? "null")).toEqual({
      id: 3,
      error: { code: -32000, message: "handler exploded" },
    });
  });

  it("rejects requests with a typed error preserving the JSON-RPC code", async () => {
    const { ctrl, mock, conn } = setup();
    mock.axon.publish.mockImplementation(async (event) => {
      const frame = JSON.parse(event.payload);
      ctrl.push(
        makeAgentEvent("response", {
          id: frame.id,
          error: { code: -32602, message: "bad params", data: { field: "threadId" } },
        }),
      );
    });
    await conn.connect();
    await expect(conn.resumeThread("thread-1")).rejects.toMatchObject({
      name: "CodexRequestError",
      code: -32602,
      message: "bad params",
      data: { field: "threadId" },
    });
  });
});

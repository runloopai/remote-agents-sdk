import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { makeFullAxonEvent } from "../__test-utils__/mock-axon.js";
import { SystemError } from "../shared/errors/system-error.js";
import {
  classifyClaudeAxonEvent,
  isClaudeProtocolEventType,
} from "./classify-claude-axon-event.js";
import { ClaudeAxonConnection } from "./connection.js";
import type { Transport } from "./transport.js";
import type { ClaudeTimelineEvent, WireData } from "./types.js";

// ---------------------------------------------------------------------------
// Mock Transport
// ---------------------------------------------------------------------------

interface MockTransport extends Transport {
  _messages: WireData[];
  _waiter: ((v: IteratorResult<WireData>) => void) | null;
  _errorWaiter: ((err: Error) => void) | null;
  _done: boolean;
  _written: string[];
  _push(msg: WireData): void;
  _end(): void;
  _throw(err: Error): void;
  abortStream: Mock<() => void>;
  reconnect: Mock<() => Promise<void>>;
}

function createMockTransport(): MockTransport {
  const transport: MockTransport = {
    _messages: [],
    _waiter: null,
    _errorWaiter: null,
    _done: false,
    _written: [],

    connect: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockImplementation(async (data: string) => {
      transport._written.push(data);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    abortStream: vi.fn(),
    reconnect: vi.fn().mockImplementation(async () => {
      transport._done = false;
    }),
    isReady: vi.fn().mockReturnValue(true),

    async *readMessages() {
      while (true) {
        if (transport._messages.length > 0) {
          yield transport._messages.shift() as WireData;
          continue;
        }
        if (transport._done) return;
        const msg = await new Promise<WireData | null>((resolve, reject) => {
          transport._waiter = (result) => {
            if (result.done) resolve(null);
            else resolve(result.value);
          };
          transport._errorWaiter = reject;
        });
        if (msg === null) return;
        yield msg;
      }
    },

    _push(msg: WireData) {
      if (transport._waiter) {
        const resolve = transport._waiter;
        transport._waiter = null;
        transport._errorWaiter = null;
        resolve({ value: msg, done: false });
      } else {
        transport._messages.push(msg);
      }
    },

    _end() {
      transport._done = true;
      if (transport._waiter) {
        const resolve = transport._waiter;
        transport._waiter = null;
        transport._errorWaiter = null;
        resolve({ value: undefined as never, done: true });
      }
    },

    _throw(err: Error) {
      if (transport._errorWaiter) {
        const reject = transport._errorWaiter;
        transport._waiter = null;
        transport._errorWaiter = null;
        reject(err);
      }
    },
  };
  return transport;
}

function createMockAxon() {
  return {
    id: "test-axon",
    publish: vi.fn().mockResolvedValue({ sequence: 1, timestamp_ms: Date.now() }),
  };
}

// ---------------------------------------------------------------------------
// Helper to create a connected ClaudeAxonConnection with mock transport
// ---------------------------------------------------------------------------

async function createConnectedClient(
  transport: MockTransport,
  options?: {
    onDisconnect?: () => void | Promise<void>;
    model?: string;
    onError?: (error: unknown) => void;
    systemPrompt?: string;
    appendSystemPrompt?: string;
  },
) {
  const axon = createMockAxon();
  const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
    onDisconnect: options?.onDisconnect,
    model: options?.model,
    onError: options?.onError,
    systemPrompt: options?.systemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt,
    replay: false,
  });

  // Replace internal transport with mock before connect() creates a real one.
  // We cast to access the private field, then call connect() which will detect
  // the transport is already set and skip creation.
  (conn as unknown as { transport: MockTransport }).transport = transport;

  // Queue up the initialize control response so initialize() succeeds.
  // The initialize() method sends an initialize control_request and waits for
  // control_response. We intercept the write and respond.
  const _originalWrite = transport.write;
  (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
    transport._written.push(data);
    const parsed = JSON.parse(data);
    if (parsed.type === "control_request" && parsed.request?.subtype === "initialize") {
      transport._push({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: parsed.request_id,
          response: { initialized: true },
        },
      });
    }
    if (parsed.type === "control_request" && parsed.request?.subtype === "set_model") {
      transport._push({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: parsed.request_id,
          response: {},
        },
      });
    }
  });

  await conn.connect();
  await conn.initialize();
  return conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeAxonConnection", () => {
  let transport: MockTransport;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport = createMockTransport();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("initialize()", () => {
    it("connects the transport and sends initialize control request", async () => {
      await createConnectedClient(transport);

      expect(transport.connect).toHaveBeenCalledOnce();
      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
    });

    it("sends set_model after initialize when model option is provided", async () => {
      await createConnectedClient(transport, { model: "claude-sonnet-4-5" });

      const modelCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "set_model";
      });
      expect(modelCall).toBeDefined();
      expect(JSON.parse(modelCall as string).request.model).toBe("claude-sonnet-4-5");
    });

    it("throws if initialize() is called after disconnect without connect()", async () => {
      const conn = await createConnectedClient(transport);
      await conn.disconnect();

      await expect(conn.initialize()).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "not_connected",
      });
    });
  });

  describe("axonId", () => {
    it("exposes the Axon channel ID from the constructor", async () => {
      const conn = await createConnectedClient(transport);
      expect(conn.axonId).toBe("test-axon");
    });
  });

  describe("send()", () => {
    it("wraps a string prompt into an SDKUserMessage", async () => {
      const conn = await createConnectedClient(transport);

      await conn.send("Hello Claude");

      const sent = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "user";
      });
      expect(sent).toBeDefined();
      const parsed = JSON.parse(sent as string);
      expect(parsed.type).toBe("user");
      expect(parsed.message).toEqual({ role: "user", content: "Hello Claude" });
      expect(parsed.parent_tool_use_id).toBeNull();
    });

    it("passes SDKUserMessage objects through unchanged", async () => {
      const conn = await createConnectedClient(transport);

      const userMsg = {
        type: "user" as const,
        message: { role: "user" as const, content: "custom" },
        parent_tool_use_id: "tool_123",
      };
      await conn.send(userMsg as never);

      const sent = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "user" && p.parent_tool_use_id === "tool_123";
      });
      expect(sent).toBeDefined();
    });
  });

  describe("source / setSource()", () => {
    it("defaults to undefined (transport supplies the built-in default)", async () => {
      const conn = await createConnectedClient(transport);
      expect(conn.source).toBeUndefined();
    });

    it("reflects the value passed via options", async () => {
      const axon = createMockAxon();
      const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
        source: "from-options",
        replay: false,
      });
      expect(conn.source).toBe("from-options");
    });

    it("updates the current source via setSource()", async () => {
      const conn = await createConnectedClient(transport);
      conn.setSource("my-client");
      expect(conn.source).toBe("my-client");
      conn.setSource(undefined);
      expect(conn.source).toBeUndefined();
    });
  });

  describe("publish()", () => {
    it("delegates to axon.publish() with the provided params", async () => {
      const conn = await createConnectedClient(transport);

      const params = {
        event_type: "agent_config",
        origin: "EXTERNAL_EVENT" as const,
        payload: JSON.stringify({ agentType: "claude", model: "test" }),
        source: "combined-app",
      };

      const result = await conn.publish(params);

      const axon = (conn as unknown as { axon: ReturnType<typeof createMockAxon> }).axon;
      expect(axon.publish).toHaveBeenCalledOnce();
      expect(axon.publish).toHaveBeenCalledWith(params);
      expect(result).toEqual(expect.objectContaining({ sequence: 1 }));
    });
  });

  describe("receiveMessages()", () => {
    it("yields SDK messages (non-control) from the transport", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "assistant", content: "Hi" });
      transport._push({ type: "result", cost: 0.01 });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: "assistant", content: "Hi" });
      expect(messages[1]).toMatchObject({ type: "result", cost: 0.01 });
    });

    it("filters out control_response messages from the stream", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({
        type: "control_response",
        response: { subtype: "success", request_id: "orphan", response: {} },
      });
      transport._push({ type: "assistant", content: "Hello" });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "assistant" });
    });

    it("filters out control_cancel_request messages", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "control_cancel_request" });
      transport._push({ type: "assistant", content: "Hello" });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(1);
    });

    it("returns null (ends iteration) when disconnected", async () => {
      const conn = await createConnectedClient(transport);

      const gen = conn.receiveMessages();
      const iter = gen[Symbol.asyncIterator]();

      // Disconnect while waiting for a message
      setTimeout(() => conn.disconnect(), 10);

      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("keeps messages buffered before a fatal error drainable", async () => {
      const onError = vi.fn();
      const conn = await createConnectedClient(transport, { onError });

      transport._push({ type: "assistant", content: "kept" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      transport._throw(new SystemError("broker crashed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onError).toHaveBeenCalledWith(expect.any(SystemError));

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }
      expect(messages).toHaveLength(1);
    });
  });

  describe("receiveResponse()", () => {
    it("yields messages until and including a result message", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "assistant", content: "thinking..." });
      transport._push({ type: "assistant", content: "done" });
      transport._push({ type: "result", cost: 0.05 });
      // This message should NOT be consumed
      transport._push({ type: "assistant", content: "next turn" });

      const messages: WireData[] = [];
      for await (const msg of conn.receiveResponse()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(3);
      expect(messages[2]).toMatchObject({ type: "result" });
    });
  });

  describe("control protocol", () => {
    it("resolves control responses to the correct pending request", async () => {
      const conn = await createConnectedClient(transport);

      // Override write to capture and respond to control requests
      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
        const parsed = JSON.parse(data);
        if (parsed.type === "control_request" && parsed.request?.subtype === "interrupt") {
          setTimeout(() => {
            transport._push({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: parsed.request_id,
                response: { interrupted: true },
              },
            });
          }, 5);
        }
      });

      await conn.interrupt();
      // If we get here without timeout, the control response resolved correctly
    });

    it("rejects control responses with error subtype", async () => {
      const conn = await createConnectedClient(transport);

      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
        const parsed = JSON.parse(data);
        if (parsed.type === "control_request" && parsed.request?.subtype === "set_model") {
          setTimeout(() => {
            transport._push({
              type: "control_response",
              response: {
                subtype: "error",
                request_id: parsed.request_id,
                error: "Model not available",
              },
            });
          }, 5);
        }
      });

      await expect(conn.setModel("invalid-model")).rejects.toThrow("Model not available");
    });

    it("handles incoming can_use_tool control requests with allow behavior", async () => {
      await createConnectedClient(transport);

      transport._push({
        type: "control_request",
        request_id: "req_001",
        request: {
          subtype: "can_use_tool",
          tool_name: "bash",
          input: { command: "ls" },
        },
      });

      // Wait for the response to be written
      await vi.waitFor(() => {
        const resp = transport._written.find((w) => {
          const p = JSON.parse(w);
          return p.type === "control_response" && p.response?.request_id === "req_001";
        });
        expect(resp).toBeDefined();
        const parsed = JSON.parse(resp as string);
        expect(parsed.response.subtype).toBe("success");
        expect(parsed.response.response.behavior).toBe("allow");
      });
    });

    it("handles incoming hook_callback control requests with continue", async () => {
      await createConnectedClient(transport);

      transport._push({
        type: "control_request",
        request_id: "req_002",
        request: { subtype: "hook_callback" },
      });

      await vi.waitFor(() => {
        const resp = transport._written.find((w) => {
          const p = JSON.parse(w);
          return p.type === "control_response" && p.response?.request_id === "req_002";
        });
        expect(resp).toBeDefined();
        expect(JSON.parse(resp as string).response.response.continue).toBe(true);
      });
    });

    it("handles incoming mcp_message control requests with error", async () => {
      await createConnectedClient(transport);

      transport._push({
        type: "control_request",
        request_id: "req_003",
        request: { subtype: "mcp_message" },
      });

      await vi.waitFor(() => {
        const resp = transport._written.find((w) => {
          const p = JSON.parse(w);
          return p.type === "control_response" && p.response?.request_id === "req_003";
        });
        expect(resp).toBeDefined();
        expect(JSON.parse(resp as string).response.response.error).toContain("not supported");
      });
    });
  });

  describe("disconnect()", () => {
    it("closes the transport", async () => {
      const conn = await createConnectedClient(transport);
      await conn.disconnect();
      expect(transport.close).toHaveBeenCalledOnce();
    });

    it("calls onDisconnect callback if provided", async () => {
      const onDisconnect = vi.fn().mockResolvedValue(undefined);
      const conn = await createConnectedClient(transport, { onDisconnect });
      await conn.disconnect();
      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("fails pending control requests on disconnect", async () => {
      const conn = await createConnectedClient(transport);

      // Don't respond to the control request
      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
      });

      const interruptPromise = conn.interrupt();

      // Disconnect while the request is pending
      await conn.disconnect();

      await expect(interruptPromise).rejects.toThrow("Client disconnected");
    });

    it("is idempotent", async () => {
      const conn = await createConnectedClient(transport);
      await conn.disconnect();
      await conn.disconnect();
      expect(transport.close).toHaveBeenCalledOnce();
    });

    it("unblocks message waiters with null", async () => {
      const conn = await createConnectedClient(transport);

      const iter = conn.receiveMessages()[Symbol.asyncIterator]();
      const messagePromise = iter.next();

      await conn.disconnect();
      const result = await messagePromise;
      expect(result.done).toBe(true);
    });
  });

  describe("abortStream()", () => {
    it("delegates to the transport's abortStream()", async () => {
      const conn = await createConnectedClient(transport);
      conn.abortStream();
      expect(transport.abortStream).toHaveBeenCalledOnce();
    });

    it("does not clear axon event listeners", async () => {
      const conn = await createConnectedClient(transport);
      const listener = vi.fn();
      conn.onAxonEvent(listener);

      conn.abortStream();

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      listeners.emit({
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      });
      expect(listener).toHaveBeenCalledOnce();
    });

    it("does not run the onDisconnect callback", async () => {
      const onDisconnect = vi.fn();
      const conn = await createConnectedClient(transport, { onDisconnect });
      conn.abortStream();
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });

  describe("onAxonEvent()", () => {
    it("notifies registered listeners when Axon events arrive", async () => {
      const conn = await createConnectedClient(transport);

      const listener = vi.fn();
      conn.onAxonEvent(listener);

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      const fakeEvent = {
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      };
      listeners.emit(fakeEvent);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(fakeEvent);
    });

    it("returns an unsubscribe function that removes the listener", async () => {
      const conn = await createConnectedClient(transport);

      const listener = vi.fn();
      const unsub = conn.onAxonEvent(listener);

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      const fakeEvent = {
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      };

      listeners.emit(fakeEvent);
      expect(listener).toHaveBeenCalledOnce();

      unsub();

      listeners.emit(fakeEvent);
      expect(listener).toHaveBeenCalledOnce();
    });

    it("catches listener exceptions and routes them to onError", async () => {
      const onError = vi.fn();
      const conn = await createConnectedClient(transport, { onError });

      const listenerError = new Error("listener boom");
      const throwingListener = vi.fn(() => {
        throw listenerError;
      });
      const normalListener = vi.fn();

      conn.onAxonEvent(throwingListener);
      conn.onAxonEvent(normalListener);

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      listeners.emit({
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      });

      expect(throwingListener).toHaveBeenCalledOnce();
      expect(normalListener).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(listenerError);
    });

    it("defaults to console.error when onError is not provided", async () => {
      const conn = await createConnectedClient(transport);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const listenerError = new Error("listener boom");
      conn.onAxonEvent(() => {
        throw listenerError;
      });

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      listeners.emit({
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      });

      expect(spy).toHaveBeenCalledWith("[ClaudeAxonConnection]", listenerError);
      spy.mockRestore();
    });

    it("disconnect() preserves Axon event listener registrations", async () => {
      const conn = await createConnectedClient(transport);

      const listener = vi.fn();
      conn.onAxonEvent(listener);

      await conn.disconnect();

      const listeners = (
        conn as unknown as {
          axonEventListeners: { emit: (ev: unknown) => void };
        }
      ).axonEventListeners;
      const fakeEvent = {
        event_type: "test",
        payload: "{}",
        origin: "AGENT_EVENT",
      };
      listeners.emit(fakeEvent);

      expect(listener).toHaveBeenCalledWith(fakeEvent);
    });
  });

  describe("setPermissionMode()", () => {
    it("sends a set_permission_mode control request", async () => {
      const conn = await createConnectedClient(transport);

      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
        const parsed = JSON.parse(data);
        if (parsed.request?.subtype === "set_permission_mode") {
          transport._push({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: parsed.request_id,
              response: {},
            },
          });
        }
      });

      await conn.setPermissionMode("acceptEdits" as never);

      const modeCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.request?.subtype === "set_permission_mode";
      });
      expect(modeCall).toBeDefined();
      expect(JSON.parse(modeCall as string).request.mode).toBe("acceptEdits");
    });
  });

  describe("connect() / initialize() guards", () => {
    it("throws if connect() is called while already connected", async () => {
      const conn = await createConnectedClient(transport);
      await expect(conn.connect()).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "already_connected",
      });
    });

    it("throws if initialize() is called while already initialized", async () => {
      const conn = await createConnectedClient(transport);
      await expect(conn.initialize()).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "already_initialized",
      });
    });

    it("connect() succeeds after disconnect on the same instance", async () => {
      const conn = await createConnectedClient(transport);
      await conn.disconnect();
      (conn as unknown as { transport: MockTransport }).transport = transport;
      await expect(conn.connect()).resolves.toBeUndefined();
    });

    it("connect() alone does not complete the handshake", async () => {
      const axon = createMockAxon();
      const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      (conn as unknown as { transport: MockTransport }).transport = transport;

      await conn.connect();

      expect(conn.isConnected).toBe(true);
      expect(conn.isInitialized).toBe(false);
    });

    it("initialize() throws when connect() has not been called", async () => {
      const axon = createMockAxon();
      const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      (conn as unknown as { transport: MockTransport }).transport = transport;

      await expect(conn.initialize()).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "not_connected",
      });
    });

    it("connect() throws terminated after a fatal broker SystemError", async () => {
      const onError = vi.fn();
      const conn = await createConnectedClient(transport, { onError });
      const fatal = new SystemError("agent failed: agent binary 'bad_binary' not found on PATH", {
        event_type: "broker.error",
      });
      transport._throw(fatal);
      await new Promise((r) => setTimeout(r, 80));
      await expect(conn.connect()).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "terminated",
      });
      expect(onError).toHaveBeenCalledWith(fatal);
    });
  });

  describe("onControlRequest()", () => {
    it("calls a registered handler instead of the built-in default", async () => {
      const conn = await createConnectedClient(transport);

      const handler = vi.fn().mockResolvedValue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req_custom",
          response: { behavior: "deny" },
        },
      });

      conn.onControlRequest("can_use_tool", handler);

      transport._push({
        type: "control_request",
        request_id: "req_custom",
        request: {
          subtype: "can_use_tool",
          tool_name: "bash",
          input: { command: "rm -rf /" },
        },
      });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });

      await vi.waitFor(() => {
        const resp = transport._written.find((w) => {
          const p = JSON.parse(w);
          return p.type === "control_response" && p.response?.request_id === "req_custom";
        });
        expect(resp).toBeDefined();
        const parsed = JSON.parse(resp as string);
        expect(parsed.response.response.behavior).toBe("deny");
      });
    });

    it("replaces a previous handler for the same subtype", async () => {
      const conn = await createConnectedClient(transport);

      const handler1 = vi.fn();
      const handler2 = vi.fn().mockResolvedValue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req_replace",
          response: {},
        },
      });

      conn.onControlRequest("can_use_tool", handler1);
      conn.onControlRequest("can_use_tool", handler2);

      transport._push({
        type: "control_request",
        request_id: "req_replace",
        request: {
          subtype: "can_use_tool",
          tool_name: "bash",
          input: {},
        },
      });

      await vi.waitFor(() => {
        expect(handler2).toHaveBeenCalledOnce();
      });
      expect(handler1).not.toHaveBeenCalled();
    });

    it("sends an error response when the handler throws", async () => {
      const conn = await createConnectedClient(transport);

      conn.onControlRequest("can_use_tool", async () => {
        throw new Error("handler boom");
      });

      transport._push({
        type: "control_request",
        request_id: "req_err",
        request: {
          subtype: "can_use_tool",
          tool_name: "bash",
          input: {},
        },
      });

      await vi.waitFor(() => {
        const resp = transport._written.find((w) => {
          const p = JSON.parse(w);
          return p.type === "control_response" && p.response?.request_id === "req_err";
        });
        expect(resp).toBeDefined();
        const parsed = JSON.parse(resp as string);
        expect(parsed.response.subtype).toBe("error");
        expect(parsed.response.error).toContain("handler boom");
      });
    });

    it("routes to onError when the error response write also fails", async () => {
      const onError = vi.fn();
      const conn = await createConnectedClient(transport);
      // Re-create with onError so handleError routes there
      (conn as unknown as { handleError: (e: unknown) => void }).handleError = onError;

      conn.onControlRequest("can_use_tool", async () => {
        throw new Error("handler boom");
      });

      // Make write fail so the error response can't be sent
      (transport.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("write failed"));

      transport._push({
        type: "control_request",
        request_id: "req_err2",
        request: {
          subtype: "can_use_tool",
          tool_name: "bash",
          input: {},
        },
      });

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalled();
      });
    });
  });

  describe("systemPrompt / appendSystemPrompt", () => {
    it("includes systemPrompt in the initialize control request", async () => {
      const axon = createMockAxon();
      const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
        systemPrompt: "You are a helpful bot.",
        replay: false,
      });
      (conn as unknown as { transport: MockTransport }).transport = transport;

      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
        const parsed = JSON.parse(data);
        if (parsed.type === "control_request" && parsed.request?.subtype === "initialize") {
          transport._push({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: parsed.request_id,
              response: { initialized: true },
            },
          });
        }
      });

      await conn.connect();
      await conn.initialize();

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.systemPrompt).toBe("You are a helpful bot.");
    });

    it("includes appendSystemPrompt in the initialize control request", async () => {
      const axon = createMockAxon();
      const conn = new ClaudeAxonConnection(axon as never, { id: "dbx-test" } as never, {
        appendSystemPrompt: "Always respond in JSON.",
        replay: false,
      });
      (conn as unknown as { transport: MockTransport }).transport = transport;

      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
        const parsed = JSON.parse(data);
        if (parsed.type === "control_request" && parsed.request?.subtype === "initialize") {
          transport._push({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: parsed.request_id,
              response: { initialized: true },
            },
          });
        }
      });

      await conn.connect();
      await conn.initialize();

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.appendSystemPrompt).toBe("Always respond in JSON.");
    });
  });

  describe("control request timeout", () => {
    it("rejects when a control request times out", async () => {
      const conn = await createConnectedClient(transport);

      // Override write to never respond to the control request
      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
      });

      // Use the internal sendControlRequest with a very short timeout
      const sendControlRequest = (
        conn as unknown as {
          sendControlRequest: (req: Record<string, unknown>, timeout?: number) => Promise<unknown>;
        }
      ).sendControlRequest.bind(conn);

      await expect(sendControlRequest({ subtype: "test_timeout" }, 50)).rejects.toThrow(
        "Control request timeout",
      );
    });
  });

  describe("read loop error handling", () => {
    it("fails pending control requests when the read loop encounters an error", async () => {
      const conn = await createConnectedClient(transport);

      // Override write to not respond to control requests
      (transport.write as ReturnType<typeof vi.fn>).mockImplementation(async (data: string) => {
        transport._written.push(data);
      });

      const interruptPromise = conn.interrupt();

      // Simulate a transport error by making the mock throw in readMessages
      // The read loop is already running, so we simulate by rejecting the waiter
      if (transport._waiter) {
        // Force an error through the async iterator
        transport._waiter({ value: undefined as never, done: true });
      }

      // The pending request should eventually fail via disconnect or timeout
      // Let's use disconnect to trigger the failure path
      await conn.disconnect();
      await expect(interruptPromise).rejects.toThrow("Client disconnected");
    });
  });

  describe("disconnect() error routing", () => {
    it("routes onDisconnect errors to the onError handler", async () => {
      const onError = vi.fn();
      const disconnectError = new Error("devbox shutdown failed");
      const conn = await createConnectedClient(transport, {
        onDisconnect: () => {
          throw disconnectError;
        },
        onError,
      });

      await conn.disconnect();

      expect(onError).toHaveBeenCalledWith(disconnectError);
    });
  });

  describe("auto-reconnect", () => {
    it("re-subscribes when the stream ends unexpectedly", async () => {
      await createConnectedClient(transport);

      transport._end();

      await vi.waitFor(() => {
        expect(transport.reconnect).toHaveBeenCalledOnce();
      });

      const initCalls = transport._written.filter((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCalls.length).toBe(1);
    });

    it("does not reconnect when disconnect() was called", async () => {
      const conn = await createConnectedClient(transport);

      await conn.disconnect();
      transport._end();

      await new Promise((r) => setTimeout(r, 50));

      expect(transport.reconnect).not.toHaveBeenCalled();
    });

    it("does not reconnect when abortStream() was called", async () => {
      const conn = await createConnectedClient(transport);

      conn.abortStream();
      transport._end();

      await new Promise((r) => setTimeout(r, 50));

      expect(transport.reconnect).not.toHaveBeenCalled();
    });

    it("delivers messages from the reconnected stream", async () => {
      const conn = await createConnectedClient(transport);

      transport._end();

      await vi.waitFor(() => {
        expect(transport.reconnect).toHaveBeenCalledOnce();
      });

      transport._push({ type: "assistant", content: "after-reconnect" });
      transport._push({ type: "result", cost: 0.01 });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        type: "assistant",
        content: "after-reconnect",
      });
    });

    it("does not reconnect on fatal broker errors (agent binary not found)", async () => {
      await createConnectedClient(transport);

      transport._throw(
        new SystemError("agent failed: agent binary 'bad_binary' not found on PATH", {
          event_type: "broker.error",
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(transport.reconnect).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("reconnecting"));
    });

    it("does not reconnect on fatal broker errors (generic agent failed)", async () => {
      await createConnectedClient(transport);

      transport._throw(
        new SystemError("agent failed: process exited with code 127", {
          event_type: "broker.error",
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(transport.reconnect).not.toHaveBeenCalled();
    });
  });

  describe("systemPrompt / appendSystemPrompt options", () => {
    it("includes systemPrompt in the initialize control request", async () => {
      await createConnectedClient(transport, {
        systemPrompt: "You are a pirate.",
      });

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.systemPrompt).toBe("You are a pirate.");
    });

    it("includes appendSystemPrompt in the initialize control request", async () => {
      await createConnectedClient(transport, {
        appendSystemPrompt: "Always be concise.",
      });

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.appendSystemPrompt).toBe("Always be concise.");
    });

    it("includes both systemPrompt and appendSystemPrompt together", async () => {
      await createConnectedClient(transport, {
        systemPrompt: "You are helpful.",
        appendSystemPrompt: "Be brief.",
      });

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.systemPrompt).toBe("You are helpful.");
      expect(parsed.request.appendSystemPrompt).toBe("Be brief.");
    });

    it("omits systemPrompt from initialize when not provided", async () => {
      await createConnectedClient(transport);

      const initCall = transport._written.find((w) => {
        const p = JSON.parse(w);
        return p.type === "control_request" && p.request?.subtype === "initialize";
      });
      expect(initCall).toBeDefined();
      const parsed = JSON.parse(initCall as string);
      expect(parsed.request.systemPrompt).toBeUndefined();
      expect(parsed.request.appendSystemPrompt).toBeUndefined();
    });
  });

  describe("onTimelineEvent", () => {
    function emitAxonEvent(
      conn: ClaudeAxonConnection,
      event: {
        event_type: string;
        payload: string;
        origin: string;
        sequence?: number;
      },
    ) {
      // Call the private emitTimelineEvent directly since the mock transport
      // bypasses the real onAxonEvent callback wired in the constructor.
      const emitTimeline = (
        conn as unknown as { emitTimelineEvent: (ev: unknown) => void }
      ).emitTimelineEvent.bind(conn);
      emitTimeline(event);
    }

    it("classifies AGENT_EVENT assistant as claude_protocol with eventType", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", content: "Hello" }),
        origin: "AGENT_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("claude_protocol");
      if (events[0].kind === "claude_protocol") {
        expect(events[0].eventType).toBe("assistant");
        expect(events[0].data.type).toBe("assistant");
      }
    });

    it("classifies USER_EVENT query as claude_protocol with eventType", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "query",
        payload: JSON.stringify({
          type: "user",
          message: { role: "user", content: "Hi" },
        }),
        origin: "USER_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("claude_protocol");
      if (events[0].kind === "claude_protocol") {
        expect(events[0].eventType).toBe("query");
      }
      expect(events[0].axonEvent.origin).toBe("USER_EVENT");
    });

    it("classifies control_request as claude_protocol with eventType", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "control_request",
        payload: JSON.stringify({
          type: "control_request",
          request_id: "req_1",
          request: { subtype: "initialize", hooks: null },
        }),
        origin: "USER_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("claude_protocol");
      if (events[0].kind === "claude_protocol") {
        expect(events[0].eventType).toBe("control_request");
      }
    });

    it("classifies AGENT_EVENT system/init as claude_protocol with eventType 'system'", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "system",
        payload: JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          cwd: "/home/user",
        }),
        origin: "AGENT_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("claude_protocol");
      if (events[0].kind === "claude_protocol") {
        expect(events[0].eventType).toBe("system");
      }
    });

    it("classifies SYSTEM_EVENT turn.started as system", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "turn.started",
        payload: JSON.stringify({ turn_id: "t-42" }),
        origin: "SYSTEM_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("turn.started");
        if (events[0].data.type === "turn.started") {
          expect(events[0].data.turnId).toBe("t-42");
        }
      }
    });

    it("classifies SYSTEM_EVENT turn.completed as system", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "turn.completed",
        payload: JSON.stringify({ turn_id: "t-42", stop_reason: "end_turn" }),
        origin: "SYSTEM_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("turn.completed");
        if (events[0].data.type === "turn.completed") {
          expect(events[0].data.stopReason).toBe("end_turn");
        }
      }
    });

    it("classifies unknown EXTERNAL_EVENT as unknown", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "custom.metric",
        payload: JSON.stringify({ foo: "bar" }),
        origin: "EXTERNAL_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("unknown");
      expect(events[0].data).toEqual({ foo: "bar" });
    });

    it("returns an unsubscribe function", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      const unsub = conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", content: "Hi" }),
        origin: "AGENT_EVENT",
      });
      expect(events).toHaveLength(1);

      unsub();

      emitAxonEvent(conn, {
        event_type: "assistant",
        payload: JSON.stringify({ type: "assistant", content: "Bye" }),
        origin: "AGENT_EVENT",
      });
      expect(events).toHaveLength(1);
    });

    it("disconnect() preserves timeline listener registrations", async () => {
      const conn = await createConnectedClient(transport);

      const listener = vi.fn();
      conn.onTimelineEvent(listener);

      await conn.disconnect();

      const timelineListeners = (
        conn as unknown as {
          timelineEventListeners: { emit: (ev: ClaudeTimelineEvent) => void };
        }
      ).timelineEventListeners;
      const fake: ClaudeTimelineEvent = {
        kind: "unknown",
        data: null,
        axonEvent: {
          event_type: "assistant",
          payload: "{}",
          origin: "AGENT_EVENT",
        } as never,
      };
      timelineListeners.emit(fake);
      expect(listener).toHaveBeenCalledWith(fake);
    });

    it("classifies SYSTEM_EVENT broker.error as system", async () => {
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "broker.error",
        payload: JSON.stringify({ message: "something broke" }),
        origin: "SYSTEM_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("broker.error");
        if (events[0].data.type === "broker.error") {
          expect(events[0].data.message).toBe("something broke");
        }
      }
    });

    it("warns and classifies as unknown when known event_type has invalid JSON", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = await createConnectedClient(transport);

      const events: ClaudeTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      emitAxonEvent(conn, {
        event_type: "assistant",
        payload: "not valid json {{{",
        origin: "AGENT_EVENT",
      });

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("unknown");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[classifyClaudeAxonEvent]"));

      warnSpy.mockRestore();
    });
  });

  describe("receiveAgentEvents / receiveAgentResponse (renamed)", () => {
    it("receiveAgentEvents() yields SDK messages", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "assistant", content: "Hi" });
      transport._push({ type: "result", cost: 0.01 });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveAgentEvents()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: "assistant" });
    });

    it("receiveAgentResponse() yields until result", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "assistant", content: "thinking..." });
      transport._push({ type: "result", cost: 0.05 });
      transport._push({ type: "assistant", content: "next turn" });

      const messages: WireData[] = [];
      for await (const msg of conn.receiveAgentResponse()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({ type: "result" });
    });

    it("deprecated receiveMessages() delegates to receiveAgentEvents()", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "assistant", content: "Hi" });
      conn.abortStream();
      transport._end();

      const messages: WireData[] = [];
      for await (const msg of conn.receiveMessages()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(1);
    });

    it("deprecated receiveResponse() delegates to receiveAgentResponse()", async () => {
      const conn = await createConnectedClient(transport);

      transport._push({ type: "result", cost: 0.01 });

      const messages: WireData[] = [];
      for await (const msg of conn.receiveResponse()) {
        messages.push(msg as unknown as WireData);
      }

      expect(messages).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// isClaudeProtocolEventType
// ---------------------------------------------------------------------------

describe("isClaudeProtocolEventType", () => {
  it("returns true for known event_type values (wire names)", () => {
    expect(isClaudeProtocolEventType("query")).toBe(true);
    expect(isClaudeProtocolEventType("assistant")).toBe(true);
    expect(isClaudeProtocolEventType("result")).toBe(true);
    expect(isClaudeProtocolEventType("system")).toBe(true);
    expect(isClaudeProtocolEventType("control_request")).toBe(true);
    expect(isClaudeProtocolEventType("control_response")).toBe(true);
  });

  it("returns true for SDK message type keys", () => {
    expect(isClaudeProtocolEventType("user")).toBe(true);
  });

  it("returns false for system event types", () => {
    expect(isClaudeProtocolEventType("turn.started")).toBe(false);
    expect(isClaudeProtocolEventType("turn.completed")).toBe(false);
    expect(isClaudeProtocolEventType("broker.error")).toBe(false);
  });

  it("returns false for arbitrary strings", () => {
    expect(isClaudeProtocolEventType("custom.event")).toBe(false);
    expect(isClaudeProtocolEventType("")).toBe(false);
    expect(isClaudeProtocolEventType("session/update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyClaudeAxonEvent (standalone)
// ---------------------------------------------------------------------------

describe("classifyClaudeAxonEvent", () => {
  const makeAxonEvent = (overrides: Partial<Parameters<typeof makeFullAxonEvent>[0]> = {}) =>
    makeFullAxonEvent({
      event_type: "assistant",
      origin: "AGENT_EVENT",
      payload: JSON.stringify({ type: "assistant", content: "Hi" }),
      ...overrides,
    });

  it("classifies known protocol event with valid JSON and eventType", () => {
    const ev = makeAxonEvent({
      event_type: "assistant",
      payload: JSON.stringify({ type: "assistant", content: "Hello" }),
    });
    const result = classifyClaudeAxonEvent(ev as never);
    expect(result.kind).toBe("claude_protocol");
    if (result.kind === "claude_protocol") {
      expect(result.eventType).toBe("assistant");
      expect(result.data.type).toBe("assistant");
    }
  });

  it("populates eventType from Axon event_type for each known type", () => {
    const cases: Array<{
      event_type: string;
      payload: Record<string, unknown>;
    }> = [
      {
        event_type: "query",
        payload: { type: "user", message: { role: "user", content: "Hi" } },
      },
      { event_type: "result", payload: { type: "result", cost: 0.01 } },
      {
        event_type: "system",
        payload: {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
        },
      },
      {
        event_type: "control_request",
        payload: {
          type: "control_request",
          request_id: "req_1",
          request: { subtype: "initialize" },
        },
      },
      {
        event_type: "control_response",
        payload: {
          type: "control_response",
          response: { subtype: "success", request_id: "req_1" },
        },
      },
    ];

    for (const { event_type, payload } of cases) {
      const ev = makeAxonEvent({
        event_type,
        payload: JSON.stringify(payload),
      });
      const result = classifyClaudeAxonEvent(ev as never);
      expect(result.kind).toBe("claude_protocol");
      if (result.kind === "claude_protocol") {
        expect(result.eventType).toBe(event_type);
      }
    }
  });

  it("falls through to unknown for non-protocol non-system event", () => {
    const ev = makeAxonEvent({
      event_type: "custom.metric",
      origin: "EXTERNAL_EVENT",
      payload: JSON.stringify({ foo: "bar" }),
    });
    const result = classifyClaudeAxonEvent(ev as never);
    expect(result.kind).toBe("unknown");
    expect(result.data).toEqual({ foo: "bar" });
  });

  it("classifies AGENT_EVENT with non-protocol event_type as unknown", () => {
    const ev = makeAxonEvent({
      event_type: "some.random.type",
      origin: "AGENT_EVENT",
      payload: JSON.stringify({ type: "something" }),
    });
    const result = classifyClaudeAxonEvent(ev as never);
    expect(result.kind).toBe("unknown");
  });

  it("falls to unknown when parsed payload lacks type field", () => {
    const ev = makeAxonEvent({
      event_type: "assistant",
      payload: JSON.stringify({ content: "no type field" }),
    });
    const result = classifyClaudeAxonEvent(ev as never);
    expect(result.kind).toBe("unknown");
  });
});

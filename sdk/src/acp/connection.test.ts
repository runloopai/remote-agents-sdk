import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createControllableStream,
  createMockAxon,
  makeAgentEvent,
  makeExternalEvent,
  makeFullAxonEvent,
  makeSystemEvent,
} from "../__test-utils__/mock-axon.js";
import { ACPRequestError } from "../shared/errors/acp-request-error.js";
import { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { InitializationError } from "../shared/errors/initialization-error.js";
import { ACPAxonConnection, classifyACPAxonEvent, isACPProtocolEventType } from "./connection.js";
import type { ACPTimelineEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissionOptions(kinds: string[]) {
  return kinds.map((kind, i) => ({
    kind,
    name: `Option ${kind}`,
    optionId: `opt${i + 1}`,
  }));
}

function makePermissionRequest(options: ReturnType<typeof makePermissionOptions>) {
  return {
    sessionId: "test-session",
    toolCall: { toolCallId: "tc-1" },
    options,
  };
}

function makeSessionNotification(update: Record<string, unknown>, sessionId?: string) {
  return {
    sessionId: sessionId ?? "test-session",
    update,
  };
}

function makeUsageUpdate() {
  return { sessionUpdate: "usage_update", size: 100000, used: 5000 };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 10);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ACPAxonConnection", () => {
  describe("constructor properties", () => {
    it("exposes axonId from the provided Axon", () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never);
      expect(conn.axonId).toBe("test-axon");
      conn.disconnect();
    });

    it("exposes devboxId from the positional parameter", () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-456" } as never);
      expect(conn.devboxId).toBe("dbx-456");
      conn.disconnect();
    });
  });

  describe("default permission handler", () => {
    it("prefers allow_always when available", async () => {
      const ctrl = createControllableStream();
      const { axon, published } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const options = makePermissionOptions(["allow_once", "allow_always", "reject_once"]);
      ctrl.push(makeAgentEvent("session/request_permission", makePermissionRequest(options)));

      await waitFor(() => published.some((p) => p.event_type === "session/request_permission"));

      const response = published.find((p) => p.event_type === "session/request_permission");
      const payload = JSON.parse(response?.payload as string);
      expect(payload.outcome.outcome).toBe("selected");
      expect(payload.outcome.optionId).toBe("opt2");

      conn.disconnect();
    });

    it("falls back to allow_once when allow_always is not available", async () => {
      const ctrl = createControllableStream();
      const { axon, published } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const options = makePermissionOptions(["reject_once", "allow_once"]);
      ctrl.push(makeAgentEvent("session/request_permission", makePermissionRequest(options)));

      await waitFor(() => published.some((p) => p.event_type === "session/request_permission"));

      const response = published.find((p) => p.event_type === "session/request_permission");
      const payload = JSON.parse(response?.payload as string);
      expect(payload.outcome.outcome).toBe("selected");
      expect(payload.outcome.optionId).toBe("opt2");

      conn.disconnect();
    });

    it("falls back to first option when neither allow_always nor allow_once exists", async () => {
      const ctrl = createControllableStream();
      const { axon, published } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const options = makePermissionOptions(["reject_once", "reject_always"]);
      ctrl.push(makeAgentEvent("session/request_permission", makePermissionRequest(options)));

      await waitFor(() => published.some((p) => p.event_type === "session/request_permission"));

      const response = published.find((p) => p.event_type === "session/request_permission");
      const payload = JSON.parse(response?.payload as string);
      expect(payload.outcome.outcome).toBe("selected");
      expect(payload.outcome.optionId).toBe("opt1");

      conn.disconnect();
    });

    it("returns cancelled when options array is empty", async () => {
      const ctrl = createControllableStream();
      const { axon, published } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      ctrl.push(makeAgentEvent("session/request_permission", makePermissionRequest([])));

      await waitFor(() => published.some((p) => p.event_type === "session/request_permission"));

      const response = published.find((p) => p.event_type === "session/request_permission");
      const payload = JSON.parse(response?.payload as string);
      expect(payload.outcome.outcome).toBe("cancelled");

      conn.disconnect();
    });

    it("uses custom requestPermission handler when provided", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const customHandler = vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "opt1" },
      });

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        requestPermission: customHandler,
        replay: false,
      });
      await conn.connect();

      const options = makePermissionOptions(["allow_always"]);
      ctrl.push(makeAgentEvent("session/request_permission", makePermissionRequest(options)));

      await waitFor(() => customHandler.mock.calls.length > 0);

      expect(customHandler).toHaveBeenCalledOnce();
      expect(customHandler.mock.calls[0][0].options).toEqual(options);

      conn.disconnect();
    });
  });

  describe("onSessionUpdate listeners", () => {
    it("notifies all registered listeners on session/update events", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      conn.onSessionUpdate(listener1);
      conn.onSessionUpdate(listener2);

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate(), "s1")));

      await waitFor(() => listener1.mock.calls.length > 0);

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();

      expect(listener1.mock.calls[0][0]).toBe("s1");
      expect(listener1.mock.calls[0][1]).toMatchObject({
        sessionUpdate: "usage_update",
      });

      conn.disconnect();
    });

    it("returns an unsubscribe function that removes the listener", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      const unsubscribe = conn.onSessionUpdate(listener);

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate(), "s1")));

      await waitFor(() => listener.mock.calls.length > 0);
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate(), "s1")));

      await new Promise((r) => setTimeout(r, 100));
      expect(listener).toHaveBeenCalledOnce();

      conn.disconnect();
    });
  });

  describe("onAxonEvent listeners", () => {
    it("notifies all registered listeners for every Axon event", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      conn.onAxonEvent(listener);

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));
      ctrl.push({
        event_type: "ping",
        payload: "{}",
        origin: "USER_EVENT",
      });

      await waitFor(() => listener.mock.calls.length >= 2);
      expect(listener).toHaveBeenCalledTimes(2);

      conn.disconnect();
    });

    it("returns an unsubscribe function", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      const unsub = conn.onAxonEvent(listener);

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));
      await waitFor(() => listener.mock.calls.length > 0);

      unsub();

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));
      await new Promise((r) => setTimeout(r, 100));
      expect(listener).toHaveBeenCalledOnce();

      conn.disconnect();
    });
  });

  describe("error isolation", () => {
    it("catches listener exceptions without crashing the connection", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onError = vi.fn();
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onError,
        replay: false,
      });
      await conn.connect();

      const throwingListener = vi.fn().mockImplementation(() => {
        throw new Error("listener boom");
      });
      const normalListener = vi.fn();

      conn.onSessionUpdate(throwingListener);
      conn.onSessionUpdate(normalListener);

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate(), "s1")));

      await waitFor(() => normalListener.mock.calls.length > 0);

      expect(throwingListener).toHaveBeenCalledOnce();
      expect(normalListener).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);

      conn.disconnect();
    });

    it("catches Axon event listener exceptions without crashing", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onError = vi.fn();
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onError,
        replay: false,
      });
      await conn.connect();

      conn.onAxonEvent(() => {
        throw new Error("raw listener boom");
      });

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));

      await waitFor(() => onError.mock.calls.length > 0);
      expect(onError).toHaveBeenCalled();

      conn.disconnect();
    });
  });

  describe("abortStream()", () => {
    it("does not clear session update listeners", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      conn.onSessionUpdate(listener);

      conn.abortStream();

      // Listeners should still be registered (inspectable via private set size)
      const listenerCount = (conn as unknown as { sessionUpdateListeners: Set<unknown> })
        .sessionUpdateListeners.size;
      expect(listenerCount).toBe(1);

      conn.disconnect();
    });

    it("does not clear axon event listeners", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      conn.onAxonEvent(listener);

      conn.abortStream();

      const listenerCount = (conn as unknown as { axonEventListeners: { size: number } })
        .axonEventListeners.size;
      expect(listenerCount).toBe(1);

      conn.disconnect();
    });

    it("does not run the onDisconnect callback", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onDisconnect = vi.fn();
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onDisconnect,
        replay: false,
      });
      await conn.connect();

      conn.abortStream();
      expect(onDisconnect).not.toHaveBeenCalled();

      conn.disconnect();
    });
  });

  describe("lifecycle", () => {
    it("disconnect() preserves listener registrations for reconnect", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const rawListener = vi.fn();
      conn.onAxonEvent(rawListener);

      await conn.disconnect();

      const axonListeners = (
        conn as unknown as { axonEventListeners: { emit: (ev: unknown) => void } }
      ).axonEventListeners;
      const fakeEvent = { event_type: "test", payload: "{}", origin: "AGENT_EVENT" };
      axonListeners.emit(fakeEvent as never);
      expect(rawListener).toHaveBeenCalledWith(fakeEvent);
    });

    it("disconnect() runs the onDisconnect callback", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onDisconnect = vi.fn().mockResolvedValue(undefined);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onDisconnect,
        replay: false,
      });
      await conn.connect();

      await conn.disconnect();

      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("disconnect() works when no onDisconnect callback is provided", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();
      await conn.disconnect();
    });

    it("disconnect() is idempotent — second call is a no-op", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onDisconnect = vi.fn().mockResolvedValue(undefined);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onDisconnect,
        replay: false,
      });
      await conn.connect();

      await conn.disconnect();
      await conn.disconnect();

      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("connect() then initialize() works after disconnect()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();
      await conn.disconnect();
      await conn.connect();

      const mockResult = { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "test" } };
      conn.protocol.initialize = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "reconnect", version: "1.0" },
      });

      expect(conn.protocol.initialize).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
    });
  });

  describe("proxied agent methods", () => {
    it("initialize() delegates to protocol.initialize()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "test" } };
      conn.protocol.initialize = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "test", version: "1.0" },
      });

      expect(conn.protocol.initialize).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("initialize() wraps failures in InitializationError", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const originalError = new Error("agent binary not found");
      conn.protocol.initialize = vi.fn().mockRejectedValue(originalError);

      try {
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "test", version: "1.0" },
        });
        expect.fail("Expected InitializationError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InitializationError);
        expect((err as InitializationError).message).toBe("agent binary not found");
        expect((err as InitializationError).cause).toBe(originalError);
      }

      conn.disconnect();
    });

    it("initialize() wraps raw JSON-RPC error rejections into InitializationError with code-prefixed message", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      conn.protocol.initialize = vi.fn().mockRejectedValue({
        code: -32601,
        message: '"Method not found": initialize',
        data: { method: "initialize" },
      });

      try {
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "test", version: "1.0" },
        });
        expect.fail("Expected InitializationError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InitializationError);
        // Without ACPRequestError wrapping, the message would be "[object Object]".
        expect((err as InitializationError).message).toBe(
          '[-32601] "Method not found": initialize {"method":"initialize"}',
        );
        expect((err as InitializationError).cause).toBeInstanceOf(ACPRequestError);
        expect(((err as InitializationError).cause as ACPRequestError).code).toBe(-32601);
      }

      conn.disconnect();
    });

    it("newSession() delegates to protocol.newSession()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { sessionId: "s-1" };
      conn.protocol.newSession = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.newSession({ cwd: "/home/user", mcpServers: [] } as never);

      expect(conn.protocol.newSession).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("prompt() delegates to protocol.prompt()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { stopReason: "end_turn" };
      conn.protocol.prompt = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.prompt({
        sessionId: "s-1",
        prompt: [{ type: "text", text: "Hello" }],
      } as never);

      expect(conn.protocol.prompt).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("prompt() converts raw JSON-RPC error rejections into ACPRequestError", async () => {
      // The upstream @agentclientprotocol/sdk rejects with the raw `error`
      // object (`{ code, message, data }`) rather than an Error — this would
      // otherwise stringify to "[object Object]" at the call site.
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      conn.protocol.prompt = vi.fn().mockRejectedValue({
        code: -32000,
        message: "You have exhausted your daily quota on this model.",
        data: { event_type: "turn.failed" },
      });

      try {
        await conn.prompt({
          sessionId: "s-1",
          prompt: [{ type: "text", text: "Hello" }],
        } as never);
        expect.fail("Expected ACPRequestError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ACPRequestError);
        expect((err as ACPRequestError).code).toBe(-32000);
        expect((err as ACPRequestError).data).toEqual({ event_type: "turn.failed" });
        expect((err as ACPRequestError).message).toBe(
          '[-32000] You have exhausted your daily quota on this model. {"event_type":"turn.failed"}',
        );
      }

      conn.disconnect();
    });

    it("prompt() rethrows real Error instances unchanged", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const original = new Error("transport closed");
      conn.protocol.prompt = vi.fn().mockRejectedValue(original);

      await expect(
        conn.prompt({
          sessionId: "s-1",
          prompt: [{ type: "text", text: "Hello" }],
        } as never),
      ).rejects.toBe(original);

      conn.disconnect();
    });

    it("cancel() delegates to protocol.cancel()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      conn.protocol.cancel = vi.fn().mockResolvedValue(undefined);

      await conn.cancel({ sessionId: "s-1" } as never);

      expect(conn.protocol.cancel).toHaveBeenCalledOnce();
      conn.disconnect();
    });

    it("listSessions() delegates to protocol.listSessions()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { sessions: [] };
      conn.protocol.listSessions = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.listSessions({} as never);

      expect(conn.protocol.listSessions).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("loadSession() delegates to protocol.loadSession()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { sessionId: "s-1" };
      conn.protocol.loadSession = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.loadSession({ sessionId: "s-1" } as never);

      expect(conn.protocol.loadSession).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("setSessionMode() delegates to protocol.setSessionMode()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      conn.protocol.setSessionMode = vi.fn().mockResolvedValue({});

      await conn.setSessionMode({ sessionId: "s-1", mode: "code" } as never);

      expect(conn.protocol.setSessionMode).toHaveBeenCalledOnce();
      conn.disconnect();
    });

    it("extMethod() delegates to protocol.extMethod()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { data: "custom" };
      conn.protocol.extMethod = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.extMethod("custom/method", { key: "value" });

      expect(conn.protocol.extMethod).toHaveBeenCalledWith("custom/method", { key: "value" });
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("extNotification() delegates to protocol.extNotification()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      conn.protocol.extNotification = vi.fn().mockResolvedValue(undefined);

      await conn.extNotification("custom/notify", { data: true });

      expect(conn.protocol.extNotification).toHaveBeenCalledWith("custom/notify", { data: true });
      conn.disconnect();
    });

    it("authenticate() delegates to protocol.authenticate()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = { success: true };
      conn.protocol.authenticate = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.authenticate({ method: "token", credentials: {} } as never);

      expect(conn.protocol.authenticate).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });

    it("setSessionConfigOption() delegates to protocol.setSessionConfigOption()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const mockResult = {};
      conn.protocol.setSessionConfigOption = vi.fn().mockResolvedValue(mockResult);

      const result = await conn.setSessionConfigOption({
        sessionId: "s-1",
        key: "maxTokens",
        value: 1000,
      } as never);

      expect(conn.protocol.setSessionConfigOption).toHaveBeenCalledOnce();
      expect(result).toBe(mockResult);
      conn.disconnect();
    });
  });

  describe("signal and closed getters", () => {
    it("signal returns the protocol's abort signal", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      expect(conn.signal).toBe(conn.protocol.signal);
      conn.disconnect();
    });

    it("closed returns the protocol's closed promise", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      expect(conn.closed).toBe(conn.protocol.closed);
      conn.disconnect();
    });
  });

  describe("sessionId handling", () => {
    it("passes the sessionId through to listeners", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      conn.onSessionUpdate(listener);

      ctrl.push(
        makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate(), "s-42")),
      );

      await waitFor(() => listener.mock.calls.length > 0);

      expect(listener.mock.calls[0][0]).toBe("s-42");

      conn.disconnect();
    });
  });

  describe("publish()", () => {
    it("delegates to axon.publish() with the provided params", async () => {
      const ctrl = createControllableStream();
      const { axon, published } = createMockAxon(ctrl);

      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });

      const params = {
        event_type: "agent_config",
        origin: "EXTERNAL_EVENT" as const,
        payload: JSON.stringify({ agentType: "acp", model: "test" }),
        source: "combined-app",
      };

      await conn.publish(params);

      expect(axon.publish).toHaveBeenCalledOnce();
      expect(axon.publish).toHaveBeenCalledWith(params);
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual(params);

      conn.disconnect();
    });
  });

  describe("disconnect guard", () => {
    it("throws when calling methods after disconnect()", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      await conn.disconnect();

      await expect(conn.initialize({} as never)).rejects.toMatchObject({
        name: "ConnectionStateError",
        code: "not_connected",
      });
      const expectNotConnectedSync = (fn: () => unknown) => {
        try {
          fn();
          expect.fail("expected ConnectionStateError");
        } catch (e) {
          expect(e).toBeInstanceOf(ConnectionStateError);
          expect((e as ConnectionStateError).code).toBe("not_connected");
        }
      };
      expectNotConnectedSync(() => conn.newSession({} as never));
      expectNotConnectedSync(() => conn.loadSession({} as never));
      expectNotConnectedSync(() => conn.listSessions({} as never));
      expectNotConnectedSync(() => conn.prompt({} as never));
      expectNotConnectedSync(() => conn.cancel({} as never));
      expectNotConnectedSync(() => conn.authenticate({} as never));
      expectNotConnectedSync(() => conn.setSessionMode({} as never));
      expectNotConnectedSync(() => conn.setSessionConfigOption({} as never));
      expectNotConnectedSync(() => conn.extMethod("x", {}));
      expectNotConnectedSync(() => conn.extNotification("x", {}));
    });
  });

  describe("disconnect() error routing", () => {
    it("routes onDisconnect errors to the onError handler", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);

      const onError = vi.fn();
      const disconnectError = new Error("devbox shutdown failed");
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        onDisconnect: () => {
          throw disconnectError;
        },
        onError,
        replay: false,
      });
      await conn.connect();

      await conn.disconnect();

      expect(onError).toHaveBeenCalledWith(disconnectError);
    });
  });

  describe("onTimelineEvent", () => {
    it("classifies AGENT_EVENT session/update as acp_protocol with eventType", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("acp_protocol");
      if (events[0].kind === "acp_protocol") {
        expect(events[0].eventType).toBe("session/update");
      }
      expect(events[0].axonEvent.origin).toBe("AGENT_EVENT");

      conn.disconnect();
    });

    it("classifies USER_EVENT initialize as acp_protocol with eventType", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push({
        event_type: "initialize",
        payload: JSON.stringify({ protocolVersion: "1.0" }),
        origin: "USER_EVENT",
      });

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("acp_protocol");
      if (events[0].kind === "acp_protocol") {
        expect(events[0].eventType).toBe("initialize");
      }
      expect(events[0].axonEvent.origin).toBe("USER_EVENT");

      conn.disconnect();
    });

    it("classifies SYSTEM_EVENT turn.started as system", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(makeSystemEvent("turn.started", { turn_id: "t-1" }));

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("turn.started");
        if (events[0].data.type === "turn.started") {
          expect(events[0].data.turnId).toBe("t-1");
        }
      }

      conn.disconnect();
    });

    it("classifies SYSTEM_EVENT turn.completed as system", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(makeSystemEvent("turn.completed", { turn_id: "t-1", stop_reason: "end_turn" }));

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("turn.completed");
        if (events[0].data.type === "turn.completed") {
          expect(events[0].data.turnId).toBe("t-1");
          expect(events[0].data.stopReason).toBe("end_turn");
        }
      }

      conn.disconnect();
    });

    it("classifies SYSTEM_EVENT turn.failed as system", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(
        makeSystemEvent("turn.failed", {
          turn_id: "t-1",
          error: "You have exhausted your daily quota on this model.",
          stop_reason: "Error",
        }),
      );

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("system");
      if (events[0].kind === "system") {
        expect(events[0].data.type).toBe("turn.failed");
        if (events[0].data.type === "turn.failed") {
          expect(events[0].data.turnId).toBe("t-1");
          expect(events[0].data.error).toBe("You have exhausted your daily quota on this model.");
          expect(events[0].data.stopReason).toBe("Error");
        }
      }

      conn.disconnect();
    });

    it("classifies SYSTEM_EVENT broker.error as system", () => {
      const ev = makeFullAxonEvent({
        event_type: "broker.error",
        origin: "SYSTEM_EVENT",
        payload: JSON.stringify({ message: "something broke" }),
      });
      const result = classifyACPAxonEvent(ev as never);
      expect(result.kind).toBe("system");
      if (result.kind === "system") {
        expect(result.data.type).toBe("broker.error");
        if (result.data.type === "broker.error") {
          expect(result.data.message).toBe("something broke");
        }
      }
    });

    it("classifies unknown EXTERNAL_EVENT as unknown", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(makeExternalEvent("custom.event", { foo: "bar" }));

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("unknown");
      expect(events[0].data).toEqual({ foo: "bar" });

      conn.disconnect();
    });

    it("returns an unsubscribe function", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      const unsub = conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));
      await waitFor(() => events.length > 0);

      unsub();

      ctrl.push(makeAgentEvent("session/update", makeSessionNotification(makeUsageUpdate())));
      await new Promise((r) => setTimeout(r, 100));
      expect(events).toHaveLength(1);

      conn.disconnect();
    });

    it("disconnect() preserves timeline listener registrations", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const listener = vi.fn();
      conn.onTimelineEvent(listener);

      await conn.disconnect();

      const timelineListeners = (
        conn as unknown as { timelineEventListeners: { emit: (ev: ACPTimelineEvent) => void } }
      ).timelineEventListeners;
      const fake: ACPTimelineEvent = {
        kind: "unknown",
        data: null,
        axonEvent: { event_type: "x", payload: "{}", origin: "AGENT_EVENT" } as never,
      };
      timelineListeners.emit(fake);
      expect(listener).toHaveBeenCalledWith(fake);
    });

    it("sets data to SessionNotification shape for session/update", async () => {
      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      const notification = makeSessionNotification(makeUsageUpdate(), "sess-42");
      ctrl.push(makeAgentEvent("session/update", notification));

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("acp_protocol");
      if (events[0].kind === "acp_protocol") {
        const data = events[0].data as Record<string, unknown>;
        expect(data.sessionId).toBe("sess-42");
        expect(data.update).toEqual(makeUsageUpdate());
      }

      conn.disconnect();
    });

    it("warns and returns acp_protocol with null data on invalid JSON payload", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const ctrl = createControllableStream();
      const { axon } = createMockAxon(ctrl);
      const conn = new ACPAxonConnection(axon as never, { id: "dbx-test" } as never, {
        replay: false,
      });
      await conn.connect();

      const events: ACPTimelineEvent[] = [];
      conn.onTimelineEvent((ev) => events.push(ev));

      ctrl.push({
        event_type: "session/update",
        payload: "not valid json {{{",
        origin: "AGENT_EVENT",
      });

      await waitFor(() => events.length > 0);
      expect(events[0].kind).toBe("acp_protocol");
      if (events[0].kind === "acp_protocol") {
        expect(events[0].data).toBeNull();
      }
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[classifyACPAxonEvent]"));

      warnSpy.mockRestore();
      conn.disconnect();
    });
  });
});

// ---------------------------------------------------------------------------
// isACPProtocolEventType
// ---------------------------------------------------------------------------

describe("isACPProtocolEventType", () => {
  it("returns true for known agent methods", () => {
    expect(isACPProtocolEventType("session/update")).toBe(true);
    expect(isACPProtocolEventType("session/prompt")).toBe(true);
    expect(isACPProtocolEventType("session/new")).toBe(true);
  });

  it("returns true for known client methods", () => {
    expect(isACPProtocolEventType("initialize")).toBe(true);
  });

  it("returns false for system event types", () => {
    expect(isACPProtocolEventType("turn.started")).toBe(false);
    expect(isACPProtocolEventType("turn.completed")).toBe(false);
    expect(isACPProtocolEventType("turn.failed")).toBe(false);
    expect(isACPProtocolEventType("broker.error")).toBe(false);
  });

  it("returns false for arbitrary strings", () => {
    expect(isACPProtocolEventType("custom.event")).toBe(false);
    expect(isACPProtocolEventType("")).toBe(false);
    expect(isACPProtocolEventType("assistant")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyACPAxonEvent (standalone)
// ---------------------------------------------------------------------------

describe("classifyACPAxonEvent", () => {
  const makeAxonEvent = (overrides: Partial<Parameters<typeof makeFullAxonEvent>[0]> = {}) =>
    makeFullAxonEvent({
      event_type: "session/update",
      origin: "AGENT_EVENT",
      ...overrides,
    });

  it("classifies known protocol event with valid JSON", () => {
    const ev = makeAxonEvent({
      event_type: "session/update",
      payload: JSON.stringify({ sessionId: "s1", update: { sessionUpdate: "usage_update" } }),
    });
    const result = classifyACPAxonEvent(ev as never);
    expect(result.kind).toBe("acp_protocol");
    if (result.kind === "acp_protocol") {
      expect(result.eventType).toBe("session/update");
      expect((result.data as Record<string, unknown>).sessionId).toBe("s1");
    }
  });

  it("falls through to unknown for non-protocol non-system event", () => {
    const ev = makeAxonEvent({
      event_type: "custom.metric",
      origin: "EXTERNAL_EVENT",
    });
    const result = classifyACPAxonEvent(ev as never);
    expect(result.kind).toBe("unknown");
    expect(result.data).toEqual({});
  });

  it("classifies AGENT_EVENT with non-protocol event_type as unknown", () => {
    const ev = makeAxonEvent({
      event_type: "some.random.type",
      origin: "AGENT_EVENT",
    });
    const result = classifyACPAxonEvent(ev as never);
    expect(result.kind).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import * as SDK from "./index.js";

describe("root exports", () => {
  it("exports an acp namespace", () => {
    expect(SDK.acp).toBeDefined();
    expect(typeof SDK.acp).toBe("object");
  });

  it("exports a claude namespace", () => {
    expect(SDK.claude).toBeDefined();
    expect(typeof SDK.claude).toBe("object");
  });

  it("acp namespace contains ACPAxonConnection", () => {
    expect(SDK.acp.ACPAxonConnection).toBeDefined();
  });

  it("acp namespace contains type guard functions", () => {
    expect(typeof SDK.acp.isUserMessageChunk).toBe("function");
    expect(typeof SDK.acp.isToolCall).toBe("function");
  });

  it("claude namespace contains ClaudeAxonConnection", () => {
    expect(SDK.claude.ClaudeAxonConnection).toBeDefined();
  });

  it("claude namespace contains AxonTransport", () => {
    expect(SDK.claude.AxonTransport).toBeDefined();
  });

  it("exports a pi namespace", () => {
    expect(SDK.pi).toBeDefined();
    expect(typeof SDK.pi).toBe("object");
  });

  it("pi namespace contains PiAxonConnection and PiAxonTransport", () => {
    expect(SDK.pi.PiAxonConnection).toBeDefined();
    expect(SDK.pi.PiAxonTransport).toBeDefined();
  });

  it("pi namespace contains protocol constants and guards", () => {
    expect(SDK.pi.PI_TURN_START_EVENT_TYPE).toBe("turn/start");
    expect(typeof SDK.pi.isPiAgentSettledEvent).toBe("function");
  });

  it("exports a shared namespace", () => {
    expect(SDK.shared).toBeDefined();
    expect(typeof SDK.shared).toBe("object");
  });

  it("shared namespace contains ListenerSet", () => {
    expect(SDK.shared.ListenerSet).toBeDefined();
  });

  it("shared namespace contains InitializationError", () => {
    expect(SDK.shared.InitializationError).toBeDefined();
  });

  it("shared namespace contains SystemError", () => {
    expect(SDK.shared.SystemError).toBeDefined();
  });

  it("shared namespace contains ConnectionStateError", () => {
    expect(SDK.shared.ConnectionStateError).toBeDefined();
    expect(SDK.shared.isConnectionStateError).toBeDefined();
  });
});

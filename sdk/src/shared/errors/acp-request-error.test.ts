import { describe, expect, it } from "vitest";
import {
  ACPRequestError,
  isACPRequestError,
  isJsonRpcErrorShape,
  rethrowAsACPError,
  toACPError,
} from "./acp-request-error.js";

describe("ACPRequestError", () => {
  it("is an Error subclass with the expected fields", () => {
    const err = new ACPRequestError(-32603, "Internal error", { details: "boom" });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ACPRequestError);
    expect(err.name).toBe("ACPRequestError");
    expect(err.code).toBe(-32603);
    expect(err.data).toEqual({ details: "boom" });
  });

  it("formats the message with the JSON-RPC code and stringified data", () => {
    const err = new ACPRequestError(-32000, "Authentication required", { reason: "expired" });
    expect(err.message).toBe('[-32000] Authentication required {"reason":"expired"}');
  });

  it("omits the data suffix when data is undefined", () => {
    const err = new ACPRequestError(-32601, "Method not found", undefined);
    expect(err.message).toBe("[-32601] Method not found");
  });

  it("preserves the cause via ErrorOptions", () => {
    const cause = new Error("original");
    const err = new ACPRequestError(-32603, "Internal error", undefined, { cause });
    expect(err.cause).toBe(cause);
  });

  it("fromJsonRpc() builds an instance from the raw payload shape", () => {
    const err = ACPRequestError.fromJsonRpc({
      code: -32000,
      message: "You have exhausted your daily quota on this model.",
      data: { event_type: "turn.failed" },
    });

    expect(err.code).toBe(-32000);
    expect(err.data).toEqual({ event_type: "turn.failed" });
    expect(err.message).toBe(
      '[-32000] You have exhausted your daily quota on this model. {"event_type":"turn.failed"}',
    );
  });
});

describe("isACPRequestError", () => {
  it("returns true for ACPRequestError instances", () => {
    expect(isACPRequestError(new ACPRequestError(-32603, "Internal error", undefined))).toBe(true);
  });

  it("returns false for plain Errors and JSON-RPC-shaped objects", () => {
    expect(isACPRequestError(new Error("plain"))).toBe(false);
    expect(isACPRequestError({ code: -32603, message: "Internal error" })).toBe(false);
    expect(isACPRequestError(undefined)).toBe(false);
    expect(isACPRequestError("string")).toBe(false);
  });
});

describe("isJsonRpcErrorShape", () => {
  it("matches { code: number, message: string, data? }", () => {
    expect(isJsonRpcErrorShape({ code: -1, message: "m" })).toBe(true);
    expect(isJsonRpcErrorShape({ code: -1, message: "m", data: { extra: 1 } })).toBe(true);
  });

  it("rejects payloads missing required fields or with wrong types", () => {
    expect(isJsonRpcErrorShape({ code: "string", message: "m" })).toBe(false);
    expect(isJsonRpcErrorShape({ code: 1 })).toBe(false);
    expect(isJsonRpcErrorShape({ message: "m" })).toBe(false);
    expect(isJsonRpcErrorShape(null)).toBe(false);
    expect(isJsonRpcErrorShape(undefined)).toBe(false);
    expect(isJsonRpcErrorShape("string")).toBe(false);
  });
});

describe("toACPError", () => {
  it("returns Error instances unchanged", () => {
    const err = new Error("plain");
    expect(toACPError(err)).toBe(err);
  });

  it("returns ACPRequestError subclasses unchanged (still Error)", () => {
    const err = new ACPRequestError(-32603, "Internal error", undefined);
    expect(toACPError(err)).toBe(err);
  });

  it("converts JSON-RPC error shapes into ACPRequestError", () => {
    const out = toACPError({ code: -32000, message: "Auth required", data: { hint: "key" } });

    expect(out).toBeInstanceOf(ACPRequestError);
    expect((out as ACPRequestError).code).toBe(-32000);
    expect((out as ACPRequestError).data).toEqual({ hint: "key" });
    expect(out.message).toBe('[-32000] Auth required {"hint":"key"}');
  });

  it("wraps arbitrary non-Error values in a generic Error with a useful message", () => {
    expect(toACPError("oops").message).toBe('"oops"');
    expect(toACPError({ random: 1 }).message).toBe('{"random":1}');
    expect(toACPError(undefined).message).toBe("undefined");
  });
});

describe("rethrowAsACPError", () => {
  it("can be used as a .catch() handler that throws a normalized Error", async () => {
    const rejected = Promise.reject({
      code: -32000,
      message: "Authentication required",
    });

    await expect(rejected.catch(rethrowAsACPError)).rejects.toMatchObject({
      name: "ACPRequestError",
      code: -32000,
      message: "[-32000] Authentication required",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingRequestMap } from "./pending-request-map.js";

describe("PendingRequestMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a pending request and reports whether one matched", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.create("req-1", 1000, "timeout");
    expect(map.resolve("req-1", "value")).toBe(true);
    expect(map.resolve("req-1", "again")).toBe(false);
    await expect(promise).resolves.toBe("value");
  });

  it("rejects a pending request and reports whether one matched", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.create("req-1", 1000, "timeout");
    expect(map.reject("req-1", new Error("boom"))).toBe(true);
    expect(map.reject("req-1", new Error("boom"))).toBe(false);
    await expect(promise).rejects.toThrow("boom");
  });

  it("rejects with the timeout message when the timer fires", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.create("req-1", 50, "Request timeout: model/list");
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow("Request timeout: model/list");
    expect(map.resolve("req-1", "late")).toBe(false);
  });

  it("does not time out after the request settles", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.create("req-1", 50, "timeout");
    map.resolve("req-1", "value");
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBe("value");
  });

  it("rejectAll rejects every pending request and clears their timers", async () => {
    const map = new PendingRequestMap<string, string>();
    const a = map.create("a", 50, "timeout a");
    const b = map.create("b", 50, "timeout b");
    map.rejectAll(new Error("disconnected"));
    await expect(a).rejects.toThrow("disconnected");
    await expect(b).rejects.toThrow("disconnected");
    // Timers were cleared: advancing must not double-settle or throw.
    vi.advanceTimersByTime(100);
  });

  it("delete removes an entry without settling its promise", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.create("req-1", 50, "timeout");
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    map.delete("req-1");
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("throws on a duplicate id and leaves the original entry intact", async () => {
    const map = new PendingRequestMap<string, string>();
    const original = map.create("req-1", 1000, "timeout");
    expect(() => map.create("req-1", 1000, "timeout")).toThrow(
      "Duplicate pending request id: req-1",
    );
    expect(map.resolve("req-1", "value")).toBe(true);
    await expect(original).resolves.toBe("value");
  });
});

import { describe, expect, it, vi } from "vitest";
import { AsyncMessageQueue } from "./async-message-queue.js";

describe("AsyncMessageQueue", () => {
  it("delivers buffered values in FIFO order", async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push("a");
    queue.push("b");
    expect(await queue.next()).toBe("a");
    expect(await queue.next()).toBe("b");
  });

  it("resolves a pending waiter when a value arrives", async () => {
    const queue = new AsyncMessageQueue<string>();
    const pending = queue.next();
    queue.push("late");
    expect(await pending).toBe("late");
  });

  it("resolves pending waiters with null on close", async () => {
    const queue = new AsyncMessageQueue<string>();
    const pending = queue.next();
    queue.close();
    expect(await pending).toBeNull();
    expect(await queue.next()).toBeNull();
  });

  it("close(true) discards buffered values", async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push("dropped");
    queue.close(true);
    expect(await queue.next()).toBeNull();
  });

  it("close(false) keeps buffered values drainable before yielding null", async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push("a");
    queue.push("b");
    queue.close(false);
    expect(await queue.next()).toBe("a");
    expect(await queue.next()).toBe("b");
    expect(await queue.next()).toBeNull();
  });

  it("reopen() clears the closed state and retains undrained values", async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push("held");
    queue.close(false);
    queue.reopen();
    expect(await queue.next()).toBe("held");
    // Reopened: an empty queue waits instead of resolving null.
    const pending = queue.next();
    queue.push("fresh");
    expect(await pending).toBe("fresh");
  });

  it("fires the high-water callback once per session and again after reopen", () => {
    const onHighWater = vi.fn();
    const queue = new AsyncMessageQueue<number>(2, onHighWater);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(onHighWater).toHaveBeenCalledTimes(1);
    expect(onHighWater).toHaveBeenCalledWith(2);
    queue.close();
    queue.reopen();
    queue.push(1);
    queue.push(2);
    expect(onHighWater).toHaveBeenCalledTimes(2);
  });

  it("buffers values pushed after close(false) for a later drain", async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.close(false);
    queue.push("post-close");
    expect(await queue.next()).toBe("post-close");
    expect(await queue.next()).toBeNull();
  });

  describe("buffer: false", () => {
    it("discards values pushed while nobody is waiting", async () => {
      const queue = new AsyncMessageQueue<string>(1000, undefined, false);
      queue.push("dropped");
      const pending = queue.next();
      queue.push("live");
      expect(await pending).toBe("live");
    });

    it("never fires the high-water callback", () => {
      const onHighWater = vi.fn();
      const queue = new AsyncMessageQueue<number>(2, onHighWater, false);
      queue.push(1);
      queue.push(2);
      queue.push(3);
      expect(onHighWater).not.toHaveBeenCalled();
    });

    it("still resolves null once closed", async () => {
      const queue = new AsyncMessageQueue<string>(1000, undefined, false);
      queue.push("dropped");
      queue.close(false);
      expect(await queue.next()).toBeNull();
    });
  });
});

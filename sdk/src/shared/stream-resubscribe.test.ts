import { describe, expect, it, vi } from "vitest";
import {
  isTerminalSubscribeError,
  type ResubscribeAttemptOutcome,
  runStreamResubscribeLoop,
  type StreamResubscribeOptions,
} from "./stream-resubscribe.js";

type Step =
  | { kind: "events"; count: number; outcome?: ResubscribeAttemptOutcome }
  | { kind: "throw"; error: unknown };

/** Scripted attempt runner: one step per attempt; past the script, "stop". */
function scriptAttempts(steps: Step[]) {
  let call = 0;
  const runAttempt = vi.fn(async (reportActivity: () => void) => {
    const step = steps[call++];
    if (!step) return "stop" as const;
    if (step.kind === "throw") throw step.error;
    for (let i = 0; i < step.count; i++) reportActivity();
    return step.outcome ?? ("ended" as const);
  });
  return runAttempt;
}

function makeOptions(
  runAttempt: StreamResubscribeOptions["runAttempt"],
  overrides: Partial<StreamResubscribeOptions> = {},
): StreamResubscribeOptions {
  return {
    runAttempt,
    shouldStop: () => false,
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 1, // deterministic: delay = full exponential cap
    ...overrides,
  };
}

function statusError(status: number, message = `http ${status}`): Error {
  const error = new Error(message);
  Object.assign(error, { status });
  return error;
}

describe("runStreamResubscribeLoop", () => {
  it("resubscribes after a clean stream end", async () => {
    const runAttempt = scriptAttempts([
      { kind: "events", count: 2 },
      { kind: "events", count: 1, outcome: "stop" },
    ]);
    const onRetry = vi.fn();
    const result = await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ error: undefined, consecutiveFailures: 1 }),
    );
    expect(result).toEqual({ reason: "stopped" });
  });

  it("resubscribes after a transient error", async () => {
    const blip = new Error("connection lost");
    const runAttempt = scriptAttempts([
      { kind: "throw", error: blip },
      { kind: "events", count: 1, outcome: "stop" },
    ]);
    const onRetry = vi.fn();
    await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ error: blip, consecutiveFailures: 1 }),
    );
  });

  it("backs off exponentially with a cap across successive failures", async () => {
    const runAttempt = scriptAttempts([
      { kind: "throw", error: new Error("1") },
      { kind: "throw", error: new Error("2") },
      { kind: "throw", error: new Error("3") },
      { kind: "throw", error: new Error("4") },
      { kind: "events", count: 0, outcome: "stop" },
    ]);
    const onRetry = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runStreamResubscribeLoop(
      makeOptions(runAttempt, { onRetry, sleep, baseDelayMs: 100, maxDelayMs: 400 }),
    );
    expect(onRetry.mock.calls.map(([info]) => info.delayMs)).toEqual([100, 200, 400, 400]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 400]);
  });

  it("applies jitter within the half-to-full delay range", async () => {
    const runAttempt = scriptAttempts([
      { kind: "throw", error: new Error("boom") },
      { kind: "events", count: 0, outcome: "stop" },
    ]);
    const onRetry = vi.fn();
    await runStreamResubscribeLoop(
      makeOptions(runAttempt, { onRetry, baseDelayMs: 100, random: () => 0 }),
    );
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 50 }));
  });

  it("resets the failure counter after an attempt that received events", async () => {
    const runAttempt = scriptAttempts([
      { kind: "throw", error: new Error("1") },
      { kind: "throw", error: new Error("2") },
      { kind: "events", count: 3 }, // successful read, then a later close
      { kind: "throw", error: new Error("3") },
      { kind: "events", count: 0, outcome: "stop" },
    ]);
    const onRetry = vi.fn();
    await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
    // The clean end after a successful read restarts the count at 1; the
    // immediate failure that follows is consecutive failure 2.
    expect(onRetry.mock.calls.map(([info]) => info.consecutiveFailures)).toEqual([1, 2, 1, 2]);
  });

  it("resets the failure counter after a long-lived attempt with zero events", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const runAttempt = vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("1");
        if (call === 2) {
          // Idle stream evicted by the broker after a long, healthy hold.
          vi.advanceTimersByTime(60_000);
          return "ended" as const;
        }
        return "stop" as const;
      });
      const onRetry = vi.fn();
      await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
      expect(onRetry.mock.calls.map(([info]) => info.consecutiveFailures)).toEqual([1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops without retrying on a terminal error and surfaces it", async () => {
    const gone = statusError(404, "axon not found");
    const runAttempt = scriptAttempts([{ kind: "throw", error: gone }]);
    const onRetry = vi.fn();
    const result = await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
    expect(result).toEqual({ reason: "terminal", error: gone });
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("wraps a non-Error terminal value in an Error", async () => {
    const runAttempt = scriptAttempts([{ kind: "throw", error: { status: 401 } }]);
    const result = await runStreamResubscribeLoop(makeOptions(runAttempt));
    expect(result.reason).toBe("terminal");
    if (result.reason === "terminal") expect(result.error).toBeInstanceOf(Error);
  });

  it("honors a custom terminal-error classifier", async () => {
    const poison = new Error("poison");
    const runAttempt = scriptAttempts([{ kind: "throw", error: poison }]);
    const result = await runStreamResubscribeLoop(
      makeOptions(runAttempt, { isTerminalError: (error) => error === poison }),
    );
    expect(result).toEqual({ reason: "terminal", error: poison });
  });

  it("stops when shouldStop becomes true, even after an error", async () => {
    let stop = false;
    const runAttempt = vi.fn(async () => {
      stop = true;
      throw new Error("aborted mid-read");
    });
    const result = await runStreamResubscribeLoop(
      makeOptions(runAttempt, { shouldStop: () => stop }),
    );
    expect(result).toEqual({ reason: "stopped" });
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not run any attempt when already stopped", async () => {
    const runAttempt = vi.fn();
    const result = await runStreamResubscribeLoop(
      makeOptions(runAttempt as never, { shouldStop: () => true }),
    );
    expect(result).toEqual({ reason: "stopped" });
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("stops immediately when an attempt reports it finalized the connection", async () => {
    const runAttempt = scriptAttempts([{ kind: "events", count: 1, outcome: "stop" }]);
    const onRetry = vi.fn();
    const result = await runStreamResubscribeLoop(makeOptions(runAttempt, { onRetry }));
    expect(result).toEqual({ reason: "stopped" });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("passes the abort signal to sleep so backoff can be cancelled", async () => {
    const controller = new AbortController();
    const runAttempt = scriptAttempts([
      { kind: "events", count: 0 },
      { kind: "events", count: 0, outcome: "stop" },
    ]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runStreamResubscribeLoop(makeOptions(runAttempt, { sleep, signal: controller.signal }));
    expect(sleep).toHaveBeenCalledWith(expect.any(Number), controller.signal);
  });

  it("default sleep resolves early when the signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let stopped = false;
      const runAttempt = scriptAttempts([{ kind: "events", count: 0 }]);
      const done = runStreamResubscribeLoop({
        runAttempt,
        shouldStop: () => controller.signal.aborted,
        signal: controller.signal,
        random: () => 1,
      }).then((result) => {
        stopped = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      controller.abort();
      await expect(done).resolves.toEqual({ reason: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isTerminalSubscribeError", () => {
  it.each([[401], [403], [404]])("treats HTTP %s as terminal", (status) => {
    expect(isTerminalSubscribeError(statusError(status))).toBe(true);
  });

  it.each([[408], [429], [500], [502]])("treats HTTP %s as retryable", (status) => {
    expect(isTerminalSubscribeError(statusError(status))).toBe(false);
  });

  it("treats plain errors and non-objects as retryable", () => {
    expect(isTerminalSubscribeError(new Error("network down"))).toBe(false);
    expect(isTerminalSubscribeError("boom")).toBe(false);
    expect(isTerminalSubscribeError(undefined)).toBe(false);
  });
});

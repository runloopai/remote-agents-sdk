import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionReadLoopOptions,
  type ReconnectableMessageTransport,
  runConnectionReadLoop,
} from "./connection-read-loop.js";
import { SystemError } from "./errors/system-error.js";
import type { ResubscribeTuning } from "./stream-resubscribe.js";

type Batch = string[] | Error;

/**
 * A transport whose readMessages() yields one scripted batch per call.
 * A string[] batch yields its messages then ends; an Error batch throws.
 * When the script is exhausted, `exhausted` flips so tests can stop the loop.
 */
function createScriptedTransport(batches: Batch[]) {
  let call = 0;
  const state = { exhausted: batches.length === 0 };
  const transport: ReconnectableMessageTransport<string> & {
    reconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } = {
    async *readMessages() {
      const batch = batches[call++];
      const last = call >= batches.length;
      if (batch === undefined) {
        state.exhausted = true;
        return;
      }
      if (batch instanceof Error) {
        if (last) state.exhausted = true;
        throw batch;
      }
      yield* batch;
      if (last) state.exhausted = true;
    },
    reconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { transport, state };
}

function makeOptions(
  transport: ReconnectableMessageTransport<string>,
  overrides: Partial<
    Pick<
      ConnectionReadLoopOptions<string>,
      "isClosed" | "isReconnectSuppressed" | "isStreamAborted" | "isCurrent"
    >
  > = {},
) {
  return {
    transport,
    route: vi.fn<(message: string) => void>(),
    isClosed: () => false,
    isReconnectSuppressed: () => false,
    isStreamAborted: () => false,
    isCurrent: () => true,
    onError: vi.fn(),
    onFatal: vi.fn(),
    onTerminalError: vi.fn(),
    onFinished: vi.fn(),
    log: vi.fn(),
    retry: {
      sleep: vi.fn().mockResolvedValue(undefined),
      random: () => 1,
    } satisfies ResubscribeTuning as ResubscribeTuning,
    ...overrides,
  };
}

function statusError(status: number, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { status });
  return error;
}

describe("runConnectionReadLoop", () => {
  it("routes messages and reconnects when the stream ends cleanly", async () => {
    const { transport, state } = createScriptedTransport([["a", "b"], ["c"]]);
    const options = makeOptions(transport, { isClosed: () => state.exhausted });
    await runConnectionReadLoop(options);
    expect(options.route.mock.calls.map(([m]) => m)).toEqual(["a", "b", "c"]);
    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(options.onTerminalError).not.toHaveBeenCalled();
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it("keeps reconnecting through many successive ends and transient errors", async () => {
    const { transport, state } = createScriptedTransport([
      ["a"],
      new Error("blip 1"),
      [],
      new Error("blip 2"),
      new Error("blip 3"),
      ["b"],
    ]);
    const options = makeOptions(transport, { isClosed: () => state.exhausted });
    await runConnectionReadLoop(options);
    expect(options.route.mock.calls.map(([m]) => m)).toEqual(["a", "b"]);
    expect(transport.reconnect).toHaveBeenCalledTimes(5);
    expect(options.onError).toHaveBeenCalledTimes(3);
    expect(options.onTerminalError).not.toHaveBeenCalled();
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it("backs off between failed attempts and resets after a successful read", async () => {
    const { transport, state } = createScriptedTransport([
      new Error("blip 1"),
      new Error("blip 2"),
      ["recovered"],
      new Error("blip 3"),
    ]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const options = makeOptions(transport, { isClosed: () => state.exhausted });
    options.retry = { sleep, random: () => 1, baseDelayMs: 100, maxDelayMs: 30_000 };
    await runConnectionReadLoop(options);
    // Failures 1 and 2 double the delay; the successful read resets the
    // counter, so the post-recovery close starts over at the base delay.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 100]);
  });

  it("surfaces an unretryable subscribe error via onTerminalError without reconnecting again", async () => {
    const gone = statusError(404, "axon not found");
    const { transport } = createScriptedTransport([new Error("blip")]);
    transport.reconnect.mockRejectedValue(gone);
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(options.onTerminalError).toHaveBeenCalledWith(gone);
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it("treats HTTP 401/403/404 from the stream itself as terminal", async () => {
    const denied = statusError(403, "forbidden");
    const { transport } = createScriptedTransport([denied]);
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(transport.reconnect).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith(denied);
    expect(options.onTerminalError).toHaveBeenCalledWith(denied);
  });

  it("treats a SystemError as fatal: closes the transport and never reconnects", async () => {
    const fatal = new SystemError("broker crashed");
    const { transport } = createScriptedTransport([fatal]);
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(options.onFatal).toHaveBeenCalledWith(fatal);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.reconnect).not.toHaveBeenCalled();
    expect(options.onTerminalError).not.toHaveBeenCalled();
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["closed", { isClosed: () => true }],
    ["suppressed", { isReconnectSuppressed: () => true }],
    ["aborted", { isStreamAborted: () => true }],
    ["stale", { isCurrent: () => false }],
  ])("does not reconnect when the connection is %s", async (_label, overrides) => {
    const { transport } = createScriptedTransport([[]]);
    const options = makeOptions(transport, overrides);
    await runConnectionReadLoop(options);
    expect(transport.reconnect).not.toHaveBeenCalled();
  });

  it("skips onFinished for stale or suppressed loops so they cannot clobber a newer connection", async () => {
    for (const overrides of [
      { isCurrent: () => false },
      { isReconnectSuppressed: () => true },
    ] as const) {
      const { transport } = createScriptedTransport([[]]);
      const options = makeOptions(transport, overrides);
      await runConnectionReadLoop(options);
      expect(options.onFinished).not.toHaveBeenCalled();
    }
  });
});

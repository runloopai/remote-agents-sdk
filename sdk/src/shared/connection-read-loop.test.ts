import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionReadLoopOptions,
  type ReconnectableMessageTransport,
  runConnectionReadLoop,
} from "./connection-read-loop.js";
import { SystemError } from "./errors/system-error.js";

type Batch = string[] | Error;

/**
 * A transport whose readMessages() yields one scripted batch per call.
 * A string[] batch yields its messages then ends; an Error batch throws.
 */
function createScriptedTransport(batches: Batch[]) {
  let call = 0;
  const transport: ReconnectableMessageTransport<string> & {
    reconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } = {
    async *readMessages() {
      const batch = batches[call++] ?? [];
      if (batch instanceof Error) throw batch;
      yield* batch;
    },
    reconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return transport;
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
    ...overrides,
  };
}

describe("runConnectionReadLoop", () => {
  it("routes messages, reconnects once when the stream ends, and finishes", async () => {
    const transport = createScriptedTransport([["a", "b"], ["c"]]);
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(options.route.mock.calls.map(([m]) => m)).toEqual(["a", "b", "c"]);
    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(options.onTerminalError).not.toHaveBeenCalled();
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it("reports the last error via onTerminalError when the reconnected stream also fails", async () => {
    const transport = createScriptedTransport([new Error("blip 1"), new Error("blip 2")]);
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(options.onError).toHaveBeenCalledTimes(2);
    expect(options.onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "blip 2" }),
    );
    expect(options.onFinished).toHaveBeenCalledTimes(1);
  });

  it("reports a failed reconnect attempt as the terminal error", async () => {
    const transport = createScriptedTransport([new Error("blip")]);
    transport.reconnect.mockRejectedValue(new Error("resubscribe refused"));
    const options = makeOptions(transport);
    await runConnectionReadLoop(options);
    expect(options.onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "resubscribe refused" }),
    );
  });

  it("treats a SystemError as fatal: closes the transport and never reconnects", async () => {
    const fatal = new SystemError("broker crashed");
    const transport = createScriptedTransport([fatal]);
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
    const transport = createScriptedTransport([[]]);
    const options = makeOptions(transport, overrides);
    await runConnectionReadLoop(options);
    expect(transport.reconnect).not.toHaveBeenCalled();
  });

  it("skips onFinished for stale or suppressed loops so they cannot clobber a newer connection", async () => {
    for (const overrides of [
      { isCurrent: () => false },
      { isReconnectSuppressed: () => true },
    ] as const) {
      const transport = createScriptedTransport([[]]);
      const options = makeOptions(transport, overrides);
      await runConnectionReadLoop(options);
      expect(options.onFinished).not.toHaveBeenCalled();
    }
  });
});

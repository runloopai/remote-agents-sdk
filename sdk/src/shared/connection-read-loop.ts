import { SystemError } from "./errors/system-error.js";
import { type ResubscribeTuning, runStreamResubscribeLoop } from "./stream-resubscribe.js";
import type { LogFn } from "./types.js";

export interface ReconnectableMessageTransport<TMessage> {
  readMessages(): AsyncIterable<TMessage>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectionReadLoopOptions<TMessage> {
  transport: ReconnectableMessageTransport<TMessage>;
  route(message: TMessage): void;
  isClosed(): boolean;
  isReconnectSuppressed(): boolean;
  isStreamAborted(): boolean;
  isCurrent(): boolean;
  onError(error: unknown): void;
  onFatal(error: SystemError): void;
  onTerminalError(error: Error): void;
  onFinished(): void;
  log: LogFn;
  /** Backoff tuning overrides, injectable for tests. @internal */
  retry?: ResubscribeTuning;
}

/**
 * Runs a protocol-neutral message read loop that resubscribes indefinitely.
 *
 * The broker evicts idle axons (cleanly closing every subscriber stream), so
 * both clean stream ends and transient errors trigger a reconnect with
 * `after_sequence` set to the last seen sequence (handled by the transport),
 * with exponential backoff between consecutive failures (see
 * `runStreamResubscribeLoop`). Fatal broker errors permanently terminate the
 * connection; unretryable subscribe errors (HTTP 401/403/404) surface through
 * `onTerminalError`. Transient errors are reported through `onError` on every
 * occurrence.
 */
export async function runConnectionReadLoop<TMessage>(
  options: ConnectionReadLoopOptions<TMessage>,
): Promise<void> {
  const stopped = (): boolean =>
    options.isClosed() ||
    options.isReconnectSuppressed() ||
    options.isStreamAborted() ||
    !options.isCurrent();

  let first = true;
  const result = await runStreamResubscribeLoop({
    ...options.retry,
    shouldStop: stopped,
    log: options.log,
    runAttempt: async (reportActivity) => {
      try {
        if (!first) {
          options.log("readLoop", "reconnecting SSE stream...");
          await options.transport.reconnect();
        }
        first = false;
        for await (const message of options.transport.readMessages()) {
          if (options.isClosed()) return "ended";
          reportActivity();
          options.route(message);
        }
        return "ended";
      } catch (error) {
        options.log("readLoop", `error: ${error}`);
        options.onError(error);
        if (error instanceof SystemError) {
          options.onFatal(error);
          await options.transport.close().catch(() => undefined);
          return "stop";
        }
        throw error;
      }
    },
  });

  if (result.reason === "terminal") options.onTerminalError(result.error);
  if (options.isCurrent() && !options.isReconnectSuppressed()) options.onFinished();
}

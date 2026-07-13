import { SystemError } from "./errors/system-error.js";
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
}

/**
 * Runs a protocol-neutral message read loop with one SSE reconnect attempt.
 * Fatal broker errors permanently terminate the connection; transient errors
 * are reported immediately but reject pending work only after recovery fails.
 */
export async function runConnectionReadLoop<TMessage>(
  options: ConnectionReadLoopOptions<TMessage>,
): Promise<void> {
  let lastError: Error | undefined;
  const consume = async (): Promise<"ended" | "error" | "fatal"> => {
    try {
      for await (const message of options.transport.readMessages()) {
        if (options.isClosed()) return "ended";
        options.route(message);
      }
      return "ended";
    } catch (error) {
      options.log("readLoop", `error: ${error}`);
      options.onError(error);
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SystemError) {
        options.onFatal(error);
        await options.transport.close().catch(() => undefined);
        return "fatal";
      }
      return "error";
    }
  };

  let outcome = await consume();
  if (
    outcome !== "fatal" &&
    !options.isClosed() &&
    !options.isReconnectSuppressed() &&
    !options.isStreamAborted() &&
    options.isCurrent()
  ) {
    try {
      options.log("readLoop", "SSE stream ended, reconnecting...");
      await options.transport.reconnect();
      outcome = await consume();
    } catch (error) {
      options.log("readLoop", `reconnect failed: ${error}`);
      options.onError(error);
      lastError = error instanceof Error ? error : new Error(String(error));
      outcome = "error";
    }
  }

  if (outcome === "error")
    options.onTerminalError(lastError ?? new Error("Agent event stream failed"));
  if (options.isCurrent() && !options.isReconnectSuppressed()) options.onFinished();
}

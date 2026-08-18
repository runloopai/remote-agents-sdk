/**
 * Shared SSE resubscribe engine used by every inbound Axon read loop.
 *
 * The broker evicts idle axons (which cleanly closes every subscriber
 * stream) and networks drop connections, so a subscriber must treat both a
 * clean stream end and a transient error as "resubscribe from the last seen
 * sequence" — indefinitely, until the consumer stops the connection or the
 * error can never succeed (auth failure, axon gone).
 */

import { isNonNullObject } from "./structural-guards.js";
import type { LogFn } from "./types.js";

/** Base delay before the first resubscribe attempt. @category Constants */
export const DEFAULT_BASE_DELAY_MS = 500;

/** Upper bound on the delay between resubscribe attempts. @category Constants */
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * An attempt counts as successful — resetting the consecutive-failure
 * counter — when it received at least one event **or** the stream stayed
 * open at least this long (an idle stream the broker eventually evicts is a
 * healthy connection, not a failure).
 *
 * @category Constants
 */
export const DEFAULT_SUCCESS_INTERVAL_MS = 30_000;

/** 4xx statuses that are transient rather than stable client errors. */
const RETRYABLE_CLIENT_HTTP_STATUSES = new Set([408, 429]);

/**
 * Returns `true` for errors that retrying the SSE subscription can never
 * fix: any HTTP 4xx status (auth failure, axon gone, invalid request)
 * except the explicitly transient 408 (request timeout) and 429 (rate
 * limit). 5xx, network errors, and everything else stay retryable. Matches
 * the `status` property carried by `@runloop/api-client` `APIError`
 * subclasses without a runtime dependency on the peer's class identities.
 *
 * @category Utilities
 */
export function isTerminalSubscribeError(error: unknown): boolean {
  if (!isNonNullObject(error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") return false;
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_HTTP_STATUSES.has(status);
}

/**
 * What a single subscribe-and-consume attempt reported back to the engine:
 * - `"ended"` — the stream ended cleanly; the engine resubscribes.
 * - `"stop"`  — the attempt already finalized the connection (e.g. a fatal
 *   broker error was surfaced to the consumer); the engine exits.
 *
 * Throwing from the attempt reports a transient or terminal error.
 *
 * @category Types
 */
export type ResubscribeAttemptOutcome = "ended" | "stop";

/**
 * Timing and randomness knobs, injectable for tests.
 *
 * @category Types
 */
export interface ResubscribeTuning {
  /** Base backoff delay in milliseconds. @defaultValue 500 */
  baseDelayMs?: number;
  /** Backoff delay cap in milliseconds. @defaultValue 30000 */
  maxDelayMs?: number;
  /**
   * Minimum attempt duration that counts as a successful read even with
   * zero events. @defaultValue 30000
   */
  successIntervalMs?: number;
  /** Sleep implementation; must resolve early when `signal` aborts. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  /** Uniform `[0, 1)` random source used for jitter. */
  random?(): number;
}

/** Details passed to {@link StreamResubscribeOptions.onRetry}. @category Types */
export interface ResubscribeRetryInfo {
  /** The error that ended the attempt, or `undefined` on a clean stream end. */
  error: unknown;
  /** Consecutive failed attempts, including this one (resets after success). */
  consecutiveFailures: number;
  /** Backoff delay before the next attempt, in milliseconds. */
  delayMs: number;
}

/** Options for {@link runStreamResubscribeLoop}. @category Types */
export interface StreamResubscribeOptions extends ResubscribeTuning {
  /**
   * Performs one subscribe-and-consume cycle. Call `reportActivity()` for
   * every event received so the engine can reset its failure counter.
   * Return `"ended"` on a clean stream end, `"stop"` when the attempt
   * already finalized the connection, or throw on error.
   */
  runAttempt(reportActivity: () => void): Promise<ResubscribeAttemptOutcome>;
  /** Checked between attempts; `true` stops the loop with `"stopped"`. */
  shouldStop(): boolean;
  /** Abort signal that cancels an in-progress backoff sleep. */
  signal?: AbortSignal;
  /**
   * Classifies an error as unretryable. Defaults to
   * {@link isTerminalSubscribeError}.
   */
  isTerminalError?(error: unknown): boolean;
  /** Called before every backoff-and-resubscribe transition. */
  onRetry?(info: ResubscribeRetryInfo): void;
  /** Diagnostic log callback. */
  log?: LogFn;
}

/**
 * How the loop finished:
 * - `"stopped"`  — the consumer stopped it (abort/close) or an attempt
 *   finalized the connection itself.
 * - `"terminal"` — an unretryable error; surface it to the consumer.
 *
 * @category Types
 */
export type StreamResubscribeResult = { reason: "stopped" } | { reason: "terminal"; error: Error };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs subscribe-and-consume attempts until stopped or terminally failed.
 *
 * Between attempts the engine sleeps with equal-jitter exponential backoff
 * (`baseDelayMs` doubling per consecutive failure up to `maxDelayMs`); the
 * failure counter resets after any successful attempt (see
 * {@link DEFAULT_SUCCESS_INTERVAL_MS} for what counts as success), so a
 * disconnect hours into a healthy stream resubscribes promptly.
 *
 * @category Utilities
 */
export async function runStreamResubscribeLoop(
  options: StreamResubscribeOptions,
): Promise<StreamResubscribeResult> {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const successIntervalMs = options.successIntervalMs ?? DEFAULT_SUCCESS_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isTerminalError = options.isTerminalError ?? isTerminalSubscribeError;

  let consecutiveFailures = 0;

  while (true) {
    if (options.shouldStop()) return { reason: "stopped" };

    let sawEvent = false;
    const startedAt = Date.now();
    let attemptError: unknown;
    let outcome: ResubscribeAttemptOutcome;
    try {
      outcome = await options.runAttempt(() => {
        sawEvent = true;
      });
    } catch (error) {
      if (options.shouldStop()) return { reason: "stopped" };
      if (isTerminalError(error)) {
        options.log?.("resubscribe", `terminal error, giving up: ${error}`);
        return { reason: "terminal", error: toError(error) };
      }
      attemptError = error;
      outcome = "ended";
    }

    if (outcome === "stop") return { reason: "stopped" };
    if (options.shouldStop()) return { reason: "stopped" };

    const successful = sawEvent || Date.now() - startedAt >= successIntervalMs;
    if (successful) consecutiveFailures = 0;
    consecutiveFailures++;

    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (consecutiveFailures - 1));
    const delayMs = Math.round(cap / 2 + random() * (cap / 2));
    options.onRetry?.({ error: attemptError, consecutiveFailures, delayMs });
    options.log?.(
      "resubscribe",
      `${attemptError ? `stream error: ${attemptError}` : "stream ended"}; ` +
        `resubscribing in ${delayMs}ms (consecutive failures: ${consecutiveFailures})`,
    );
    await sleep(delayMs, options.signal);
  }
}

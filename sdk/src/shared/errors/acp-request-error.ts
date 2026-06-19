import { isNonNullObject } from "../structural-guards.js";

/**
 * Error thrown when an ACP request fails with a JSON-RPC error response.
 *
 * The upstream `@agentclientprotocol/sdk` rejects pending requests with the
 * raw `error` object (`{ code, message, data }`) rather than an `Error`
 * instance, so they would otherwise stringify to `"[object Object]"`.
 * The ACP connection wrapper converts those rejections into this typed
 * error so callers can `instanceof`-check, read `.code` / `.data`, and
 * get a useful `.message` (which includes the JSON-RPC code).
 *
 * See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
 *
 * @category Errors
 */
export class ACPRequestError extends Error {
  /** JSON-RPC error code (e.g. `-32603` internal error, `-32000` auth required). */
  readonly code: number;
  /** JSON-RPC `data` field (implementation-defined). */
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown, options?: ErrorOptions) {
    const dataSuffix = data !== undefined ? ` ${safeStringify(data)}` : "";
    super(`[${code}] ${message}${dataSuffix}`, options);
    this.name = "ACPRequestError";
    this.code = code;
    this.data = data;
  }

  /**
   * Build an `ACPRequestError` from a raw JSON-RPC error object.
   *
   * @param value - A JSON-RPC error payload (`{ code, message, data? }`).
   * @param options - Optional `ErrorOptions` for cause chaining.
   */
  static fromJsonRpc(
    value: { code: number; message: string; data?: unknown },
    options?: ErrorOptions,
  ): ACPRequestError {
    return new ACPRequestError(value.code, value.message, value.data, options);
  }
}

/**
 * Returns `true` if `err` is an {@link ACPRequestError}.
 *
 * @category Errors
 */
export function isACPRequestError(err: unknown): err is ACPRequestError {
  return err instanceof ACPRequestError;
}

/**
 * Structural guard for raw JSON-RPC error payloads.
 *
 * Matches `{ code: number, message: string, data?: unknown }`.
 *
 * @internal
 */
export function isJsonRpcErrorShape(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  if (!isNonNullObject(value)) return false;
  return typeof value.code === "number" && typeof value.message === "string";
}

/**
 * Convert an arbitrary thrown value into a real `Error` instance.
 *
 * - Already-`Error` values pass through unchanged.
 * - Raw JSON-RPC error objects become `ACPRequestError`.
 * - Anything else is wrapped in a generic `Error` whose message is the
 *   value's stringified form (`JSON.stringify` if possible, else `String`).
 *
 * @internal
 */
export function toACPError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (isJsonRpcErrorShape(err)) return ACPRequestError.fromJsonRpc(err);
  return new Error(safeStringify(err));
}

/**
 * Helper for `.catch()` chains that rethrows after normalizing via
 * {@link toACPError}.
 *
 * @internal
 */
export function rethrowAsACPError(err: unknown): never {
  throw toACPError(err);
}

function safeStringify(value: unknown): string {
  try {
    // `JSON.stringify` returns the literal `undefined` for `undefined`,
    // symbols, and functions — fall back to `String(value)` in those cases
    // so the error message is never empty.
    const json = JSON.stringify(value);
    return json !== undefined ? json : String(value);
  } catch {
    return String(value);
  }
}

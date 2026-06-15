/**
 * Maximum size, in bytes, of an Axon publish payload accepted by the Runloop
 * Axon publish endpoint (`POST /v1/axons/{id}/publish`).
 *
 * This mirrors the server-side gRPC decode cap (4 MiB). Publishing a payload
 * larger than this is rejected by the server with HTTP 413; the SDK enforces
 * the same limit client-side so callers fail fast with a typed error before the
 * network round-trip.
 *
 * @category Errors
 */
export const MAX_AXON_PUBLISH_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Error thrown when an outbound Axon publish payload exceeds
 * {@link MAX_AXON_PUBLISH_PAYLOAD_BYTES}.
 *
 * Catch this to handle oversized messages (e.g. too many or too large inline
 * image attachments) before they are sent to the server.
 *
 * @category Errors
 */
export class PayloadTooLargeError extends Error {
  /** Size of the offending payload, in bytes. */
  readonly payloadBytes: number;

  /** The maximum allowed payload size, in bytes. */
  readonly maxBytes: number;

  constructor(
    payloadBytes: number,
    maxBytes: number = MAX_AXON_PUBLISH_PAYLOAD_BYTES,
  ) {
    super(
      `Axon publish payload is too large: ${payloadBytes} bytes exceeds the ${maxBytes} byte ` +
        "limit. Reduce the request size (e.g. fewer or smaller attachments).",
    );
    this.name = "PayloadTooLargeError";
    this.payloadBytes = payloadBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Type guard for {@link PayloadTooLargeError}.
 *
 * @param error - The value to check.
 * @returns `true` if `error` is a {@link PayloadTooLargeError}.
 * @category Errors
 */
export function isPayloadTooLargeError(
  error: unknown,
): error is PayloadTooLargeError {
  return error instanceof PayloadTooLargeError;
}

/**
 * Throws a {@link PayloadTooLargeError} if `payload` exceeds
 * {@link MAX_AXON_PUBLISH_PAYLOAD_BYTES} when encoded as UTF-8.
 *
 * @param payload - The serialized publish payload string.
 * @throws {PayloadTooLargeError} If the payload is too large.
 * @category Errors
 */
export function assertPayloadWithinLimit(payload: string): void {
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_AXON_PUBLISH_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(payloadBytes);
  }
}

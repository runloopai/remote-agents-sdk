import { describe, expect, it } from "vitest";
import {
  assertPayloadWithinLimit,
  isPayloadTooLargeError,
  MAX_AXON_PUBLISH_PAYLOAD_BYTES,
  PayloadTooLargeError,
} from "./payload-too-large-error.js";

describe("assertPayloadWithinLimit", () => {
  it("does not throw for a small payload", () => {
    expect(() => assertPayloadWithinLimit("hello")).not.toThrow();
  });

  it("does not throw for a payload exactly at the limit", () => {
    const payload = "a".repeat(MAX_AXON_PUBLISH_PAYLOAD_BYTES);
    expect(() => assertPayloadWithinLimit(payload)).not.toThrow();
  });

  it("throws PayloadTooLargeError when the payload exceeds the limit", () => {
    const payload = "a".repeat(MAX_AXON_PUBLISH_PAYLOAD_BYTES + 1);
    expect(() => assertPayloadWithinLimit(payload)).toThrow(PayloadTooLargeError);
  });

  it("counts UTF-8 byte length, not character length", () => {
    // Each "€" is 3 bytes in UTF-8. A string of (limit/3 + 1) chars exceeds the
    // byte limit even though its character length is well under it.
    const charCount = Math.floor(MAX_AXON_PUBLISH_PAYLOAD_BYTES / 3) + 1;
    const payload = "€".repeat(charCount);
    expect(payload.length).toBeLessThan(MAX_AXON_PUBLISH_PAYLOAD_BYTES);
    expect(() => assertPayloadWithinLimit(payload)).toThrow(PayloadTooLargeError);
  });

  it("reports the payload and max sizes on the thrown error", () => {
    const payload = "a".repeat(MAX_AXON_PUBLISH_PAYLOAD_BYTES + 10);
    try {
      assertPayloadWithinLimit(payload);
      expect.unreachable("expected assertPayloadWithinLimit to throw");
    } catch (err) {
      expect(isPayloadTooLargeError(err)).toBe(true);
      const typed = err as PayloadTooLargeError;
      expect(typed.payloadBytes).toBe(MAX_AXON_PUBLISH_PAYLOAD_BYTES + 10);
      expect(typed.maxBytes).toBe(MAX_AXON_PUBLISH_PAYLOAD_BYTES);
    }
  });
});

describe("isPayloadTooLargeError", () => {
  it("returns true for a PayloadTooLargeError", () => {
    expect(isPayloadTooLargeError(new PayloadTooLargeError(1, 0))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isPayloadTooLargeError(new Error("nope"))).toBe(false);
    expect(isPayloadTooLargeError(undefined)).toBe(false);
  });
});

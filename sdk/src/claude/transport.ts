/**
 * Transport layer — abstracts the communication channel to a remote Claude Code instance.
 *
 * The `AxonTransport` implementation uses Runloop Axon for bidirectional
 * communication: outbound messages are published via `axon.publish()`, and
 * inbound messages arrive via `axon.subscribeSse()`.
 *
 * This mirrors the Python SDK's `Transport` ABC but is tailored for Axon.
 */

import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import { AxonFrameTransport } from "../shared/axon-frame-transport.js";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import { getRequestId, isNonNullObject } from "../shared/structural-guards.js";
import type { WireData } from "./types.js";

// ---------------------------------------------------------------------------
// Claude-specific event type guards
// ---------------------------------------------------------------------------

/**
 * AxonEventView narrowed to `control_request` event type.
 * @category Transport
 */
export type ControlRequestEvent = AxonEventView & { event_type: "control_request" };

/**
 * AxonEventView narrowed to `control_response` event type.
 * @category Transport
 */
export type ControlResponseEvent = AxonEventView & { event_type: "control_response" };

/**
 * Type guard that narrows an event to `control_request`.
 *
 * This checks the event *type* only; pair with {@link isFromAgent} to confirm
 * direction (control requests originate from the agent).
 *
 * @param event - An AxonEventView to check.
 * @returns `true` if `event_type === "control_request"`.
 * @category Transport
 */
export function isControlRequest(event: AxonEventView): event is ControlRequestEvent {
  return event.event_type === "control_request";
}

/**
 * Type guard that narrows an event to `control_response`.
 *
 * This checks the event *type* only; pair with {@link isFromUser} to confirm
 * direction (control responses originate from the client).
 *
 * @param event - An AxonEventView to check.
 * @returns `true` if `event_type === "control_response"`.
 * @category Transport
 */
export function isControlResponse(event: AxonEventView): event is ControlResponseEvent {
  return event.event_type === "control_response";
}

/**
 * Maps SDK message types to Axon event_type values for publishing.
 * @category Transport
 */
export const MESSAGE_TYPE_TO_EVENT_TYPE: Record<string, string> = {
  user: "query",
  assistant: "assistant",
  result: "result",
  system: "system",
  control_request: "control_request",
  control_response: "control_response",
};

/**
 * Abstract transport interface matching the Python SDK's Transport ABC.
 * @category Transport
 */
export interface Transport {
  /** Opens the underlying connection (e.g. subscribes to the SSE stream). */
  connect(): Promise<void>;

  /**
   * Publishes a serialized JSON message to the remote agent.
   * @param data - The JSON string to send.
   */
  write(data: string): Promise<void>;

  /**
   * Returns an async iterable of parsed wire messages from the agent.
   * Only agent-origin messages are yielded; echoed user events are filtered.
   *
   * @throws If called before {@link connect}.
   */
  readMessages(): AsyncIterable<WireData>;

  /**
   * Permanently closes the transport. After calling, {@link isReady}
   * returns `false` and no further reads or writes are possible.
   */
  close(): Promise<void>;

  /**
   * Aborts the SSE stream without marking the transport as permanently
   * closed. The read loop will exit, but {@link write} may still work.
   */
  abortStream(): void;

  /**
   * Aborts the current SSE stream and re-subscribes. The transport
   * remains connected — only the read half is recycled.
   */
  reconnect(): Promise<void>;

  /**
   * Returns whether the transport is connected and not closed.
   * @returns `true` if the transport can send and receive messages.
   */
  isReady(): boolean;
}

/**
 * Options for creating an AxonTransport.
 * @category Transport
 */
export interface AxonTransportOptions {
  /** If true, emit verbose logs to stderr. */
  verbose?: boolean;
  /** Called for every Axon event (before origin filtering). */
  onAxonEvent?: (event: AxonEventView) => void;
  /**
   * Axon sequence number to resume from. When set, the initial SSE
   * subscription starts **after** this sequence — earlier events are skipped.
   * Omit to replay the full event history.
   */
  afterSequence?: number;
  /**
   * When set, events with `sequence <= replayTargetSequence` are considered
   * historical replay. During replay, `onAxonEvent` still fires (so timeline
   * listeners work) but `control_request` messages are buffered instead of
   * yielded. After replay ends, only unresolved control requests are yielded.
   */
  replayTargetSequence?: number;
  /**
   * The `source` attached to published events, or a resolver evaluated for
   * each event. Falls back to `"claude-sdk-client"` when omitted or undefined.
   */
  source?: string | (() => string | undefined);
}

const DEFAULT_SOURCE = "claude-sdk-client";

/**
 * Transport implementation that communicates with a remote Claude Code
 * instance running on a Runloop Devbox via an Axon event channel.
 *
 * Protocol-agnostic publish/SSE and replay machinery is provided by
 * `AxonFrameTransport`; this adapter supplies Claude frame semantics.
 *
 * @category Transport
 */
export class AxonTransport implements Transport {
  private readonly inner: AxonFrameTransport<WireData>;

  /** Creates a new Axon-backed Claude transport. */
  constructor(axon: Axon, options: AxonTransportOptions = {}) {
    const parseFrame = (payload: string): WireData | undefined => {
      try {
        const parsed: unknown = JSON.parse(payload);
        return isNonNullObject(parsed) ? (parsed as WireData) : undefined;
      } catch {
        return undefined;
      }
    };
    this.inner = new AxonFrameTransport(axon, {
      ...options,
      source: () => {
        const source = typeof options.source === "function" ? options.source() : options.source;
        return source ?? DEFAULT_SOURCE;
      },
      logPrefix: "axon-transport",
      parseFrame,
      resolveEventType: (frame) => {
        const type = typeof frame?.type === "string" ? frame.type : undefined;
        return MESSAGE_TYPE_TO_EVENT_TYPE[type ?? ""] ?? type ?? "query";
      },
      allowInvalidOutbound: true,
      isReplayRequest: (event) => isFromAgent(event) && isControlRequest(event),
      requestId: (frame) => getRequestId(frame),
      isReplayAnswer: (event) => isFromUser(event) && isControlResponse(event),
      answerId: (frame) => {
        const response = isNonNullObject(frame.response) ? frame.response : undefined;
        return getRequestId(response);
      },
      systemErrorsDuringReplay: false,
    });
  }

  /** Opens the Axon SSE subscription. */
  async connect(): Promise<void> {
    await this.inner.connect();
  }

  /** Publishes a serialized Claude wire message. */
  async write(data: string): Promise<void> {
    await this.inner.write(data);
  }

  /** Yields parsed agent-origin Claude wire messages. */
  async *readMessages(): AsyncGenerator<WireData> {
    yield* this.inner.readMessages();
  }

  /** Aborts the current SSE stream without permanently closing the transport. */
  abortStream(): void {
    this.inner.abortStream();
  }

  /** Re-subscribes after the last observed Axon sequence. */
  async reconnect(): Promise<void> {
    await this.inner.reconnect();
  }

  /** Permanently closes the transport. */
  async close(): Promise<void> {
    await this.inner.close();
  }

  /** Returns whether the transport is connected and writable. */
  isReady(): boolean {
    return this.inner.isReady();
  }
}

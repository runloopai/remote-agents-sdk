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
import type { Stream } from "@runloop/api-client/streaming";
import { isSystemError, SystemError } from "../shared/errors/system-error.js";
import { makeLogger } from "../shared/logging.js";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import { getRequestId, isNonNullObject } from "../shared/structural-guards.js";
import type { LogFn } from "../shared/types.js";
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
   * The `source` string attached to every published Axon event, or a
   * resolver invoked at publish time to obtain it. Use the resolver form to
   * change the `source` between messages without recreating the transport
   * (e.g. `() => this.currentSource`). When omitted, or when the resolver
   * returns `undefined`, the default is used.
   *
   * @defaultValue `"claude-sdk-client"`
   */
  source?: string | (() => string | undefined);
}

/** Default `source` used when publishing events from the Claude SDK transport. */
const DEFAULT_SOURCE = "claude-sdk-client";

/**
 * Yields all unresolved control requests from the replay buffer, then clears it.
 */
function* flushReplayBuffer(replayBuffer: Map<string, WireData>, log: LogFn): Generator<WireData> {
  if (replayBuffer.size === 0) return;
  log("read", `replay complete — yielding ${replayBuffer.size} unresolved control request(s)`);
  for (const [requestId, msg] of replayBuffer) {
    log("read", `yielding unresolved control_request ${requestId}`);
    yield msg;
  }
  replayBuffer.clear();
}

/**
 * Transport implementation that communicates with a remote Claude Code
 * instance running on a Runloop Devbox via an Axon event channel.
 *
 * @category Transport
 */
export class AxonTransport implements Transport {
  /** The Axon channel used for publishing and subscribing. */
  private axon: Axon;

  /** Optional callback fired for every raw Axon event (before origin filtering). */
  private onAxonEvent?: (event: AxonEventView) => void;

  /** The active SSE subscription, or `null` before connect / after abort. */
  private sseStream: Stream<AxonEventView> | null = null;

  /** Whether {@link connect} has been called successfully. */
  private connected = false;

  /** Whether {@link close} has been called. */
  private closed = false;

  /** Sequence number of the last received Axon event, used to resume on reconnect. */
  private lastSequence: number | undefined;

  /** When set, events up to this sequence are replayed without yielding to the read loop. */
  private replayTargetSequence: number | undefined;

  /** The `source` (or resolver) attached to every published Axon event. */
  private source: string | (() => string | undefined);

  private log: LogFn;

  /**
   * Creates a new Axon-backed transport.
   *
   * @param axon    - The Axon channel to communicate over.
   * @param options - Optional verbose flag and raw event callback.
   */
  constructor(axon: Axon, options?: AxonTransportOptions) {
    this.axon = axon;
    this.log = makeLogger("axon-transport", options?.verbose ?? false);
    this.onAxonEvent = options?.onAxonEvent;
    this.lastSequence = options?.afterSequence;
    this.replayTargetSequence = options?.replayTargetSequence;
    this.source = options?.source ?? DEFAULT_SOURCE;
  }

  /**
   * Resolves the `source` to attach to an outbound event, invoking the
   * resolver if one was provided and falling back to the default.
   */
  private resolveSource(): string {
    const value = typeof this.source === "function" ? this.source() : this.source;
    return value ?? DEFAULT_SOURCE;
  }

  /**
   * Subscribes to the Axon SSE stream, making the transport ready for
   * reading and writing.
   */
  async connect(): Promise<void> {
    this.log("connect", `axon=${this.axon.id}`);
    this.sseStream =
      this.lastSequence != null
        ? await this.axon.subscribeSse({ after_sequence: this.lastSequence })
        : await this.axon.subscribeSse();
    this.connected = true;
    this.log("connect", "SSE connected");
  }

  /**
   * Determines the Axon `event_type` for an outbound message by parsing
   * its JSON `type` field and mapping it via {@link MESSAGE_TYPE_TO_EVENT_TYPE}.
   * Falls back to `"query"` on parse failure or unknown types.
   *
   * @param data - The raw JSON string to inspect.
   * @returns The resolved `event_type` string.
   */
  private resolveEventType(data: string): string {
    try {
      const parsed: { type?: string } = JSON.parse(data);
      const msgType = parsed.type;
      return MESSAGE_TYPE_TO_EVENT_TYPE[msgType ?? ""] ?? msgType ?? "query";
    } catch {
      return "query";
    }
  }

  /**
   * Publishes a serialized JSON message to the Axon channel.
   *
   * @param data - The JSON string to send. Its `type` field is used to
   *   derive the Axon `event_type`.
   */
  async write(data: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Transport is not ready. Call connect() first or check isReady().");
    }
    const eventType = this.resolveEventType(data);
    this.log("write", `event_type=${eventType}`);
    await this.axon.publish({
      event_type: eventType,
      origin: "USER_EVENT",
      payload: data,
      source: this.resolveSource(),
    });
  }

  /**
   * Async generator that yields parsed JSON messages from the SSE stream.
   * Only `AGENT_EVENT` messages are yielded — `USER_EVENT`s (our own
   * publishes echoed back) are skipped.
   *
   * When `replayTargetSequence` is set, events up to that sequence are
   * replayed: `onAxonEvent` fires (timeline works) but `control_request`
   * messages are buffered. `control_response` events during replay mark
   * buffered requests as resolved. After replay, unresolved control
   * requests are yielded before live events.
   *
   * @yields Parsed {@link WireData} objects from the agent.
   * @throws If called before {@link connect}.
   */
  async *readMessages(): AsyncGenerator<WireData> {
    if (!this.sseStream) {
      throw new Error("Transport not connected. Call connect() first.");
    }

    const replaying = this.replayTargetSequence != null;
    const replayTarget = this.replayTargetSequence;
    // Buffer control_request messages during replay, keyed by request_id.
    const replayBuffer = new Map<string, WireData>();

    let eventCount = 0;
    for await (const event of this.sseStream) {
      if (this.closed) break;
      eventCount++;
      this.lastSequence = event.sequence;

      this.onAxonEvent?.(event);

      // --- Replay mode: suppress handler dispatch ---
      if (replaying && replayTarget != null && event.sequence <= replayTarget) {
        if (isFromAgent(event) && isControlRequest(event)) {
          // Buffer control requests; they may be resolved by a later control_response
          if (event.payload != null) {
            try {
              const parsed = JSON.parse(event.payload);
              if (isNonNullObject(parsed)) {
                const requestId = getRequestId(parsed);
                if (requestId) {
                  replayBuffer.set(requestId, parsed as WireData);
                  this.log("read", `#${eventCount} REPLAY buffered control_request ${requestId}`);
                }
              }
            } catch {
              this.log("read", `#${eventCount} REPLAY failed to parse control_request`);
            }
          }
        } else if (isFromUser(event) && isControlResponse(event)) {
          // Mark matching buffered request as resolved
          if (event.payload != null) {
            try {
              const parsed = JSON.parse(event.payload);
              const response = isNonNullObject(parsed) ? parsed.response : undefined;
              const requestId = getRequestId(response);
              if (requestId && replayBuffer.has(requestId)) {
                replayBuffer.delete(requestId);
                this.log("read", `#${eventCount} REPLAY resolved control_request ${requestId}`);
              }
            } catch (err) {
              this.log("read", `#${eventCount} REPLAY failed to parse control_response: ${err}`);
            }
          }
        } else {
          this.log("read", `#${eventCount} REPLAY skip ${event.origin} ${event.event_type}`);
        }

        // Flush unresolved requests as soon as we reach the replay target,
        // rather than waiting for the next live event (which may never arrive
        // if the replay target is the last event on the axon).
        if (event.sequence === replayTarget) {
          yield* flushReplayBuffer(replayBuffer, this.log);
        }
        continue;
      }

      // --- Transition out of replay: yield unresolved buffered requests ---
      // This handles the case where events arrived between getLastSequence()
      // and the SSE subscription, so the first live event has sequence > target.
      if (replaying && replayBuffer.size > 0) {
        yield* flushReplayBuffer(replayBuffer, this.log);
      } else if (replaying && replayTarget != null && event.sequence > replayTarget) {
        this.log("read", "replay complete — no unresolved control requests");
      }

      // --- Normal (live) processing ---

      if (isSystemError(event)) {
        this.log("read", `#${eventCount} SYSTEM_ERROR: ${event.payload}`);
        throw SystemError.fromEvent(event);
      }

      if (isFromAgent(event)) {
        this.log("read", `#${eventCount} ${event.event_type}`);
        if (event.payload == null) {
          this.log("read", `#${eventCount} skipping null/undefined payload`);
          continue;
        }
        try {
          const parsed = JSON.parse(event.payload);
          if (!isNonNullObject(parsed)) {
            this.log("read", `#${eventCount} skipping non-object payload`);
            continue;
          }
          yield parsed as WireData;
        } catch (err) {
          this.log(
            "read",
            `#${eventCount} failed to parse payload for ${event.event_type}: ${err}`,
          );
        }
      } else {
        this.log("read", `#${eventCount} SKIP ${event.origin} ${event.event_type}`);
      }
    }

    // If replay ended because the stream closed before reaching the target,
    // flush any remaining unresolved requests.
    if (replaying && replayBuffer.size > 0) {
      yield* flushReplayBuffer(replayBuffer, this.log);
    }

    this.log("read", `SSE ended after ${eventCount} events`);
  }

  /**
   * Aborts the SSE stream without marking the transport as permanently
   * closed. The read loop will exit, but {@link write} may still work.
   * Useful for reconnect scenarios.
   */
  abortStream(): void {
    if (this.sseStream) {
      this.log("abortStream", "aborting SSE stream");
      this.sseStream.controller.abort();
      this.sseStream = null;
    }
  }

  /**
   * Aborts the current SSE stream and re-subscribes without marking the
   * transport as closed. The read loop exits, but a new `readMessages()`
   * call will yield events from the fresh subscription.
   */
  async reconnect(): Promise<void> {
    if (this.closed) return;
    this.log("reconnect", "aborting old stream and re-subscribing");
    this.abortStream();
    this.sseStream = await this.axon.subscribeSse(
      this.lastSequence != null ? { after_sequence: this.lastSequence } : undefined,
    );
    this.log("reconnect", "SSE reconnected");
  }

  /**
   * Permanently closes the transport by aborting the SSE stream and
   * marking the connection as closed. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.log("close", "closing transport");
    this.abortStream();
  }

  /**
   * Returns whether the transport is connected and not closed.
   *
   * @returns `true` if the transport can send and receive messages.
   */
  isReady(): boolean {
    return this.connected && !this.closed;
  }
}

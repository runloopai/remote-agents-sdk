import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import { isSystemError, SystemError } from "../shared/errors/system-error.js";
import { makeDefaultOnError } from "../shared/logging.js";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import { getJsonRpcId, isNonNullObject } from "../shared/structural-guards.js";
import { isTurnFailedAxonEvent, tryParseSystemEvent } from "../shared/timeline.js";
import type { LogFn } from "../shared/types.js";
import type { AxonStreamOptions } from "./types.js";

const INITIAL_RECONNECT_BACKOFF_MS = 1_000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;

function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Set of event_types that are notifications (no request ID correlation).
 * `session/update` is the main one -- the broker sends streaming chunks,
 * tool calls, plan updates, etc. as session/update notifications.
 * `session/elicitation/complete` signals elicitation finished (no response expected).
 */
const NOTIFICATION_TYPES = new Set<string>([
  CLIENT_METHODS.session_update,
  CLIENT_METHODS.session_elicitation_complete,
]);

/**
 * Creates an ACP-compatible `Stream` backed by an Axon channel from
 * `@runloop/api-client`.
 *
 * The Axon wire format uses `event_type` as the method name and `payload`
 * as the params-level JSON. The ACP SDK's `ClientSideConnection` speaks
 * JSON-RPC 2.0. This function bridges the two by:
 *
 * - **Outbound**: Unwrapping JSON-RPC requests/notifications into axon
 *   publish envelopes (`event_type` + `payload`).
 * - **Inbound**: Wrapping axon events back into JSON-RPC messages using
 *   a method -> request-ID correlation map.
 *
 * @param options - Axon channel, abort signal, and event/error callbacks.
 * @returns A `Stream` (readable + writable pair) consumable by `ClientSideConnection`.
 *
 * @category Connection
 */
export function axonStream(options: AxonStreamOptions): Stream {
  const { axon, signal, onAxonEvent, log, afterSequence, replayTargetSequence } = options;
  const onError = options.onError ?? makeDefaultOnError("axonStream");

  // Maps outbound JSON-RPC request method -> id so we can correlate
  // the broker's response (which only carries event_type, not an id).
  const pendingRequests = new Map<string, string | number | null>();

  // Maps outbound JSON-RPC response id -> the method of the agent-to-client
  // request we're responding to, so we can set the right event_type.
  const pendingClientRequests = new Map<string | number, string>();

  let nextAgentRequestId = 900_000;

  const readable = createReadable(
    axon,
    signal,
    pendingRequests,
    pendingClientRequests,
    onAxonEvent,
    () => nextAgentRequestId++,
    onError,
    log,
    afterSequence,
    replayTargetSequence,
  );

  const writable = createWritable(axon, pendingRequests, pendingClientRequests, onError, log);

  return { readable, writable };
}

// ---------------------------------------------------------------------------
// Readable: Axon SSE -> JSON-RPC AnyMessage
// ---------------------------------------------------------------------------

/**
 * Builds the readable half of the stream: subscribes to the Axon SSE feed
 * and converts each inbound event into a JSON-RPC `AnyMessage`.
 *
 * Events with `origin !== "AGENT_EVENT"` are skipped (they are our own
 * publishes echoed back). The stream closes when the SSE feed ends or
 * when the abort signal fires.
 *
 * When `replayTargetSequence` is set, events with `sequence <= replayTargetSequence`
 * are in replay mode: `onAxonEvent` still fires (timeline works) but
 * agent-to-client requests are buffered. `USER_EVENT` responses during
 * replay mark buffered requests as resolved. After replay, only unresolved
 * requests are enqueued.
 *
 * @param axon - Axon channel to subscribe to.
 * @param signal - Optional abort signal to cancel the subscription.
 * @param pendingRequests - Shared map tracking outbound request method -> JSON-RPC ID.
 * @param pendingClientRequests - Shared map tracking agent-to-client request ID -> method.
 * @param onAxonEvent - Optional callback fired for every raw Axon event.
 * @param nextId - Factory that produces the next synthetic JSON-RPC ID.
 * @param onError - Error sink for non-critical failures.
 * @param log - Optional diagnostic log callback.
 * @param initialAfterSequence - Axon sequence to resume from (SSE `after_sequence`).
 * @param replayTargetSequence - When set, events up to this sequence are replayed.
 */
function createReadable(
  axon: Axon,
  signal: AbortSignal | undefined,
  pendingRequests: Map<string, string | number | null>,
  pendingClientRequests: Map<string | number, string>,
  onAxonEvent: ((event: AxonEventView) => void) | undefined,
  nextId: () => number,
  onError: (error: unknown) => void,
  log: LogFn | undefined,
  initialAfterSequence?: number,
  replayTargetSequence?: number,
): ReadableStream<AnyMessage> {
  let cancelled = false;

  return new ReadableStream<AnyMessage>({
    async start(controller) {
      let totalEvents = 0;
      let attempt = 0;
      let backoffMs = INITIAL_RECONNECT_BACKOFF_MS;
      let lastSequence: number | undefined = initialAfterSequence;

      const replaying = replayTargetSequence != null;
      // Buffer agent-to-client requests seen during replay, keyed by event_type.
      // Each entry holds the JSON-RPC message. When a matching USER_EVENT
      // response is seen, the entry is deleted (resolved).
      const replayBuffer = new Map<string, AnyMessage>();

      while (!signal?.aborted && !cancelled) {
        attempt++;
        let eventCount = 0;
        try {
          log?.("read", `opening SSE stream (attempt ${attempt})`);
          const sseStream = await axon.subscribeSse(
            lastSequence != null ? { after_sequence: lastSequence } : undefined,
          );
          log?.("read", "SSE connected");
          for await (const axonEvent of sseStream) {
            if (signal?.aborted) break;
            eventCount++;
            totalEvents++;
            lastSequence = axonEvent.sequence;
            backoffMs = INITIAL_RECONNECT_BACKOFF_MS;

            onAxonEvent?.(axonEvent);

            // --- Replay mode: suppress handler dispatch ---
            if (replaying && axonEvent.sequence <= replayTargetSequence) {
              processReplayEvent(
                axonEvent,
                replayBuffer,
                pendingRequests,
                pendingClientRequests,
                nextId,
                onError,
                log,
                totalEvents,
              );
              if (axonEvent.sequence === replayTargetSequence) {
                flushReplayBuffer(replayBuffer, controller, log);
              }
              continue;
            }

            // --- Transition out of replay ---
            // This handles the case where events arrived between getLastSequence()
            // and the SSE subscription, so the first live event has sequence > target.
            if (replaying && replayBuffer.size > 0) {
              flushReplayBuffer(replayBuffer, controller, log);
            } else if (replaying) {
              log?.("read", "replay complete — no unresolved requests");
            }

            // --- Normal (live) processing ---

            // Reject in-flight requests on `turn.failed` SYSTEM_EVENTs but
            // keep the SSE loop alive — the agent process is still healthy
            // and can accept further sessions/prompts.
            if (isTurnFailedAxonEvent(axonEvent)) {
              const parsed = tryParseSystemEvent(axonEvent);
              const message =
                parsed?.type === "turn.failed"
                  ? parsed.error || "turn failed"
                  : String(axonEvent.payload ?? "turn failed");
              log?.("read", `#${totalEvents} TURN_FAILED: ${message}`);
              for (const [method, id] of pendingRequests) {
                if (id !== undefined && id !== null) {
                  controller.enqueue({
                    jsonrpc: "2.0",
                    id,
                    error: {
                      code: -32000,
                      message,
                      data: { event_type: axonEvent.event_type },
                    },
                  });
                }
                pendingRequests.delete(method);
              }
              continue;
            }

            if (isSystemError(axonEvent)) {
              log?.("read", `#${totalEvents} SYSTEM_ERROR: ${axonEvent.payload}`);
              if (pendingRequests.size === 0) {
                controller.error(SystemError.fromEvent(axonEvent));
                return;
              }
              for (const [method, id] of pendingRequests) {
                if (id !== undefined && id !== null) {
                  // FIXME: this is a temporary fix to tell the client that we couldn't process the pending request
                  // but this isn't quite right -- this message didn't originate from the agent, so this will cause
                  // asymmetry.
                  controller.enqueue({
                    jsonrpc: "2.0",
                    id,
                    error: {
                      code: -32000,
                      message: axonEvent.payload,
                      data: { event_type: axonEvent.event_type },
                    },
                  });
                }
                pendingRequests.delete(method);
              }
              controller.close();
              return;
            }

            if (!isFromAgent(axonEvent)) {
              log?.("read", `#${totalEvents} SKIP ${axonEvent.origin} ${axonEvent.event_type}`);
              continue;
            }

            log?.("read", `#${totalEvents} ${axonEvent.event_type}`);
            const msg = axonEventToJsonRpc(
              axonEvent,
              pendingRequests,
              pendingClientRequests,
              nextId,
              onError,
            );
            if (msg) controller.enqueue(msg);
          }
        } catch (err) {
          if (signal?.aborted || cancelled) break;
          if (!signal) {
            controller.error(err);
            return;
          }
          onError(
            `[axonStream] SSE stream error after ${eventCount} events, re-subscribing: ${err}`,
          );
          await delayWithAbort(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_BACKOFF_MS);
          continue;
        }

        if (signal?.aborted || cancelled) break;
        if (!signal) break;

        onError(`[axonStream] SSE stream ended after ${eventCount} events, re-subscribing`);
        await delayWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_BACKOFF_MS);
      }

      // If replay ended because the stream closed before reaching the target,
      // flush any remaining unresolved requests.
      if (replaying && replayBuffer.size > 0) {
        flushReplayBuffer(replayBuffer, controller, log);
      }

      pendingRequests.clear();
      pendingClientRequests.clear();
      log?.("read", `SSE ended after ${totalEvents} total events`);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

/**
 * Handles a single Axon event during replay mode. USER_EVENT responses
 * resolve buffered requests; AGENT_EVENT client-method requests are
 * buffered; everything else is skipped.
 */
function processReplayEvent(
  axonEvent: AxonEventView,
  replayBuffer: Map<string, AnyMessage>,
  pendingRequests: Map<string, string | number | null>,
  pendingClientRequests: Map<string | number, string>,
  nextId: () => number,
  onError: (error: unknown) => void,
  log: LogFn | undefined,
  eventIndex: number,
): void {
  if (isFromUser(axonEvent) && isClientMethod(axonEvent.event_type)) {
    replayBuffer.delete(axonEvent.event_type);
    log?.("read", `#${eventIndex} REPLAY resolved ${axonEvent.event_type}`);
    return;
  }

  if (isFromAgent(axonEvent)) {
    if (isClientMethod(axonEvent.event_type)) {
      const msg = axonEventToJsonRpc(
        axonEvent,
        pendingRequests,
        pendingClientRequests,
        nextId,
        onError,
      );
      if (msg) {
        replayBuffer.set(axonEvent.event_type, msg);
        log?.("read", `#${eventIndex} REPLAY buffered ${axonEvent.event_type}`);
      }
    } else {
      log?.("read", `#${eventIndex} REPLAY skip ${axonEvent.event_type}`);
    }
    return;
  }

  log?.("read", `#${eventIndex} REPLAY skip ${axonEvent.origin} ${axonEvent.event_type}`);
}

/**
 * Enqueues all unresolved requests from the replay buffer, then clears it.
 */
function flushReplayBuffer(
  replayBuffer: Map<string, AnyMessage>,
  controller: ReadableStreamDefaultController<AnyMessage>,
  log: LogFn | undefined,
): void {
  if (replayBuffer.size === 0) return;
  log?.("read", `replay complete — enqueuing ${replayBuffer.size} unresolved request(s)`);
  for (const [eventType, msg] of replayBuffer) {
    log?.("read", `enqueuing unresolved ${eventType}`);
    controller.enqueue(msg);
  }
  replayBuffer.clear();
}

/**
 * Converts a single inbound Axon event into a JSON-RPC message.
 *
 * Resolution order:
 * 1. If the payload is already a full JSON-RPC envelope, pass through.
 * 2. If `event_type` is a known notification (e.g. `session/update`),
 *    wrap as a JSON-RPC notification.
 * 3. If `event_type` matches a pending outbound request, wrap as a
 *    JSON-RPC response and consume the pending entry.
 * 4. If `event_type` is a known client method, wrap as an agent-to-client
 *    JSON-RPC request with a synthetic ID.
 * 5. Otherwise, treat as an unknown notification.
 *
 * @param event                - The raw Axon event from the SSE feed.
 * @param pendingRequests      - Shared map tracking outbound request method → JSON-RPC ID.
 * @param pendingClientRequests - Shared map tracking agent-to-client request ID → method.
 * @param nextId               - Factory that produces the next synthetic JSON-RPC ID.
 * @param onError              - Error sink for unparseable payloads.
 * @returns The translated JSON-RPC message, or `null` if the payload could not be parsed.
 */
function axonEventToJsonRpc(
  event: AxonEventView,
  pendingRequests: Map<string, string | number | null>,
  pendingClientRequests: Map<string | number, string>,
  nextId: () => number,
  onError: (error: unknown) => void,
): AnyMessage | null {
  const { event_type, payload } = event;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    onError(err);
    return null;
  }

  // If the payload is already a full JSON-RPC message, pass it through.
  // For responses (result/error), we still need to clear the pending request
  // entry so subsequent calls to the same method aren't rejected as duplicates.
  if (isJsonRpcMessage(parsed)) {
    if ("result" in parsed || "error" in parsed) {
      const parsedId = getJsonRpcId(parsed);
      for (const [method, id] of pendingRequests) {
        if (id === parsedId) {
          pendingRequests.delete(method);
          break;
        }
      }
    }
    return parsed;
  }

  // Notification: session/update -> JSON-RPC notification
  if (NOTIFICATION_TYPES.has(event_type)) {
    return {
      jsonrpc: "2.0",
      method: event_type,
      params: parsed,
    };
  }

  // Response to a pending client -> agent request
  const requestId = pendingRequests.get(event_type);
  if (requestId !== undefined) {
    pendingRequests.delete(event_type);
    return {
      jsonrpc: "2.0",
      id: requestId,
      result: parsed,
    };
  }

  // Agent-to-client request (e.g. session/request_permission, fs/read_text_file).
  if (isClientMethod(event_type)) {
    const id = nextId();
    pendingClientRequests.set(id, event_type);
    return {
      jsonrpc: "2.0",
      id,
      method: event_type,
      params: parsed,
    };
  }

  // Response to an agent method (e.g. initialize, session/new) from a previous
  // connection — this connection never sent the request so there is no callback
  // to resolve. The event already flowed through onAxonEvent / onTimelineEvent;
  // just keep it out of the JSON-RPC stream.
  if (isAgentMethod(event_type)) {
    return null;
  }

  // Unknown event_type with no pending request -- treat as notification.
  return {
    jsonrpc: "2.0",
    method: event_type,
    params: parsed,
  };
}

// ---------------------------------------------------------------------------
// Writable: JSON-RPC AnyMessage -> Axon Publish
// ---------------------------------------------------------------------------

/**
 * Builds the writable half of the stream: converts outbound JSON-RPC
 * messages into Axon publish calls.
 *
 * @param axon                 - Axon channel to publish to.
 * @param pendingRequests      - Shared map tracking outbound request method → JSON-RPC ID.
 * @param pendingClientRequests - Shared map tracking agent-to-client request ID → method.
 * @returns A `WritableStream` that accepts JSON-RPC messages.
 */
function createWritable(
  axon: Axon,
  pendingRequests: Map<string, string | number | null>,
  pendingClientRequests: Map<string | number, string>,
  onError: (error: unknown) => void,
  log: LogFn | undefined,
): WritableStream<AnyMessage> {
  return new WritableStream<AnyMessage>({
    async write(message) {
      const { eventType, payload } = jsonRpcToAxon(message, pendingRequests, pendingClientRequests);
      log?.("write", `event_type=${eventType}`);
      try {
        await axon.publish({
          event_type: eventType,
          origin: "USER_EVENT",
          payload,
          source: "acp-sdk-client",
        });
      } catch (err) {
        onError(err);
        throw err;
      }
    },
  });
}

/**
 * Converts an outbound JSON-RPC message into an Axon publish envelope.
 *
 * - **Requests** (`id` + `method`): records the method → ID mapping in
 *   `pendingRequests` for response correlation, then publishes with
 *   `event_type = method`.
 * - **Notifications** (`method`, no `id`): publishes directly with
 *   `event_type = method`.
 * - **Responses** (`id`, no `method`): looks up the originating method
 *   from `pendingClientRequests` and publishes with that `event_type`.
 *
 * @param message              - The JSON-RPC message to convert.
 * @param pendingRequests      - Shared map tracking outbound request method → JSON-RPC ID.
 * @param pendingClientRequests - Shared map tracking agent-to-client request ID → method.
 * @returns An `eventType` + serialized `payload` ready for `axon.publish()`.
 */
function jsonRpcToAxon(
  message: AnyMessage,
  pendingRequests: Map<string, string | number | null>,
  pendingClientRequests: Map<string | number, string>,
): { eventType: string; payload: string } {
  // Request: { jsonrpc, id, method, params }
  if ("method" in message && "id" in message && message.id != null) {
    if (pendingRequests.has(message.method)) {
      throw new Error(
        `[axonStream] Duplicate in-flight request for method "${message.method}". ` +
          "Only one outstanding request per method is supported; " +
          "await the first call before sending another.",
      );
    }
    pendingRequests.set(message.method, message.id);
    return {
      eventType: message.method,
      payload: JSON.stringify(message.params ?? {}),
    };
  }

  // Notification: { jsonrpc, method, params } (no id)
  if ("method" in message) {
    return {
      eventType: message.method,
      payload: JSON.stringify(message.params ?? {}),
    };
  }

  // Response to an agent-to-client request: { jsonrpc, id, result/error }
  if ("id" in message && message.id != null) {
    const method = pendingClientRequests.get(message.id);
    if (method) {
      pendingClientRequests.delete(message.id);
    }
    const resultPayload =
      "result" in message ? message.result : "error" in message ? message.error : {};
    return {
      eventType: method ?? "response",
      payload: JSON.stringify(resultPayload),
    };
  }

  return { eventType: "unknown", payload: JSON.stringify(message) };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Pre-computed set of all ACP client method names for O(1) lookup. */
const CLIENT_METHOD_SET: Set<string> = new Set(Object.values(CLIENT_METHODS));

/** Pre-computed set of all ACP agent method names for O(1) lookup. */
const AGENT_METHOD_SET: Set<string> = new Set(Object.values(AGENT_METHODS));

/**
 * Checks whether `eventType` is a known ACP client-side method
 * (i.e. a method the agent can call on the client).
 *
 * @param eventType - The Axon `event_type` string to test.
 * @returns `true` if the event type matches a known client method.
 */
function isClientMethod(eventType: string): boolean {
  return CLIENT_METHOD_SET.has(eventType);
}

/**
 * Checks whether `eventType` is a known ACP agent-side method
 * (i.e. a method the client calls on the agent, like `initialize`,
 * `session/new`, `session/prompt`).
 */
function isAgentMethod(eventType: string): boolean {
  return AGENT_METHOD_SET.has(eventType);
}

/**
 * Checks whether a parsed JSON value is a complete JSON-RPC 2.0 envelope
 * (has `jsonrpc: "2.0"`). Used to detect pre-wrapped payloads that should
 * be passed through without further translation.
 *
 * @param obj - The parsed payload to inspect.
 * @returns `true` if `obj` looks like a JSON-RPC 2.0 message.
 */
function isJsonRpcMessage(obj: unknown): obj is AnyMessage {
  if (!isNonNullObject(obj)) return false;
  return obj.jsonrpc === "2.0" && ("method" in obj || "result" in obj || "error" in obj);
}

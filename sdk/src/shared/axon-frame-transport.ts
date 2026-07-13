import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import type { Stream } from "@runloop/api-client/streaming";
import { isSystemError, SystemError } from "./errors/system-error.js";
import { makeLogger } from "./logging.js";
import { isFromAgent } from "./origin-guards.js";
import type { LogFn } from "./types.js";

export type FrameRequestId = string | number;

export interface AxonFrameTransportOptions<TFrame> {
  verbose?: boolean;
  onAxonEvent?: (event: AxonEventView) => void;
  afterSequence?: number;
  replayTargetSequence?: number;
  source: string;
  logPrefix: string;
  parseFrame(payload: string): TFrame | undefined;
  resolveEventType(frame: TFrame | undefined, raw: string): string;
  isReplayRequest(event: AxonEventView, frame: TFrame): boolean;
  requestId(frame: TFrame): FrameRequestId | undefined;
  isReplayAnswer(event: AxonEventView, frame: TFrame): boolean;
  answerId(frame: TFrame): FrameRequestId | undefined;
  validateOutbound?(frame: TFrame): void;
  allowInvalidOutbound?: boolean;
  systemErrorsDuringReplay?: boolean;
}

/**
 * Shared Axon publish/SSE machinery for whole-frame agent protocols.
 * Protocol adapters provide only parsing, event-type mapping, and replay
 * request/answer correlation.
 * @category Transport
 */
export class AxonFrameTransport<TFrame> {
  private stream: Stream<AxonEventView> | null = null;
  private connected = false;
  private closed = false;
  private lastSequence?: number;
  private readonly log: LogFn;

  constructor(
    private readonly axon: Axon,
    private readonly options: AxonFrameTransportOptions<TFrame>,
  ) {
    this.lastSequence = options.afterSequence;
    this.log = makeLogger(options.logPrefix, options.verbose ?? false);
  }

  async connect(): Promise<void> {
    this.stream =
      this.lastSequence == null
        ? await this.axon.subscribeSse()
        : await this.axon.subscribeSse({ after_sequence: this.lastSequence });
    this.connected = true;
  }

  async reconnect(): Promise<void> {
    if (this.closed) return;
    this.abortStream();
    this.stream = await this.axon.subscribeSse(
      this.lastSequence == null ? undefined : { after_sequence: this.lastSequence },
    );
  }

  async write(data: TFrame | string): Promise<void> {
    if (!this.isReady())
      throw new Error("Transport is not ready. Call connect() first or check isReady().");
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const frame = typeof data === "string" ? this.options.parseFrame(data) : data;
    if (frame === undefined && !this.options.allowInvalidOutbound)
      throw new Error("Cannot publish an invalid protocol frame");
    if (frame !== undefined) this.options.validateOutbound?.(frame);
    await this.axon.publish({
      event_type: this.options.resolveEventType(frame, raw),
      origin: "USER_EVENT",
      payload: raw,
      source: this.options.source,
    });
  }

  async *readMessages(): AsyncGenerator<TFrame> {
    if (!this.stream) throw new Error("Transport not connected. Call connect() first.");
    const target = this.options.replayTargetSequence;
    const replayBuffer = new Map<FrameRequestId, TFrame>();
    const flush = function* (): Generator<TFrame> {
      for (const frame of replayBuffer.values()) yield frame;
      replayBuffer.clear();
    };

    for await (const event of this.stream) {
      if (this.closed) break;
      this.lastSequence = event.sequence;
      this.options.onAxonEvent?.(event);
      if (this.options.systemErrorsDuringReplay !== false && isSystemError(event))
        throw SystemError.fromEvent(event);

      if (target != null && event.sequence <= target) {
        if (event.payload != null) {
          const frame = this.options.parseFrame(event.payload);
          if (frame !== undefined) {
            if (this.options.isReplayRequest(event, frame)) {
              const id = this.options.requestId(frame);
              if (id !== undefined) replayBuffer.set(id, frame);
            } else if (this.options.isReplayAnswer(event, frame)) {
              const id = this.options.answerId(frame);
              if (id !== undefined) replayBuffer.delete(id);
            }
          }
        }
        if (event.sequence === target) yield* flush();
        continue;
      }

      if (target != null && replayBuffer.size > 0) yield* flush();
      if (isSystemError(event)) throw SystemError.fromEvent(event);
      if (!isFromAgent(event) || event.payload == null) continue;
      const frame = this.options.parseFrame(event.payload);
      if (frame !== undefined) yield frame;
      else this.log("read", `invalid frame for ${event.event_type}`);
    }
    yield* flush();
  }

  abortStream(): void {
    this.stream?.controller.abort();
    this.stream = null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.abortStream();
  }

  isReady(): boolean {
    return this.connected && !this.closed;
  }
}

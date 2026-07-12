import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import type { Stream } from "@runloop/api-client/streaming";
import { isSystemError, SystemError } from "../shared/errors/system-error.js";
import { makeLogger } from "../shared/logging.js";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import type { LogFn } from "../shared/types.js";
import { CODEX_APPROVAL_REQUEST_METHOD_SET, RESPONSE_EVENT_TYPE } from "./protocol/index.js";

export type CodexFrame = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface CodexAxonTransportOptions {
  verbose?: boolean;
  onAxonEvent?: (event: AxonEventView) => void;
  afterSequence?: number;
  replayTargetSequence?: number;
}

export interface CodexTransport {
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  write(frame: CodexFrame | string): Promise<void>;
  readMessages(): AsyncIterable<CodexFrame>;
  close(): Promise<void>;
  abortStream(): void;
  isReady(): boolean;
}

export class CodexAxonTransport implements CodexTransport {
  private stream: Stream<AxonEventView> | null = null;
  private connected = false;
  private closed = false;
  private lastSequence?: number;
  private readonly log: LogFn;
  constructor(
    private readonly axon: Axon,
    private readonly options: CodexAxonTransportOptions = {},
  ) {
    this.lastSequence = options.afterSequence;
    this.log = makeLogger("codex-axon-transport", options.verbose ?? false);
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
  async write(frame: CodexFrame | string): Promise<void> {
    if (!this.isReady())
      throw new Error("Transport is not ready. Call connect() first or check isReady().");
    const raw = typeof frame === "string" ? frame : JSON.stringify(frame);
    const parsed = typeof frame === "string" ? (JSON.parse(frame) as CodexFrame) : frame;
    await this.axon.publish({
      event_type: parsed.method ?? RESPONSE_EVENT_TYPE,
      origin: "USER_EVENT",
      payload: raw,
      source: "codex-sdk-client",
    });
  }
  async *readMessages(): AsyncGenerator<CodexFrame> {
    if (!this.stream) throw new Error("Transport not connected. Call connect() first.");
    const target = this.options.replayTargetSequence;
    const buffered = new Map<string | number, CodexFrame>();
    const flush = function* (): Generator<CodexFrame> {
      for (const frame of buffered.values()) yield frame;
      buffered.clear();
    };
    for await (const event of this.stream) {
      if (this.closed) break;
      this.lastSequence = event.sequence;
      this.options.onAxonEvent?.(event);
      if (target != null && event.sequence <= target) {
        try {
          const frame = JSON.parse(event.payload ?? "null") as CodexFrame;
          if (
            isFromAgent(event) &&
            frame.method &&
            CODEX_APPROVAL_REQUEST_METHOD_SET.has(frame.method) &&
            frame.id != null
          )
            buffered.set(frame.id, frame);
          if (isFromUser(event) && event.event_type === RESPONSE_EVENT_TYPE && frame.id != null)
            buffered.delete(frame.id);
        } catch {
          /* malformed replay event */
        }
        if (event.sequence === target) yield* flush();
        continue;
      }
      if (target != null && buffered.size) yield* flush();
      if (isSystemError(event)) throw SystemError.fromEvent(event);
      if (!isFromAgent(event) || event.payload == null) continue;
      try {
        const frame: unknown = JSON.parse(event.payload);
        if (typeof frame === "object" && frame !== null) yield frame as CodexFrame;
      } catch (error) {
        this.log("read", "invalid JSON", error);
      }
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

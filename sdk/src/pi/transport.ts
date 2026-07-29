import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import { AxonFrameTransport } from "../shared/axon-frame-transport.js";
import {
  PI_CANCEL_EVENT_TYPE,
  PI_TURN_START_EVENT_TYPE,
  RESERVED_REQUEST_ID_PREFIX,
} from "./protocol/index.js";

/** A Pi JSONL frame in either direction: a command, an event, or an ack. */
export type PiFrame = {
  type?: string;
  id?: string;
  [key: string]: unknown;
};

export interface PiAxonTransportOptions {
  verbose?: boolean;
  onAxonEvent?: (event: AxonEventView) => void;
  afterSequence?: number;
  replayTargetSequence?: number;
}

export interface PiTransport {
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  write(frame: PiFrame | string): Promise<void>;
  readMessages(): AsyncIterable<PiFrame>;
  close(): Promise<void>;
  abortStream(): void;
  isReady(): boolean;
}

/**
 * Whole-frame Pi JSONL transport over Axon publish/SSE.
 *
 * The Pi broker adapter is a translating proxy: the published `event_type`
 * selects its behaviour, and the payload is the raw Pi command frame.
 * @category Transport
 */
export class PiAxonTransport implements PiTransport {
  private readonly inner: AxonFrameTransport<PiFrame>;
  constructor(axon: Axon, options: PiAxonTransportOptions = {}) {
    const parseFrame = (payload: string): PiFrame | undefined => {
      try {
        const frame: unknown = JSON.parse(payload);
        return typeof frame === "object" && frame !== null ? (frame as PiFrame) : undefined;
      } catch {
        return undefined;
      }
    };
    this.inner = new AxonFrameTransport(axon, {
      ...options,
      source: "pi-sdk-client",
      logPrefix: "pi-axon-transport",
      parseFrame,
      // The adapter's `classify_input` matches these two event types exactly:
      // `turn/start` opens a broker turn, `cancel` aborts it. Every other
      // frame is forwarded to Pi's stdin verbatim as a Control frame, which is
      // what `steer` and `follow_up` need so they do not reopen a turn.
      resolveEventType: (frame) =>
        frame?.type === "prompt"
          ? PI_TURN_START_EVENT_TYPE
          : frame?.type === "abort"
            ? PI_CANCEL_EVENT_TYPE
            : (frame?.type ?? "unknown"),
      validateOutbound: (frame) => {
        if (typeof frame.id === "string" && frame.id.startsWith(RESERVED_REQUEST_ID_PREFIX))
          throw new Error(`Request IDs beginning with ${RESERVED_REQUEST_ID_PREFIX} are reserved`);
      },
      systemErrorsDuringReplay: false,
      // Pi has no server-initiated requests, so the replay-request callbacks
      // are omitted and nothing is buffered across the replay window.
    });
  }
  async connect(): Promise<void> {
    await this.inner.connect();
  }
  async reconnect(): Promise<void> {
    await this.inner.reconnect();
  }
  async write(frame: PiFrame | string): Promise<void> {
    await this.inner.write(frame);
  }
  async *readMessages(): AsyncGenerator<PiFrame> {
    yield* this.inner.readMessages();
  }
  abortStream(): void {
    this.inner.abortStream();
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
  isReady(): boolean {
    return this.inner.isReady();
  }
}

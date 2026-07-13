import type { AxonEventView } from "@runloop/api-client/resources/axons";
import type { Axon } from "@runloop/api-client/sdk";
import { AxonFrameTransport } from "../shared/axon-frame-transport.js";
import { isFromAgent, isFromUser } from "../shared/origin-guards.js";
import { RESERVED_REQUEST_ID_PREFIX, RESPONSE_EVENT_TYPE } from "./protocol/index.js";

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

/**
 * Whole-frame JSON-RPC transport over Axon publish/SSE.
 * @category Transport
 */
export class CodexAxonTransport implements CodexTransport {
  private readonly inner: AxonFrameTransport<CodexFrame>;
  constructor(axon: Axon, options: CodexAxonTransportOptions = {}) {
    const parseFrame = (payload: string): CodexFrame | undefined => {
      try {
        const frame: unknown = JSON.parse(payload);
        return typeof frame === "object" && frame !== null ? (frame as CodexFrame) : undefined;
      } catch {
        return undefined;
      }
    };
    this.inner = new AxonFrameTransport(axon, {
      ...options,
      source: "codex-sdk-client",
      logPrefix: "codex-axon-transport",
      parseFrame,
      resolveEventType: (frame) => frame?.method ?? RESPONSE_EVENT_TYPE,
      isReplayRequest: (event, frame) => isFromAgent(event) && !!frame.method && frame.id != null,
      requestId: (frame) => frame.id,
      isReplayAnswer: (event) => isFromUser(event) && event.event_type === RESPONSE_EVENT_TYPE,
      answerId: (frame) => frame.id,
      validateOutbound: (frame) => {
        if (typeof frame.id === "string" && frame.id.startsWith(RESERVED_REQUEST_ID_PREFIX))
          throw new Error(`Request IDs beginning with ${RESERVED_REQUEST_ID_PREFIX} are reserved`);
      },
      systemErrorsDuringReplay: false,
    });
  }
  async connect(): Promise<void> {
    await this.inner.connect();
  }
  async reconnect(): Promise<void> {
    await this.inner.reconnect();
  }
  async write(frame: CodexFrame | string): Promise<void> {
    await this.inner.write(frame);
  }
  async *readMessages(): AsyncGenerator<CodexFrame> {
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

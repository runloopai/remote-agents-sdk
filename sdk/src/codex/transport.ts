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
  /**
   * The `source` string attached to every published Axon event, or a
   * resolver invoked at publish time to obtain it. Use the resolver form to
   * change the `source` between messages without recreating the transport
   * (e.g. `() => this.currentSource`). When omitted, or when the resolver
   * returns `undefined`, the default is used.
   *
   * @defaultValue `"codex-sdk-client"`
   */
  source?: string | (() => string | undefined);
}

/** Default `source` used when publishing events from the Codex SDK transport. */
const DEFAULT_SOURCE = "codex-sdk-client";

export interface CodexTransport {
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  write(frame: CodexFrame | string, options?: { signal?: AbortSignal }): Promise<void>;
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
      source: () => {
        const value = typeof options.source === "function" ? options.source() : options.source;
        return value ?? DEFAULT_SOURCE;
      },
      logPrefix: "codex-axon-transport",
      parseFrame,
      resolveEventType: (frame) => frame?.method ?? RESPONSE_EVENT_TYPE,
      isReplayRequest: (event, frame) => isFromAgent(event) && !!frame.method && frame.id != null,
      requestId: (frame) => frame.id,
      isReplayAnswer: (event) =>
        (isFromUser(event) && event.event_type === RESPONSE_EVENT_TYPE) ||
        (isFromAgent(event) && event.event_type === "serverRequest/resolved"),
      answerId: (frame) => {
        if (frame.id != null) return frame.id;
        if (frame.method !== "serverRequest/resolved") return undefined;
        const requestId = (frame.params as { requestId?: unknown } | undefined)?.requestId;
        return typeof requestId === "string" || typeof requestId === "number"
          ? requestId
          : undefined;
      },
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
  async write(frame: CodexFrame | string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.inner.write(frame, options);
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

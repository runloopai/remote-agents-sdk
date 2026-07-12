import type { AxonPublishParams, PublishResultView } from "@runloop/api-client/resources/axons";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { resolveReplayTarget } from "../shared/connect-guards.js";
import { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { SystemError } from "../shared/errors/system-error.js";
import { runDisconnectHook } from "../shared/lifecycle.js";
import { ListenerSet } from "../shared/listener-set.js";
import { makeDefaultOnError, makeLogger } from "../shared/logging.js";
import { timelineEventGenerator } from "../shared/timeline-generator.js";
import type {
  AxonEventListener,
  BaseConnectionOptions,
  TimelineEventListener,
} from "../shared/types.js";
import { classifyCodexAxonEvent } from "./classify-codex-axon-event.js";
import type { ServerRequest, ThreadStartParams, UserInput } from "./protocol/index.js";
import { CODEX_APPROVAL_REQUEST_METHOD_SET } from "./protocol/index.js";
import { CodexAxonTransport, type CodexFrame, type CodexTransport } from "./transport.js";
import type { CodexTimelineEvent } from "./types.js";

export type InputItem = UserInput;
export type ApprovalMethod = Extract<ServerRequest, { method: string }>["method"];
export type ApprovalHandler = (request: ServerRequest) => Promise<unknown> | unknown;
export interface CodexAxonConnectionOptions extends BaseConnectionOptions {
  threadStartParams?: ThreadStartParams;
  approvalHandlers?: Partial<Record<ApprovalMethod, ApprovalHandler>>;
  requestTimeoutMs?: number;
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Native Codex app-server connection over an Axon channel. */
export class CodexAxonConnection {
  readonly axonId: string;
  readonly devboxId: string;
  threadId: string | undefined;
  private transport?: CodexTransport;
  private running = false;
  private done = false;
  private closed = false;
  private fatal = false;
  private everConnected = false;
  private aborted = false;
  private counter = 0;
  private pending = new Map<string | number, Pending>();
  private queue: CodexFrame[] = [];
  private waiters: Array<(value: CodexFrame | null) => void> = [];
  private threadWaiters: Array<(id: string) => void> = [];
  private abortController = new AbortController();
  private readonly axonListeners: ListenerSet<AxonEventListener>;
  private readonly timelineListeners: ListenerSet<TimelineEventListener<CodexTimelineEvent>>;
  private readonly handlers = new Map<string, ApprovalHandler>();
  private readonly handleError: (error: unknown) => void;
  private readonly log;
  constructor(
    private readonly axon: Axon,
    devbox: Devbox,
    private readonly options: CodexAxonConnectionOptions = {},
  ) {
    this.axonId = axon.id;
    this.devboxId = devbox.id;
    this.handleError = options.onError ?? makeDefaultOnError("CodexAxonConnection");
    this.log = makeLogger("codex-sdk", options.verbose ?? false);
    this.axonListeners = new ListenerSet(this.handleError);
    this.timelineListeners = new ListenerSet(this.handleError);
    for (const [method, handler] of Object.entries(options.approvalHandlers ?? {}))
      if (handler) this.handlers.set(method, handler);
  }
  get isConnected(): boolean {
    return this.running && !this.closed;
  }
  get isDisconnected(): boolean {
    return this.everConnected && !this.running;
  }
  async connect(): Promise<void> {
    if (this.fatal)
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    if (this.running)
      throw new ConnectionStateError(
        "already_connected",
        "Already connected. Call disconnect() before reconnecting.",
      );
    this.closed = false;
    this.done = false;
    this.aborted = false;
    const replayTargetSequence = await resolveReplayTarget(this.axon, this.options, this.log);
    this.transport = new CodexAxonTransport(this.axon, {
      verbose: this.options.verbose,
      afterSequence: this.options.afterSequence,
      replayTargetSequence,
      onAxonEvent: (event) => {
        this.axonListeners.emit(event);
        this.timelineListeners.emit(classifyCodexAxonEvent(event));
      },
    });
    await this.transport.connect();
    this.running = true;
    this.everConnected = true;
    this.readLoop();
  }
  abortStream(): void {
    this.aborted = true;
    this.transport?.abortStream();
  }
  async disconnect(): Promise<void> {
    if (!this.transport && !this.running) return;
    this.closed = true;
    this.abortController.abort();
    this.failPending(new Error("Client disconnected"));
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
    await this.transport?.close();
    this.transport = undefined;
    this.running = false;
    await runDisconnectHook(this.options.onDisconnect, this.log, this.handleError);
    this.abortController = new AbortController();
    this.closed = false;
    this.done = false;
  }
  onAxonEvent(listener: AxonEventListener): () => void {
    return this.axonListeners.add(listener);
  }
  onTimelineEvent(listener: TimelineEventListener<CodexTimelineEvent>): () => void {
    return this.timelineListeners.add(listener);
  }
  async *receiveTimelineEvents(): AsyncGenerator<CodexTimelineEvent> {
    yield* timelineEventGenerator(
      (listener) => this.onTimelineEvent(listener),
      this.abortController.signal,
    );
  }
  private readLoop(): void {
    void (async () => {
      const transport = this.transport;
      if (!transport) return;
      const consume = async () => {
        for await (const frame of transport.readMessages()) {
          if (this.closed) break;
          this.route(frame);
        }
      };
      try {
        await consume();
        if (!this.closed && !this.aborted) {
          await transport.reconnect();
          await consume();
        }
      } catch (error) {
        this.handleError(error);
        if (error instanceof SystemError) {
          this.fatal = true;
          this.closed = true;
        }
        this.failPending(error instanceof Error ? error : new Error(String(error)));
      }
      this.running = false;
      this.done = true;
      this.abortController.abort();
      for (const waiter of this.waiters) waiter(null);
      this.waiters = [];
    })();
  }
  private route(frame: CodexFrame): void {
    if (frame.method === "thread/started") {
      const id = (frame.params as { thread?: { id?: unknown } } | undefined)?.thread?.id;
      if (typeof id === "string") {
        this.threadId = id;
        for (const waiter of this.threadWaiters.splice(0)) waiter(id);
      }
    }
    if (!frame.method && frame.id != null) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        frame.error
          ? pending.reject(new Error(JSON.stringify(frame.error)))
          : pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method && CODEX_APPROVAL_REQUEST_METHOD_SET.has(frame.method) && frame.id != null) {
      void this.handleApproval(frame as ServerRequest);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.queue.push(frame);
  }
  private async handleApproval(request: ServerRequest): Promise<void> {
    try {
      const result = await (this.handlers.get(request.method)?.(request) ?? { decision: "accept" });
      await this.transport?.write({ id: request.id, result });
    } catch (error) {
      await this.transport?.write({
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  private failPending(error: Error): void {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(error);
    }
    this.pending.clear();
  }
  async request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    if (!this.transport?.isReady())
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    const id = `codex-sdk-${++this.counter}-${Math.random().toString(36).slice(2, 10)}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.transport.write({ method, id, params });
    } catch (error) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return promise;
  }
  async startThread(
    params: ThreadStartParams = this.options.threadStartParams ?? {},
  ): Promise<string> {
    const existing = this.threadId;
    const notification = new Promise<string>((resolve) => this.threadWaiters.push(resolve));
    await this.request("thread/start", params);
    return this.threadId ?? existing ?? notification;
  }
  async send(prompt: string | InputItem[]): Promise<void> {
    const threadId = this.threadId ?? (await this.startThread());
    const input: InputItem[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
    await this.request("turn/start", { threadId, input });
  }
  async interrupt(): Promise<void> {
    await this.request("turn/interrupt", {});
  }
  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
    this.threadId = threadId;
  }
  async steer(prompt: string | InputItem[]): Promise<void> {
    const input =
      typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
    await this.request("turn/steer", { threadId: this.threadId, input });
  }
  onApprovalRequest(method: ApprovalMethod, handler: ApprovalHandler): () => void {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }
  nextMessage(): Promise<CodexFrame | null> {
    const value = this.queue.shift();
    if (value) return Promise.resolve(value);
    if (this.done || this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async *receiveAgentEvents(): AsyncGenerator<CodexFrame> {
    while (true) {
      const value = await this.nextMessage();
      if (!value) return;
      yield value;
    }
  }
  async *receiveTurn(): AsyncGenerator<CodexFrame> {
    for await (const frame of this.receiveAgentEvents()) {
      yield frame;
      if (frame.method === "turn/completed") return;
    }
  }
  async publish(params: AxonPublishParams): Promise<PublishResultView> {
    return this.axon.publish(params);
  }
}

import type { AxonPublishParams, PublishResultView } from "@runloop/api-client/resources/axons";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { AsyncMessageQueue } from "../shared/async-message-queue.js";
import { resolveReplayTarget } from "../shared/connect-guards.js";
import { runConnectionReadLoop } from "../shared/connection-read-loop.js";
import { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { runDisconnectHook } from "../shared/lifecycle.js";
import { ListenerSet } from "../shared/listener-set.js";
import { makeDefaultOnError, makeLogger } from "../shared/logging.js";
import { isFromAgent } from "../shared/origin-guards.js";
import { PendingRequestMap } from "../shared/pending-request-map.js";
import { timelineEventGenerator } from "../shared/timeline-generator.js";
import type {
  AxonEventListener,
  BaseConnectionOptions,
  TimelineEventListener,
} from "../shared/types.js";
import { VERSION } from "../version.js";
import { classifyCodexAxonEvent } from "./classify-codex-axon-event.js";
import type {
  CodexApprovalRequestMethod,
  InitializeParams,
  InitializeResponse,
  ServerRequest,
  ThreadStartParams,
  ThreadStartResponse,
  UserInput,
} from "./protocol/index.js";
import { CODEX_APPROVAL_REQUEST_METHOD_SET } from "./protocol/index.js";
import { CodexAxonTransport, type CodexFrame, type CodexTransport } from "./transport.js";
import type { CodexTimelineEvent } from "./types.js";

export type InputItem = UserInput;
export type ApprovalMethod = CodexApprovalRequestMethod;
export type ApprovalRequest = Extract<ServerRequest, { method: ApprovalMethod }>;
export type ApprovalHandler = (request: ApprovalRequest) => Promise<unknown> | unknown;
/** Options for a native Codex connection. @category Configuration */
export interface CodexAxonConnectionOptions extends BaseConnectionOptions {
  threadStartParams?: ThreadStartParams;
  approvalHandlers?: Partial<Record<ApprovalMethod, ApprovalHandler>>;
  requestTimeoutMs?: number;
  /**
   * Overrides merged into the `initialize` request sent by
   * {@link CodexAxonConnection.initialize | initialize()}. Defaults identify
   * this SDK as the client with no extra capabilities.
   */
  initializeParams?: Partial<InitializeParams>;
}
/**
 * Native Codex app-server connection over an Axon channel.
 *
 * Like Claude, Codex requires an `initialize` handshake before it accepts
 * requests: call {@link connect}, then {@link initialize}, then send a prompt
 * and consume {@link receiveTurn}; the first send creates a server-side
 * thread automatically.
 *
 * @example
 * ```ts
 * await connection.connect();
 * await connection.initialize();
 * await connection.send("Explain this repository");
 * for await (const event of connection.receiveTurn()) console.log(event);
 * ```
 * @category Connection
 */
export class CodexAxonConnection {
  readonly axonId: string;
  readonly devboxId: string;
  private _threadId: string | undefined;
  private transport?: CodexTransport;
  private running = false;
  private closed = false;
  private fatal = false;
  private everConnected = false;
  private aborted = false;
  private suppressAutoReconnect = false;
  private counter = 0;
  /** Whether the app-server `initialize` handshake has completed successfully. */
  private handshakeComplete = false;
  private _initializeResponse: InitializeResponse | undefined;
  private pending = new PendingRequestMap<string | number, unknown>();
  private messageQueue: AsyncMessageQueue<CodexFrame>;
  private threadWaiters = new Set<(id: string) => void>();
  private startThreadPromise: Promise<string> | undefined;
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
    this.messageQueue = new AsyncMessageQueue(1000, (size) =>
      this.handleError(
        `[CodexAxonConnection] Message queue has ${size} buffered messages. ` +
          "Ensure you are consuming messages via receiveAgentEvents() or receiveTurn().",
      ),
    );
    for (const [method, handler] of Object.entries(options.approvalHandlers ?? {}))
      if (handler) this.handlers.set(method, handler);
  }
  get isConnected(): boolean {
    return this.running && !this.closed;
  }
  get isDisconnected(): boolean {
    return this.everConnected && !this.running;
  }
  /** The active Codex thread id. Use {@link resumeThread} to change threads. */
  get threadId(): string | undefined {
    return this._threadId;
  }
  /** Whether the `initialize` handshake has completed. */
  get isInitialized(): boolean {
    return this.handshakeComplete;
  }
  /** The app-server's `initialize` response, once {@link initialize} has run. */
  get initializeResponse(): InitializeResponse | undefined {
    return this._initializeResponse;
  }
  /**
   * Opens the SSE transport and starts its read loop. Call {@link initialize}
   * next — the app-server rejects requests until the handshake completes.
   * @throws {@link ConnectionStateError} with `terminated` or `already_connected`.
   */
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
    this.aborted = false;
    this.suppressAutoReconnect = false;
    this.abortController = new AbortController();
    this.messageQueue.reopen();
    const replayTargetSequence = await resolveReplayTarget(this.axon, this.options, this.log);
    this.transport = new CodexAxonTransport(this.axon, {
      verbose: this.options.verbose,
      afterSequence: this.options.afterSequence,
      replayTargetSequence,
      onAxonEvent: (event) => {
        this.axonListeners.emit(event);
        this.timelineListeners.emit(classifyCodexAxonEvent(event));
        if (isFromAgent(event) && event.event_type === "thread/started" && event.payload != null) {
          try {
            this.captureThreadStarted(JSON.parse(event.payload) as CodexFrame);
          } catch {
            // Classification reports malformed events through the normal timeline surface.
          }
        }
      },
    });
    await this.transport.connect();
    this.running = true;
    this.everConnected = true;
    this.readLoop();
  }
  /**
   * Runs the **Codex app-server `initialize` handshake**: sends the
   * `initialize` request (client info + capabilities) and the `initialized`
   * notification. Required once after {@link connect} — the app-server
   * rejects all other requests with `-32600 "Not initialized"` until this
   * completes. If the server was already initialized (e.g. by a previous
   * session against the same process), that response is treated as success.
   *
   * Uses a longer timeout (120 s) because the app-server may still be starting.
   *
   * @param params Overrides merged over {@link CodexAxonConnectionOptions.initializeParams} and the SDK defaults.
   * @throws {@link ConnectionStateError} If the connection is not reusable after a fatal broker error (`code: "terminated"`).
   * @throws {@link ConnectionStateError} If {@link connect} has not been called yet (`code: "not_connected"`).
   * @throws {@link ConnectionStateError} If the handshake has already completed (`code: "already_initialized"`).
   */
  async initialize(params?: Partial<InitializeParams>): Promise<void> {
    if (this.fatal)
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    if (!this.transport?.isReady())
      throw new ConnectionStateError(
        "not_connected",
        "Not connected. Call connect() before initialize().",
      );
    if (this.handshakeComplete)
      throw new ConnectionStateError(
        "already_initialized",
        "Already initialized. Call disconnect() before reinitializing.",
      );
    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "runloop-remote-agents-sdk",
        title: null,
        version: VERSION,
        ...this.options.initializeParams?.clientInfo,
        ...params?.clientInfo,
      },
      capabilities:
        params?.capabilities !== undefined
          ? params.capabilities
          : (this.options.initializeParams?.capabilities ?? null),
    };
    this.log("init", "sending initialize request");
    try {
      this._initializeResponse = (await this.request(
        "initialize",
        initializeParams,
        120_000, // longer timeout for initialization
      )) as InitializeResponse;
    } catch (error) {
      // A live app-server that already completed the handshake (previous
      // session or broker-side init) rejects a second initialize; the
      // connection is still fully usable, so treat it as success.
      if (!/already\s+initiali[sz]ed/i.test(error instanceof Error ? error.message : ""))
        throw error;
      this.log("init", "app-server already initialized; continuing");
    }
    await this.transport.write({ method: "initialized" });
    this.handshakeComplete = true;
    this.log("init", "initialized");
  }
  /** Aborts only the current SSE stream, preserving listeners. */
  abortStream(): void {
    this.aborted = true;
    this.transport?.abortStream();
  }
  /** Gracefully closes the transport and rejects pending requests. Idempotent. */
  async disconnect(): Promise<void> {
    if (!this.transport && !this.running) return;
    this.suppressAutoReconnect = true;
    this.closed = true;
    this.abortController.abort();
    this.pending.rejectAll(new Error("Client disconnected"));
    this.messageQueue.close();
    await this.transport?.close();
    this.transport = undefined;
    this.running = false;
    this.handshakeComplete = false;
    await runDisconnectHook(this.options.onDisconnect, this.log, this.handleError);
    this.closed = false;
  }
  /** Registers a raw Axon event listener. */
  onAxonEvent(listener: AxonEventListener): () => void {
    return this.axonListeners.add(listener);
  }
  /** Registers a classified Codex timeline listener. */
  onTimelineEvent(listener: TimelineEventListener<CodexTimelineEvent>): () => void {
    return this.timelineListeners.add(listener);
  }
  /** Pull-based classified timeline event stream. */
  async *receiveTimelineEvents(): AsyncGenerator<CodexTimelineEvent> {
    yield* timelineEventGenerator(
      (listener) => this.onTimelineEvent(listener),
      this.abortController.signal,
    );
  }
  private readLoop(): void {
    const transport = this.transport;
    if (!transport) return;
    void runConnectionReadLoop({
      transport,
      route: (frame) => this.route(frame),
      isClosed: () => this.closed,
      isReconnectSuppressed: () => this.suppressAutoReconnect,
      isStreamAborted: () => this.aborted,
      isCurrent: () => transport === this.transport,
      onError: this.handleError,
      onFatal: (error) => {
        this.fatal = true;
        this.closed = true;
        this.pending.rejectAll(error);
      },
      onTerminalError: (error) => this.pending.rejectAll(error),
      onFinished: () => {
        this.running = false;
        this.abortController.abort();
        this.messageQueue.close(false);
      },
      log: this.log,
    });
  }

  private captureThreadStarted(frame: CodexFrame): void {
    if (frame.method !== "thread/started") return;
    const id = (frame.params as { thread?: { id?: unknown } } | undefined)?.thread?.id;
    if (typeof id === "string") {
      this._threadId = id;
      for (const waiter of this.threadWaiters) waiter(id);
      this.threadWaiters.clear();
    }
  }
  private route(frame: CodexFrame): void {
    this.captureThreadStarted(frame);
    if (!frame.method && frame.id != null) {
      frame.error
        ? this.pending.reject(frame.id, new Error(JSON.stringify(frame.error)))
        : this.pending.resolve(frame.id, frame.result);
      return;
    }
    if (frame.method && frame.id != null) {
      void this.handleServerRequest(frame as ServerRequest).catch(this.handleError);
      return;
    }
    this.messageQueue.push(frame);
  }
  private defaultApproval(request: ApprovalRequest): unknown {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "accept" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "approved" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "item/permissions/requestApproval": {
        const permissions = request.params.permissions;
        return {
          permissions: {
            ...(permissions.network ? { network: permissions.network } : {}),
            ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
          },
          scope: "turn",
        };
      }
    }
  }
  private defaultDecline(request: ApprovalRequest): unknown {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "denied" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
    }
  }
  private approvalWithTimeout(
    request: ApprovalRequest,
    handler: ApprovalHandler,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(this.defaultDecline(request)), timeoutMs);
      Promise.resolve(handler(request)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (this.fatal || !this.transport?.isReady()) return;
    try {
      if (!CODEX_APPROVAL_REQUEST_METHOD_SET.has(request.method)) {
        await this.transport.write({
          id: request.id,
          error: { code: -32601, message: `Unsupported server request: ${request.method}` },
        });
        return;
      }
      const approval = request as ApprovalRequest;
      const handler = this.handlers.get(approval.method);
      const timeoutMs = this.options.requestTimeoutMs ?? 60_000;
      const result = handler
        ? await this.approvalWithTimeout(approval, handler, timeoutMs)
        : this.defaultApproval(approval);
      await this.transport?.write({ id: request.id, result });
    } catch (error) {
      if (this.transport?.isReady()) {
        await this.transport.write({
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }
  /**
   * Sends an arbitrary app-server request and correlates its JSON-RPC response by id.
   * @throws {@link ConnectionStateError} with `terminated` or `not_connected`.
   */
  async request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    if (this.fatal)
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    if (!this.transport?.isReady())
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    const id = `codex-sdk-${++this.counter}-${Math.random().toString(36).slice(2, 10)}`;
    const promise = this.pending.create(id, timeoutMs, `Request timeout: ${method}`);
    try {
      await this.transport.write({ method, id, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }
  /** Starts and tracks a Codex thread, returning its server-assigned id. */
  async startThread(
    params: ThreadStartParams = this.options.threadStartParams ?? {},
  ): Promise<string> {
    if (this.startThreadPromise) return this.startThreadPromise;
    this.startThreadPromise = this.performStartThread(params);
    try {
      return await this.startThreadPromise;
    } finally {
      this.startThreadPromise = undefined;
    }
  }
  private async performStartThread(params: ThreadStartParams): Promise<string> {
    let waiter: ((id: string) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notification = new Promise<string>((resolve, reject) => {
      waiter = (id) => {
        if (timer) clearTimeout(timer);
        resolve(id);
      };
      this.threadWaiters.add(waiter);
      timer = setTimeout(
        () => reject(new Error("Thread start timeout: missing thread/started notification")),
        this.options.requestTimeoutMs ?? 60_000,
      );
    });
    try {
      const result = (await this.request("thread/start", params)) as
        | ThreadStartResponse
        | undefined;
      const responseId = result?.thread?.id;
      const id = typeof responseId === "string" ? responseId : await notification;
      this._threadId = id;
      return id;
    } finally {
      if (timer) clearTimeout(timer);
      if (waiter) this.threadWaiters.delete(waiter);
    }
  }
  /** Sends text or structured input, creating a thread on the first call. */
  async send(prompt: string | InputItem[]): Promise<void> {
    const threadId = this._threadId ?? (await this.startThread());
    const input: InputItem[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
    await this.request("turn/start", { threadId, input });
  }
  /** Interrupts the broker adapter's currently tracked turn. */
  async interrupt(): Promise<void> {
    await this.request("turn/interrupt", {});
  }
  /** Resumes a known server-side thread and makes it current. */
  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
    this._threadId = threadId;
  }
  /** Steers the current in-flight turn. */
  async steer(prompt: string | InputItem[]): Promise<void> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    const input =
      typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
    await this.request("turn/steer", { threadId: this._threadId, input });
  }
  /**
   * Registers an approval handler. Without one, command/file approvals are
   * accepted, legacy approvals are approved, user-input answers are empty,
   * and requested permissions are granted for the turn. Handler timeouts are
   * declined. Mounting with `approval_policy=never` avoids approval traffic.
   */
  onApprovalRequest(method: ApprovalMethod, handler: ApprovalHandler): () => void {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }
  private nextMessage(): Promise<CodexFrame | null> {
    if (this.closed) return Promise.resolve(null);
    return this.messageQueue.next();
  }
  /** Yields agent notifications until the connection closes. */
  async *receiveAgentEvents(): AsyncGenerator<CodexFrame> {
    while (true) {
      const value = await this.nextMessage();
      if (!value) return;
      yield value;
    }
  }
  /** Yields one turn and terminates after `turn/completed`. */
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

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
  CollaborationMode,
  ConfigReadParams,
  ConfigReadResponse,
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  InitializeParams,
  InitializeResponse,
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  ReviewDelivery,
  ReviewStartResponse,
  ReviewTarget,
  ServerRequest,
  SkillsListParams,
  SkillsListResponse,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadSetNameResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  UserInput,
} from "./protocol/index.js";
import { CODEX_APPROVAL_REQUEST_METHOD_SET } from "./protocol/index.js";
import { CodexAxonTransport, type CodexFrame, type CodexTransport } from "./transport.js";
import type { CodexTimelineEvent } from "./types.js";

export type InputItem = UserInput;
/**
 * Per-turn overrides for {@link CodexAxonConnection.send}: everything
 * `turn/start` accepts beyond the thread id and input (model, effort,
 * sandboxPolicy, approvalPolicy, …). `collaborationMode` is an experimental
 * app-server field absent from the generated {@link TurnStartParams}; using
 * it requires initializing with capabilities `{ experimentalApi: true }`.
 */
export type TurnOptions = Omit<TurnStartParams, "threadId" | "input"> & {
  collaborationMode?: CollaborationMode | null;
};
export type ApprovalMethod = CodexApprovalRequestMethod;
export type ApprovalRequest = Extract<ServerRequest, { method: ApprovalMethod }>;
/** Lifecycle context for an approval or elicitation request handler. */
export interface ApprovalHandlerContext {
  /** Aborted when Codex resolves the request elsewhere, the handler times out, or the connection closes. */
  signal: AbortSignal;
}
export type ApprovalHandler = (
  request: ApprovalRequest,
  context: ApprovalHandlerContext,
) => Promise<unknown> | unknown;
const SERVER_REQUEST_RESOLVED = Symbol("server-request-resolved");
interface ServerRequestLifecycle {
  /** Cancels any handler or outbound response when app-server clears the request. */
  signal: AbortSignal;
  /** True when app-server cleared the request. */
  resolvedElsewhere: () => boolean;
  /** Stop tracking the request after its final response has finished publishing. */
  release: () => void;
}
/**
 * JSON-RPC error returned by the Codex app-server for a client request.
 * Preserves the wire `code` and `data` alongside the message.
 * @category Errors
 */
export class CodexRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRequestError";
  }
}

function toRequestError(error: unknown): CodexRequestError {
  if (typeof error === "object" && error !== null) {
    const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
    return new CodexRequestError(
      typeof message === "string" ? message : JSON.stringify(error),
      typeof code === "number" ? code : undefined,
      data,
    );
  }
  return new CodexRequestError(String(error));
}

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
  private _currentTurnId: string | undefined;
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
  private readonly serverRequestResolutionWaiters = new Map<string | number, () => void>();
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
  /** The in-flight turn id, set on `turn/started` and cleared on `turn/completed`. */
  get currentTurnId(): string | undefined {
    return this._currentTurnId;
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
        if (
          isFromAgent(event) &&
          (event.event_type === "thread/started" ||
            event.event_type === "turn/started" ||
            event.event_type === "turn/completed") &&
          event.payload != null
        ) {
          try {
            const frame = JSON.parse(event.payload) as CodexFrame;
            this.captureThreadStarted(frame);
            this.captureTurnBoundary(frame);
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
    this.resolveParkedServerRequests();
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
        this.resolveParkedServerRequests();
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
  private captureTurnBoundary(frame: CodexFrame): void {
    if (frame.method !== "turn/started" && frame.method !== "turn/completed") return;
    const id = (frame.params as { turn?: { id?: unknown } } | undefined)?.turn?.id;
    if (typeof id !== "string") return;
    if (frame.method === "turn/started") this._currentTurnId = id;
    else if (this._currentTurnId === id) this._currentTurnId = undefined;
  }
  private captureServerRequestResolved(frame: CodexFrame): void {
    if (frame.method !== "serverRequest/resolved") return;
    const requestId = (frame.params as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    this.serverRequestResolutionWaiters.get(requestId)?.();
  }
  private resolveParkedServerRequests(): void {
    for (const resolveRequest of [...this.serverRequestResolutionWaiters.values()]) {
      resolveRequest();
    }
    this.serverRequestResolutionWaiters.clear();
  }
  private route(frame: CodexFrame): void {
    this.captureThreadStarted(frame);
    this.captureTurnBoundary(frame);
    this.captureServerRequestResolved(frame);
    if (!frame.method && frame.id != null) {
      frame.error
        ? this.pending.reject(frame.id, toRequestError(frame.error))
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
      case "mcpServer/elicitation/request":
        return { action: "cancel", content: null, _meta: null };
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
      case "mcpServer/elicitation/request":
        return { action: "cancel", content: null, _meta: null };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
    }
  }
  private trackServerRequest(requestId: string | number): ServerRequestLifecycle {
    let resolvedElsewhere = false;
    const controller = new AbortController();
    const release = () => {
      if (this.serverRequestResolutionWaiters.get(requestId) === onResolved) {
        this.serverRequestResolutionWaiters.delete(requestId);
      }
    };
    const onResolved = () => {
      resolvedElsewhere = true;
      release();
      controller.abort();
    };
    this.serverRequestResolutionWaiters.get(requestId)?.();
    this.serverRequestResolutionWaiters.set(requestId, onResolved);
    return { signal: controller.signal, resolvedElsewhere: () => resolvedElsewhere, release };
  }
  private approvalWithTimeout(
    request: ApprovalRequest,
    handler: ApprovalHandler,
    timeoutMs: number,
    requestSignal: AbortSignal,
  ): Promise<unknown | typeof SERVER_REQUEST_RESOLVED> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handlerController = new AbortController();
      const finish = (result: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        requestSignal.removeEventListener("abort", onResolved);
        handlerController.abort();
        resolve(result);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        requestSignal.removeEventListener("abort", onResolved);
        handlerController.abort();
        reject(error);
      };
      const onResolved = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        requestSignal.removeEventListener("abort", onResolved);
        handlerController.abort();
        resolve(SERVER_REQUEST_RESOLVED);
      };
      if (requestSignal.aborted) {
        onResolved();
        return;
      }
      requestSignal.addEventListener("abort", onResolved, { once: true });
      timer = setTimeout(() => finish(this.defaultDecline(request)), timeoutMs);
      Promise.resolve()
        .then(() => handler(request, { signal: handlerController.signal }))
        .then(finish, fail);
    });
  }
  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (this.fatal || !this.transport?.isReady()) return;
    let lifecycle: ServerRequestLifecycle | undefined;
    try {
      if (!CODEX_APPROVAL_REQUEST_METHOD_SET.has(request.method)) {
        await this.transport.write({
          id: request.id,
          error: { code: -32601, message: `Unsupported server request: ${request.method}` },
        });
        return;
      }
      lifecycle = this.trackServerRequest(request.id);
      const approval = request as ApprovalRequest;
      const handler = this.handlers.get(approval.method);
      const timeoutMs = this.options.requestTimeoutMs ?? 60_000;
      const outcome = handler
        ? await this.approvalWithTimeout(approval, handler, timeoutMs, lifecycle.signal)
        : this.defaultApproval(approval);
      if (outcome === SERVER_REQUEST_RESOLVED || lifecycle.resolvedElsewhere()) return;
      await this.transport?.write(
        { id: request.id, result: outcome },
        { signal: lifecycle.signal },
      );
    } catch (error) {
      if (!lifecycle?.resolvedElsewhere() && this.transport?.isReady()) {
        try {
          await this.transport.write(
            {
              id: request.id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            },
            lifecycle ? { signal: lifecycle.signal } : undefined,
          );
        } catch (publishError) {
          if (!lifecycle?.resolvedElsewhere()) throw publishError;
        }
      }
    } finally {
      lifecycle?.release();
    }
  }
  /**
   * Sends an app-server request and correlates its JSON-RPC response by id.
   * Internal: the public surface is the typed methods ({@link send},
   * {@link startReview}, {@link compactThread}, {@link readConfig}, …).
   * @throws {@link ConnectionStateError} with `terminated` or `not_connected`.
   */
  private async request(
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
    // Only awaited when the response lacks a thread id; pre-observe it so a
    // timeout firing while request() is still pending is never unhandled.
    notification.catch(() => undefined);
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
  /**
   * Sends text or structured input, creating a thread on the first call.
   * `options` carries per-turn overrides (see {@link TurnOptions}); the
   * app-server applies them to this turn and subsequent turns.
   */
  async send(prompt: string | InputItem[], options?: TurnOptions): Promise<void> {
    const threadId = this._threadId ?? (await this.startThread());
    const input: InputItem[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
    await this.request("turn/start", { threadId, input, ...options });
  }

  /**
   * Starts a Codex review on the current thread (`review/start`), creating a
   * thread if needed. Defaults to reviewing uncommitted changes.
   */
  async startReview(
    target: ReviewTarget = { type: "uncommittedChanges" },
    delivery?: ReviewDelivery | null,
  ): Promise<ReviewStartResponse> {
    const threadId = this._threadId ?? (await this.startThread());
    return (await this.request("review/start", {
      threadId,
      target,
      ...(delivery !== undefined ? { delivery } : {}),
    })) as ReviewStartResponse;
  }

  /** Compacts the active thread's context server-side (`thread/compact/start`). */
  async compactThread(): Promise<void> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    await this.request("thread/compact/start", { threadId: this._threadId });
  }

  /** Reads the app-server's effective configuration (`config/read`). */
  async readConfig(params: ConfigReadParams = {}): Promise<ConfigReadResponse> {
    return (await this.request("config/read", params)) as ConfigReadResponse;
  }
  /**
   * Reads the account's current rate limits (`account/rateLimits/read`).
   * Wire params are `Option<()>`: the params field must be omitted, not `{}`.
   */
  async getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return (await this.request(
      "account/rateLimits/read",
      undefined,
    )) as GetAccountRateLimitsResponse;
  }
  /**
   * Reads the account's token-usage summary (`account/usage/read`).
   * Wire params are `Option<()>`: the params field must be omitted, not `{}`.
   */
  async getAccountTokenUsage(): Promise<GetAccountTokenUsageResponse> {
    return (await this.request("account/usage/read", undefined)) as GetAccountTokenUsageResponse;
  }
  /**
   * Reads a thread's metadata — and optionally its turns — from rollout
   * history (`thread/read`). Defaults to the active thread.
   */
  async readThread(params?: Partial<ThreadReadParams>): Promise<ThreadReadResponse> {
    const threadId = params?.threadId ?? this._threadId;
    if (!threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    return (await this.request("thread/read", { ...params, threadId })) as ThreadReadResponse;
  }
  /** Renames the active thread (`thread/name/set`). */
  async setThreadName(name: string): Promise<ThreadSetNameResponse> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    return (await this.request("thread/name/set", {
      threadId: this._threadId,
      name,
    })) as ThreadSetNameResponse;
  }
  /** Sets or updates the active thread's goal (`thread/goal/set`). */
  async setThreadGoal(
    params: Omit<ThreadGoalSetParams, "threadId">,
  ): Promise<ThreadGoalSetResponse> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    return (await this.request("thread/goal/set", {
      ...params,
      threadId: this._threadId,
    })) as ThreadGoalSetResponse;
  }
  /** Reads the active thread's goal (`thread/goal/get`). */
  async getThreadGoal(): Promise<ThreadGoalGetResponse> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    return (await this.request("thread/goal/get", {
      threadId: this._threadId,
    })) as ThreadGoalGetResponse;
  }
  /** Clears the active thread's goal (`thread/goal/clear`). */
  async clearThreadGoal(): Promise<ThreadGoalClearResponse> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    return (await this.request("thread/goal/clear", {
      threadId: this._threadId,
    })) as ThreadGoalClearResponse;
  }
  /** Lists configured MCP servers with startup/auth status (`mcpServerStatus/list`). */
  async listMcpServerStatus(
    params: ListMcpServerStatusParams = {},
  ): Promise<ListMcpServerStatusResponse> {
    return (await this.request("mcpServerStatus/list", params)) as ListMcpServerStatusResponse;
  }
  /** Lists skills available to the session (`skills/list`). */
  async listSkills(params: SkillsListParams = {}): Promise<SkillsListResponse> {
    return (await this.request("skills/list", params)) as SkillsListResponse;
  }
  /**
   * Interrupts the in-flight turn (`turn/interrupt`). The app-server requires
   * the thread and turn ids, which the connection tracks from `turn/started`
   * notifications. A no-op when no turn is in flight.
   * @throws {@link ConnectionStateError} with `not_connected` if no thread is active.
   */
  async interrupt(): Promise<void> {
    if (!this._threadId)
      throw new ConnectionStateError(
        "not_connected",
        "No active thread. Call startThread() first.",
      );
    const turnId = this._currentTurnId;
    if (!turnId) return;
    await this.request("turn/interrupt", { threadId: this._threadId, turnId });
  }
  /** Resumes a known server-side thread and makes it current. */
  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
    this._threadId = threadId;
    this._currentTurnId = undefined;
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
   * Registers an approval or elicitation handler. Without one, command/file
   * approvals are accepted, legacy approvals are approved, user-input answers
   * are empty, requested permissions are granted for the turn, and MCP
   * elicitations are canceled. Handler timeouts are declined or canceled.
   * Mounting with `approval_policy=never` avoids approval traffic.
   */
  onApprovalRequest(method: ApprovalMethod, handler: ApprovalHandler): () => void {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }
  private nextMessage(): Promise<CodexFrame | null> {
    // Delegate closed-state handling to the queue so frames buffered before a
    // fatal error or stream end remain drainable; disconnect() clears them.
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

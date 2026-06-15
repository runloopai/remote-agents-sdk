import type {
  PermissionMode,
  SDKControlRequest,
  SDKControlResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AxonEventView,
  AxonPublishParams,
  PublishResultView,
} from "@runloop/api-client/resources/axons";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { resolveReplayTarget } from "../shared/connect-guards.js";
import { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { assertPayloadWithinLimit } from "../shared/errors/payload-too-large-error.js";
import { SystemError } from "../shared/errors/system-error.js";
import { runDisconnectHook } from "../shared/lifecycle.js";
import { ListenerSet } from "../shared/listener-set.js";
import { makeDefaultOnError, makeLogger } from "../shared/logging.js";
import { timelineEventGenerator } from "../shared/timeline-generator.js";
import type {
  AxonEventListener,
  BaseConnectionOptions,
  LogFn,
  TimelineEventListener,
} from "../shared/types.js";
import { classifyClaudeAxonEvent } from "./classify-claude-axon-event.js";
import { AxonTransport, type Transport } from "./transport.js";
import type { ClaudeTimelineEvent, WireData } from "./types.js";

/** The inner request payload — discriminated by `subtype`. */
export type ControlRequestInner = SDKControlRequest["request"];

/** Extract a specific control request subtype. */
export type ControlRequestOfSubtype<S extends ControlRequestInner["subtype"]> = Extract<
  ControlRequestInner,
  { subtype: S }
>;

/**
 * Handler for an incoming control request from the CLI.
 *
 * When Claude Code needs permission to use a tool (subtype "can_use_tool"),
 * it sends a control request. By registering a handler via
 * {@link ClaudeAxonConnection.onControlRequest}, you can intercept these
 * requests and provide a custom response — for example, showing a UI prompt
 * to the user and returning their selection.
 *
 * The handler receives the full {@link SDKControlRequest} and must return
 * a complete {@link SDKControlResponse}. If no handler is registered for a
 * given subtype, the built-in default behavior is used (e.g. auto-allow
 * for can_use_tool).
 *
 * @example
 * ```ts
 * connection.onControlRequest("can_use_tool", async (request) => {
 *   return {
 *     type: "control_response",
 *     response: {
 *       subtype: "success",
 *       request_id: request.request_id,
 *       response: { behavior: "allow", updatedInput: request.request.input },
 *     },
 *   };
 * });
 * ```
 *
 * @param request - The full control request message, narrowed so that
 *   `request.request` is typed to the specific subtype `S`.
 * @returns A complete {@link SDKControlResponse} to send back to the CLI.
 *
 * @category Configuration
 */
export type ControlRequestHandler<S extends ControlRequestInner["subtype"]> = (
  request: SDKControlRequest & { request: ControlRequestOfSubtype<S> },
) => Promise<SDKControlResponse>;

// ---------------------------------------------------------------------------
// Control protocol helpers
// ---------------------------------------------------------------------------

/**
 * Generates a unique request ID for an outbound control request.
 * Combines a monotonic counter with a random suffix to avoid collisions.
 *
 * @param counter - The current monotonically increasing counter value.
 * @returns A string of the form `req_{counter}_{random}`.
 */
function nextRequestId(counter: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `req_${counter}_${rand}`;
}

/**
 * Tracks a single in-flight control request so its promise can be
 * resolved or rejected when the matching response arrives.
 */
interface PendingControlRequest {
  /** Settles the promise with the response payload on success. */
  resolve: (value: WireData) => void;
  /** Rejects the promise on error or timeout. */
  reject: (reason: Error) => void;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/** @category Configuration */
export interface ClaudeAxonConnectionOptions extends BaseConnectionOptions {
  /**
   * Replaces the default system prompt sent to Claude Code during the
   * `initialize` control handshake. When set, the agent uses *only* this
   * text as its system prompt — the built-in prompt is discarded entirely.
   *
   * Mutually independent of {@link appendSystemPrompt}; if both are
   * provided, `systemPrompt` replaces the default and
   * `appendSystemPrompt` is appended to that replacement.
   */
  systemPrompt?: string;

  /**
   * Text appended to the system prompt (whether default or overridden by
   * {@link systemPrompt}) during the `initialize` handshake. Use this to
   * inject additional instructions without losing the agent's built-in
   * prompt.
   */
  appendSystemPrompt?: string;

  /**
   * Anthropic model identifier to select after initialization
   * (e.g. `"claude-haiku-4-5"`, `"claude-sonnet-4-5"`).
   *
   * When provided, {@link ClaudeAxonConnection.initialize | initialize()} sends
   * a `set_model` control request immediately after the `initialize`
   * handshake completes.
   */
  model?: string;
}

// ---------------------------------------------------------------------------
// ClaudeAxonConnection
// ---------------------------------------------------------------------------

/**
 * Bidirectional, interactive client for Claude Code via Axon.
 *
 * Provides:
 * - {@link connect} / {@link initialize} / {@link disconnect} lifecycle
 * - {@link send} to send user messages
 * - {@link receiveMessages} / {@link receiveResponse} async iterators
 * - Control protocol: {@link interrupt}, {@link setPermissionMode}, {@link setModel}
 * - {@link onControlRequest} to intercept incoming control requests (e.g. tool permissions)
 *
 * Messages are yielded as `SDKMessage` from `@anthropic-ai/claude-agent-sdk` —
 * the exact types the Claude Code CLI emits.
 *
 * @category Connection
 */
export class ClaudeAxonConnection {
  /** The Axon channel ID this connection is bound to. */
  readonly axonId: string;

  /** The Runloop devbox ID. */
  readonly devboxId: string;

  /**
   * Whether the transport is connected and the read loop is active.
   * Returns `true` after {@link connect} resolves and before {@link disconnect}.
   */
  get isConnected(): boolean {
    return this.readLoopRunning && !this.closed;
  }

  /**
   * Whether the connection has been fully initialized (transport connected,
   * read loop active, and protocol handshake complete).
   * Returns `false` before {@link initialize} resolves or after the read loop ends.
   */
  get isInitialized(): boolean {
    return this.handshakeComplete && this.readLoopRunning && !this.closed;
  }

  /**
   * Whether the connection is not live after having been connected at least once.
   * Returns `false` before the first successful {@link connect}, and `true` after
   * a disconnect/teardown until {@link connect} runs again.
   */
  get isDisconnected(): boolean {
    return this.hasEverConnected && !this.readLoopRunning;
  }

  /** Low-level transport that reads/writes messages over the Axon channel. */
  private transport: Transport | undefined;

  /** The Axon channel reference, kept for replay sequence query. */
  private axon: Axon;

  /** Resolved options (user-provided values merged with defaults). */
  private options: ClaudeAxonConnectionOptions;

  /** Error sink for listener exceptions; defaults to `console.error`. */
  private handleError: (error: unknown) => void;

  /** Optional teardown callback invoked by {@link disconnect}. */
  private disconnectFn: (() => void | Promise<void>) | undefined;

  private static readonly MESSAGE_QUEUE_HIGH_WATER_MARK = 1000;

  /** Buffer of SDK messages that arrived before a consumer called {@link nextMessage}. */
  private messageQueue: SDKMessage[] = [];
  private messageQueueWarned = false;

  /** Promise resolvers waiting for the next SDK message. */
  private messageWaiters: Array<(msg: SDKMessage | null) => void> = [];

  /** Whether the background read loop has been started. */
  private readLoopRunning = false;

  /** Whether the initialize handshake has completed successfully. */
  private handshakeComplete = false;

  /** Whether the background read loop has finished (stream ended or errored). */
  private readLoopDone = false;

  /** Monotonically increasing counter used to generate unique control request IDs. */
  private requestCounter = 0;

  /** In-flight control requests awaiting a response from the CLI. */
  private pendingControlRequests = new Map<string, PendingControlRequest>();

  /**
   * When true, inbound routing and the read loop should stop. Cleared after a
   * graceful {@link disconnect} completes so the same instance can {@link connect} again.
   */
  private closed = false;

  /** Set when a {@link SystemError} is observed; the instance cannot reconnect. */
  private fatal = false;

  /** Set after the first successful {@link connect}; used by {@link isDisconnected}. */
  private hasEverConnected = false;

  /**
   * When true, the read loop must not run transport-level SSE auto-recovery
   * (used during {@link disconnect} so a late read-loop tick cannot reconnect
   * after `closed` is cleared for same-instance reconnect).
   */
  private suppressTransportAutoReconnect = false;

  private streamAborted = false;

  /** Aborted when the connection closes or the read loop ends, to terminate timeline generators. */
  private timelineAbortController = new AbortController();

  /** User-registered handlers for incoming control requests, keyed by subtype. */
  // biome-ignore lint/suspicious/noExplicitAny: handlers are typed at registration via onControlRequest()
  private controlRequestHandlers = new Map<string, ControlRequestHandler<any>>();

  /** Registered raw Axon event listeners. */
  private axonEventListeners: ListenerSet<AxonEventListener>;

  /** Registered timeline event listeners. */
  private timelineEventListeners: ListenerSet<TimelineEventListener<ClaudeTimelineEvent>>;

  private log: LogFn;

  /**
   * Creates a new Claude connection over the given Axon channel and devbox.
   *
   * Unlike ACP, the transport is not opened until {@link connect} is called.
   *
   * @param axon    - The Axon channel to communicate over (from `@runloop/api-client`).
   * @param devbox  - The Runloop devbox hosting the Claude Code agent.
   * @param options - Optional configuration for verbose logging, system prompt,
   *   model selection, error handling, and lifecycle hooks.
   */
  constructor(axon: Axon, devbox: Devbox, options?: ClaudeAxonConnectionOptions) {
    this.axonId = axon.id;
    this.devboxId = devbox.id;
    this.axon = axon;
    this.options = options ?? {};
    this.handleError = options?.onError ?? makeDefaultOnError("ClaudeAxonConnection");
    this.disconnectFn = options?.onDisconnect;
    this.log = makeLogger("claude-sdk", options?.verbose ?? false);
    this.axonEventListeners = new ListenerSet<AxonEventListener>(this.handleError);
    this.timelineEventListeners = new ListenerSet<TimelineEventListener<ClaudeTimelineEvent>>(
      this.handleError,
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Opens the transport and starts the background read loop.
   *
   * Call this before {@link initialize} to establish the Axon connection.
   *
   * When `replay` is `true` (the default), queries the axon for the
   * current head sequence and replays all events up to that point
   * without invoking handlers. Unresolved control requests are
   * dispatched to handlers after replay completes.
   *
   * @throws {ConnectionStateError} If the connection is not reusable after a fatal broker error (`code: "terminated"`).
   * @throws {ConnectionStateError} If the transport is already connected (`code: "already_connected"`).
   * @throws If both `replay` and `afterSequence` are set.
   */
  async connect(): Promise<void> {
    if (this.fatal) {
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    }
    if (this.readLoopRunning) {
      throw new ConnectionStateError(
        "already_connected",
        "Already connected. Call disconnect() before reconnecting.",
      );
    }

    this.suppressTransportAutoReconnect = false;
    this.readLoopDone = false;

    const replayTargetSequence = await resolveReplayTarget(this.axon, this.options, this.log);

    if (!this.transport) {
      this.transport = new AxonTransport(this.axon, {
        verbose: this.options.verbose,
        onAxonEvent: (ev) => {
          this.axonEventListeners.emit(ev);
          this.emitTimelineEvent(ev);
        },
        afterSequence: this.options.afterSequence,
        replayTargetSequence,
      });
    }

    await this.transport.connect();
    this.startReadLoop();
    this.hasEverConnected = true;
  }

  /**
   * Runs the **Claude agent protocol `initialize` step** with the Claude Code CLI.
   *
   * This is **required once** after {@link connect} on first startup: `connect()` only
   * opens the transport and read loop; the agent does not accept prompts or control
   * traffic until this handshake completes. If {@link ClaudeAxonConnectionOptions.model}
   * was set, a `set_model` control request is sent immediately afterward.
   *
   * @throws {ConnectionStateError} If the connection is not reusable after a fatal broker error (`code: "terminated"`).
   * @throws {ConnectionStateError} If {@link connect} has not been called yet (`code: "not_connected"`).
   * @throws {ConnectionStateError} If the handshake has already completed (`code: "already_initialized"`).
   */
  async initialize(): Promise<void> {
    if (this.fatal) {
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    }
    if (!this.readLoopRunning) {
      throw new ConnectionStateError(
        "not_connected",
        "Not connected. Call connect() before initialize().",
      );
    }
    if (this.handshakeComplete) {
      throw new ConnectionStateError(
        "already_initialized",
        "Already initialized. Call disconnect() before reinitializing.",
      );
    }

    await this.sendInitialize();
    this.handshakeComplete = true;

    if (this.options.model) {
      await this.setModel(this.options.model);
    }
  }

  /**
   * Aborts the underlying SSE stream without clearing registered listeners
   * or running the `onDisconnect` callback.
   *
   * Unlike {@link disconnect}, listeners remain registered. Note that after
   * calling this method, the connection cannot be reused — create a new
   * `ClaudeAxonConnection` instance to reconnect.
   */
  abortStream(): void {
    if (!this.transport) {
      return;
    }
    this.streamAborted = true;
    this.transport.abortStream();
  }

  /**
   * Closes the transport, fails all pending control requests, and runs the
   * `onDisconnect` callback if one was provided.
   *
   * User-registered listeners ({@link onAxonEvent}, {@link onTimelineEvent},
   * {@link onControlRequest}) are **preserved** so they keep working after
   * another {@link connect}.
   *
   * Idempotent — subsequent calls are no-ops until the next {@link connect}.
   *
   * @returns Resolves once all teardown (including `onDisconnect`) completes.
   */
  async disconnect(): Promise<void> {
    if (this.fatal) {
      if (this.transport) {
        try {
          await this.transport.close();
        } catch {
          // best-effort
        }
        this.transport = undefined;
      }
      return;
    }

    if (!this.transport && !this.readLoopRunning) {
      return;
    }

    this.suppressTransportAutoReconnect = true;
    this.closed = true;
    this.timelineAbortController.abort();

    // Unblock any waiters and clear buffered messages
    for (const waiter of this.messageWaiters) {
      waiter(null);
    }
    this.messageWaiters.length = 0;
    this.messageQueue.length = 0;

    this.handshakeComplete = false;

    // Fail pending control requests
    for (const [, pending] of this.pendingControlRequests) {
      pending.reject(new Error("Client disconnected"));
    }
    this.pendingControlRequests.clear();

    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    this.readLoopRunning = false;
    await runDisconnectHook(this.disconnectFn, this.log, this.handleError);

    this.timelineAbortController = new AbortController();
    this.closed = false;
    this.readLoopDone = false;
  }

  // -----------------------------------------------------------------------
  // Axon event listeners
  // -----------------------------------------------------------------------

  /**
   * Registers a listener for every Axon event (before origin filtering).
   * Useful for debugging, observability, and building Axon event viewers.
   *
   * @param listener - Callback invoked with the raw {@link AxonEventView}
   *   for every event on the channel, regardless of origin.
   * @returns An unsubscribe function that removes the listener.
   */
  onAxonEvent(listener: AxonEventListener): () => void {
    return this.axonEventListeners.add(listener);
  }

  /**
   * Registers a listener for classified timeline events (push API).
   *
   * Every Axon event on the channel is classified into one of:
   * - `claude_protocol` — a known Claude protocol event (user or agent message)
   * - `system` — a broker system event (`turn.started`, `turn.completed`,
   *   `turn.failed`, `broker.error`)
   * - `unknown` — anything else
   *
   * For a pull-based alternative, see {@link receiveTimelineEvents}.
   * Both APIs deliver the same events; choose whichever fits your
   * consumption pattern.
   *
   * @param listener - Callback invoked with each {@link ClaudeTimelineEvent}.
   * @returns An unsubscribe function that removes the listener.
   */
  onTimelineEvent(listener: TimelineEventListener<ClaudeTimelineEvent>): () => void {
    return this.timelineEventListeners.add(listener);
  }

  /**
   * Async generator that yields classified timeline events (pull API).
   *
   * Mirrors the pull-based pattern of {@link receiveAgentEvents}. The
   * generator completes when the connection is disconnected or the
   * read loop ends.
   *
   * For a push-based alternative, see {@link onTimelineEvent}.
   * Both APIs deliver the same events; choose whichever fits your
   * consumption pattern.
   *
   * @returns An async generator of {@link ClaudeTimelineEvent}.
   */
  async *receiveTimelineEvents(): AsyncGenerator<ClaudeTimelineEvent, void, undefined> {
    yield* timelineEventGenerator<ClaudeTimelineEvent>(
      (listener) => this.onTimelineEvent(listener),
      this.timelineAbortController.signal,
    );
  }

  // -----------------------------------------------------------------------
  // Read loop — routes control messages vs SDK messages
  // -----------------------------------------------------------------------

  /**
   * Spawns a background async loop that reads messages from the transport
   * and routes them via {@link routeMessage}. On error, all pending control
   * requests are failed. When the loop ends (normally or via error), all
   * message waiters are unblocked with `null`.
   */
  private startReadLoop(): void {
    if (this.readLoopRunning) return;
    this.readLoopRunning = true;

    (async () => {
      const transport = this.transport;
      if (!transport) {
        this.readLoopRunning = false;
        return;
      }

      let reconnected = false;

      const consumeStream = async (): Promise<"ended" | "error"> => {
        try {
          for await (const message of transport.readMessages()) {
            if (this.closed) return "ended";
            this.routeMessage(message);
          }
          return "ended";
        } catch (err) {
          this.log("readLoop", `error: ${err}`);
          this.handleError(err);
          if (err instanceof SystemError) {
            this.fatal = true;
            this.closed = true;
          }
          for (const [, pending] of this.pendingControlRequests) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pendingControlRequests.clear();
          return "error";
        }
      };

      const outcome = await consumeStream();

      if (
        !this.closed &&
        !this.suppressTransportAutoReconnect &&
        !this.streamAborted &&
        !reconnected
      ) {
        const label = outcome === "error" ? "error" : "ended unexpectedly";
        this.log("readLoop", `SSE stream ${label}, reconnecting...`);
        reconnected = true;
        try {
          await transport.reconnect();
          this.log("readLoop", "reconnected successfully");
          await consumeStream();
        } catch (reconnectErr) {
          this.log("readLoop", `reconnect failed: ${reconnectErr}`);
        }
      }

      this.readLoopDone = true;
      this.readLoopRunning = false;
      this.streamAborted = false;
      this.timelineAbortController.abort();
      for (const waiter of this.messageWaiters) {
        waiter(null);
      }
      this.messageWaiters.length = 0;
    })();
  }

  /**
   * Classifies a raw Axon event and emits it to timeline listeners.
   */
  private emitTimelineEvent(ev: AxonEventView): void {
    const event = classifyClaudeAxonEvent(ev);
    this.timelineEventListeners.emit(event);
  }

  /**
   * Dispatches a single inbound wire message to the correct handler:
   * - `control_response` → resolves or rejects the matching pending request.
   * - `control_request`  → delegates to {@link handleIncomingControlRequest}.
   * - `control_cancel_request` → silently dropped (no-op).
   * - Everything else → treated as an `SDKMessage` and delivered to
   *   the next {@link nextMessage} waiter or buffered in the message queue.
   *
   * @param message - The parsed wire-level message from the transport.
   */
  private routeMessage(message: WireData): void {
    if (this.closed) return;
    const msgType = message.type;

    // Control response — resolve pending request
    if (msgType === "control_response") {
      const response = message.response ?? {};
      const requestId: string | undefined = response.request_id;
      if (requestId && this.pendingControlRequests.has(requestId)) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by .has() check above
        const pending = this.pendingControlRequests.get(requestId)!;
        this.pendingControlRequests.delete(requestId);
        if (response.subtype === "error") {
          pending.reject(new Error(response.error ?? "Unknown control error"));
        } else {
          pending.resolve(response.response ?? {});
        }
      }
      return;
    }

    // Control request from CLI — validate shape before handling
    if (msgType === "control_request") {
      if (
        typeof message.request_id !== "string" ||
        typeof message.request !== "object" ||
        message.request === null
      ) {
        this.log("routeMessage", "malformed control_request — missing request_id or request");
        return;
      }
      this.handleIncomingControlRequest(message as SDKControlRequest).catch((err) => {
        this.log("control", `handler error: ${err}`);
        this.handleError(err);
      });
      return;
    }

    // Control cancel request
    if (msgType === "control_cancel_request") {
      return;
    }

    // Regular SDK message — validate it has a string type before casting
    if (typeof msgType !== "string") {
      this.log("routeMessage", "dropping message with non-string type");
      return;
    }
    const sdkMessage = message as SDKMessage;
    if (this.messageWaiters.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by .length > 0 check above
      const waiter = this.messageWaiters.shift()!;
      waiter(sdkMessage);
    } else {
      this.messageQueue.push(sdkMessage);
      if (
        !this.messageQueueWarned &&
        this.messageQueue.length >= ClaudeAxonConnection.MESSAGE_QUEUE_HIGH_WATER_MARK
      ) {
        this.messageQueueWarned = true;
        this.handleError(
          `[ClaudeAxonConnection] Message queue has ${this.messageQueue.length} buffered messages. ` +
            "Ensure you are consuming messages via receiveMessages() or receiveResponse().",
        );
      }
    }
  }

  /**
   * Returns the next buffered SDK message, or waits for one to arrive.
   * Resolves with `null` when the read loop has ended or the connection
   * has been closed.
   *
   * @returns The next SDK message, or `null` if no more messages will arrive.
   */
  private nextMessage(): Promise<SDKMessage | null> {
    if (this.messageQueue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by .length > 0 check above
      return Promise.resolve(this.messageQueue.shift()!);
    }
    if (this.readLoopDone || this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<SDKMessage | null>((resolve) => {
      this.messageWaiters.push(resolve);
    });
  }

  // -----------------------------------------------------------------------
  // Control protocol
  // -----------------------------------------------------------------------

  /**
   * Sends a control request to the CLI and waits for the matching response.
   *
   * Internally assigns a unique request ID, publishes the request via the
   * transport, and returns a promise that resolves when the CLI sends a
   * `control_response` with the same ID. Times out if no response arrives
   * within `timeoutMs`.
   *
   * @param request   - The control request payload (must include a `subtype`).
   * @param timeoutMs - Maximum time to wait for the response (default 60 s).
   * @returns The `response` field from the successful `control_response`.
   * @throws On timeout, error-subtype responses, or transport failures.
   */
  private async sendControlRequest(request: WireData, timeoutMs = 60_000): Promise<WireData> {
    this.requestCounter++;
    const requestId = nextRequestId(this.requestCounter);
    const controlRequest = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    const promise = new Promise<WireData>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControlRequests.has(requestId)) {
          this.pendingControlRequests.delete(requestId);
          reject(new Error(`Control request timeout: ${request.subtype}`));
        }
      }, timeoutMs);

      this.pendingControlRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
    });

    const transport = this.transport;
    if (!transport) {
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    }
    await transport.write(JSON.stringify(controlRequest));
    return promise;
  }

  /**
   * Sends the `initialize` control request to the Claude Code CLI,
   * including system prompt overrides if configured.
   *
   * Uses a longer timeout (120 s) because the agent may need to start up.
   *
   * @returns The CLI's initialization response payload.
   * @throws On timeout or if the CLI rejects initialization.
   */
  private async sendInitialize(): Promise<WireData> {
    this.log("init", "sending initialize request");
    const response = await this.sendControlRequest(
      {
        subtype: "initialize",
        hooks: null,
        ...(this.options.systemPrompt && {
          systemPrompt: this.options.systemPrompt,
        }),
        ...(this.options.appendSystemPrompt && {
          appendSystemPrompt: this.options.appendSystemPrompt,
        }),
      },
      120_000, // longer timeout for initialization
    );
    this.log("init", "initialized");
    return response;
  }

  /**
   * Handle an incoming control request from the CLI (e.g. permission, hook).
   *
   * If a handler has been registered for the request's subtype via
   * {@link onControlRequest}, it is called and its return value is sent
   * as the response. Otherwise, built-in defaults are used:
   *
   * - `can_use_tool` → auto-allow with the original input
   * - `hook_callback` → continue without modification
   * - `mcp_message`  → error (not supported)
   *
   * If the handler or default logic throws, an error response is sent
   * back to the CLI so it does not hang waiting.
   *
   * **Important:** If you override the handler via {@link onControlRequest},
   * you **must** handle `can_use_tool` permission requests yourself, or
   * include `--dangerously-skip-permissions` in the `launch_args` passed to
   * the broker mount. Failing to do so will cause the CLI to hang waiting
   * for a permission response that never arrives.
   *
   * @param message - The incoming `SDKControlRequest` from the CLI.
   */
  private async handleIncomingControlRequest(message: SDKControlRequest): Promise<void> {
    if (this.closed) return;
    const requestId = message.request_id;
    const request = message.request;

    try {
      let controlResponse: SDKControlResponse;

      // Check for a registered handler for this subtype
      const handler = this.controlRequestHandlers.get(request.subtype);
      if (handler) {
        controlResponse = await handler(message);
      } else {
        // Built-in defaults when no handler is registered
        let responseData: WireData = {};
        switch (request.subtype) {
          case "can_use_tool": {
            const permReq: ControlRequestOfSubtype<"can_use_tool"> = request;
            // Default: allow all tools
            responseData = {
              behavior: "allow",
              updatedInput: permReq.input,
            };
            break;
          }
          case "hook_callback": {
            // Default: continue without modification
            responseData = { continue: true };
            break;
          }
          case "mcp_message": {
            responseData = {
              error: "SDK MCP servers not supported in AxonTransport",
            };
            break;
          }
          default:
            responseData = {};
            break;
        }
        controlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: responseData,
          },
        };
      }

      if (!this.closed) {
        await this.transport?.write(JSON.stringify(controlResponse));
      }
    } catch (err) {
      if (this.closed) return;
      const errorResponse: SDKControlResponse = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: String(err),
        },
      };
      await this.transport?.write(JSON.stringify(errorResponse));
    }
  }

  // -----------------------------------------------------------------------
  // Public API — sending messages
  // -----------------------------------------------------------------------

  /**
   * Sends a single user message to Claude.
   *
   * If given a plain string, it is automatically wrapped into an
   * `SDKUserMessage` with `role: "user"`. Pass a pre-built
   * `SDKUserMessage` for full control (e.g. to set `parent_tool_use_id`).
   *
   * @param prompt - A string message or a fully formed `SDKUserMessage`.
   *
   * @throws {ConnectionStateError} If not connected (`code: "not_connected"`) or after a fatal error (`code: "terminated"`).
   *
   * @example
   * ```ts
   * await conn.send("What files are in this directory?");
   * ```
   */
  async send(prompt: string | SDKUserMessage): Promise<void> {
    if (this.fatal) {
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    }
    if (!this.readLoopRunning) {
      throw new ConnectionStateError(
        "not_connected",
        "Connection is not connected. Call connect() or initialize() first.",
      );
    }
    const transport = this.transport;
    if (!transport) {
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    }
    const message: SDKUserMessage =
      typeof prompt === "string"
        ? {
            type: "user",
            message: { role: "user", content: prompt },
            parent_tool_use_id: null,
          }
        : prompt;
    await transport.write(JSON.stringify(message));
  }

  /**
   * Publishes a custom event to the Axon channel.
   *
   * The event will appear in the SSE stream and be classified by the
   * timeline (typically as `kind: "unknown"` unless the `event_type`
   * matches a known Claude protocol message type).
   *
   * @param params - The event to publish (same shape as `Axon.publish()`).
   * @returns The publish result with sequence number and timestamp.
   */
  async publish(params: AxonPublishParams): Promise<PublishResultView> {
    assertPayloadWithinLimit(params.payload);
    return this.axon.publish(params);
  }

  // -----------------------------------------------------------------------
  // Public API — receiving messages
  // -----------------------------------------------------------------------

  /**
   * Async iterator that yields every `SDKMessage` from Claude indefinitely.
   *
   * Does **not** stop at `result` messages — use {@link receiveAgentResponse}
   * for single-turn convenience. Iteration ends when the transport closes
   * or {@link disconnect} is called.
   *
   * @yields Each `SDKMessage` as it arrives from the agent.
   */
  async *receiveAgentEvents(): AsyncGenerator<SDKMessage, void, undefined> {
    while (true) {
      const msg = await this.nextMessage();
      if (msg === null) return;
      yield msg;
    }
  }

  /**
   * Async iterator that yields `SDKMessage`s until (and including) a
   * `result` message, then terminates automatically.
   *
   * Convenient for single-turn usage: send a prompt, iterate
   * `receiveAgentResponse()`, and the loop ends when Claude finishes.
   *
   * @yields Each `SDKMessage` up to and including the `result`.
   *
   * @example
   * ```ts
   * await conn.send("Summarize this file.");
   * for await (const msg of conn.receiveAgentResponse()) {
   *   console.log(msg.type, msg);
   * }
   * ```
   */
  async *receiveAgentResponse(): AsyncGenerator<SDKMessage, void, undefined> {
    for await (const msg of this.receiveAgentEvents()) {
      yield msg;
      if (msg.type === "result") {
        return;
      }
    }
  }

  /**
   * @deprecated Use {@link receiveAgentEvents} instead.
   */
  async *receiveMessages(): AsyncGenerator<SDKMessage, void, undefined> {
    yield* this.receiveAgentEvents();
  }

  /**
   * @deprecated Use {@link receiveAgentResponse} instead.
   */
  async *receiveResponse(): AsyncGenerator<SDKMessage, void, undefined> {
    yield* this.receiveAgentResponse();
  }

  // -----------------------------------------------------------------------
  // Public API — control operations
  // -----------------------------------------------------------------------

  /**
   * Interrupts the current conversation turn.
   *
   * @throws On timeout or if the CLI rejects the interrupt.
   */
  async interrupt(): Promise<void> {
    await this.sendControlRequest({ subtype: "interrupt" });
  }

  /**
   * Changes the permission mode for tool use.
   *
   * @param mode - The new permission mode (e.g. `"default"`, `"acceptEdits"`).
   * @throws On timeout or if the CLI rejects the mode change.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_permission_mode",
      mode,
    });
  }

  /**
   * Changes the AI model used by Claude Code.
   *
   * @param model - Anthropic model identifier (e.g. `"claude-sonnet-4-5"`),
   *   or `null` to revert to the agent's default.
   * @throws On timeout or if the CLI rejects the model change.
   */
  async setModel(model: string | null): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_model",
      model,
    });
  }

  /**
   * Register a handler for incoming control requests of a given subtype.
   *
   * When Claude Code sends a control request (e.g. asking permission to use
   * a tool), the registered handler is called instead of the built-in default.
   * The handler receives the full {@link SDKControlRequest} and must return
   * a complete {@link SDKControlResponse}. The connection sends it back as-is.
   *
   * Only one handler can be registered per subtype. Calling this method again
   * with the same subtype replaces the previous handler.
   *
   * @param subtype - The control request subtype to handle (e.g. "can_use_tool").
   * @param handler - Async function that processes the request and returns a full SDKControlResponse.
   *
   * @example
   * ```ts
   * connection.onControlRequest("can_use_tool", async (message) => {
   *   return {
   *     type: "control_response",
   *     response: {
   *       subtype: "success",
   *       request_id: message.request_id,
   *       response: { behavior: "allow", updatedInput: message.request.input },
   *     },
   *   };
   * });
   * ```
   */
  onControlRequest<S extends ControlRequestInner["subtype"]>(
    subtype: S,
    handler: ControlRequestHandler<S>,
  ): () => void {
    this.controlRequestHandlers.set(subtype, handler);
    return () => {
      if (this.controlRequestHandlers.get(subtype) === handler) {
        this.controlRequestHandlers.delete(subtype);
      }
    };
  }
}

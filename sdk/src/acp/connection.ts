import {
  AGENT_METHODS,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  CLIENT_METHODS,
  type Client,
  ClientSideConnection,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
  AxonEventView,
  AxonPublishParams,
  PublishResultView,
} from "@runloop/api-client/resources/axons";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { resolveReplayTarget } from "../shared/connect-guards.js";
import { rethrowAsACPError, toACPError } from "../shared/errors/acp-request-error.js";
import { ConnectionStateError } from "../shared/errors/connection-state-error.js";
import { InitializationError } from "../shared/errors/initialization-error.js";
import { runDisconnectHook } from "../shared/lifecycle.js";
import { ListenerSet } from "../shared/listener-set.js";
import { makeDefaultOnError, makeLogger } from "../shared/logging.js";
import { createClassifier } from "../shared/timeline.js";
import { timelineEventGenerator } from "../shared/timeline-generator.js";
import type { AxonEventListener, LogFn, TimelineEventListener } from "../shared/types.js";
import { axonStream } from "./axon-stream.js";
import type {
  ACPAxonConnectionOptions,
  ACPProtocolTimelineEvent,
  ACPTimelineEvent,
  SessionUpdateListener,
} from "./types.js";

// The @agentclientprotocol/sdk package does not expose an `isKnownMethod()`
// helper, so we build a lookup Set from the exported method-name constants.
// `isACPProtocolEventType()` below wraps this as the public API.
const ACP_KNOWN_EVENT_TYPES: Set<string> = new Set([
  ...Object.values(AGENT_METHODS),
  ...Object.values(CLIENT_METHODS),
]);

/**
 * Returns `true` if `eventType` is a known ACP protocol method
 * (agent or client direction).
 *
 * @category Timeline
 */
export function isACPProtocolEventType(eventType: string): boolean {
  return ACP_KNOWN_EVENT_TYPES.has(eventType);
}

/**
 * High-level ACP connection backed by an Axon transport.
 *
 * Wraps a `ClientSideConnection` with an `axonStream`, providing:
 * - Proxied ACP agent methods (`initialize`, `prompt`, `newSession`, etc.)
 * - Session update listener registration
 * - Raw Axon event tapping for debugging
 * - Configurable permission handling
 * - Lifecycle management (`signal`, `closed`, `disconnect`)
 *
 * The underlying `ClientSideConnection` is accessible via `.protocol` for
 * advanced use cases (e.g. unstable/experimental ACP methods).
 *
 * @category Connection
 */
export class ACPAxonConnection {
  /** The Axon channel ID this connection is bound to. */
  readonly axonId: string;

  /** The Runloop devbox ID. */
  readonly devboxId: string;

  /**
   * The underlying ACP SDK `ClientSideConnection`.
   *
   * Use this for direct access to experimental/unstable protocol methods
   * (e.g. `unstable_forkSession`, `unstable_closeSession`). For stable
   * methods, prefer the proxied methods on this class directly.
   *
   * Only available after {@link connect} has been called.
   */
  get protocol(): ClientSideConnection {
    if (!this._protocol) {
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    }
    return this._protocol;
  }

  /** Controller whose signal is passed to the Axon stream; aborting it tears down the SSE subscription. */
  private abortController: AbortController;
  private connected = false;

  /** The Axon channel reference, kept for connect(). */
  private axon: Axon;

  /** Stored options for deferred connect(). */
  private options: ACPAxonConnectionOptions;

  /** Created during connect(). */
  private _protocol: ClientSideConnection | null = null;

  /** Registered `session/update` notification listeners. */
  private sessionUpdateListeners = new Set<SessionUpdateListener>();

  /** Registered raw Axon event listeners (fired before JSON-RPC translation). */
  private axonEventListeners: ListenerSet<AxonEventListener>;

  /** Registered timeline event listeners. */
  private timelineEventListeners: ListenerSet<TimelineEventListener<ACPTimelineEvent>>;

  /** Error sink for listener exceptions and stream parse failures. */
  private handleError: (error: unknown) => void;

  /** Optional user-provided permission handler; when unset the built-in auto-approve logic is used. */
  private handlePermission:
    | ((params: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | undefined;

  /** Optional teardown callback invoked by {@link disconnect}. */
  private disconnectFn: (() => void | Promise<void>) | undefined;

  private log: LogFn;

  /**
   * Creates a new ACP connection over the given Axon channel and devbox.
   *
   * The constructor does **not** open an SSE subscription. Call
   * {@link connect} to open the transport, then {@link initialize}
   * to negotiate protocol capabilities.
   *
   * @param axon    - The Axon channel to communicate over (from `@runloop/api-client`).
   * @param devbox  - The Runloop devbox hosting the ACP agent.
   * @param options - Optional configuration for error handling, permissions, and lifecycle hooks.
   */
  constructor(axon: Axon, devbox: Devbox, options?: ACPAxonConnectionOptions) {
    this.axonId = axon.id;
    this.devboxId = devbox.id;
    this.axon = axon;
    this.options = options ?? {};
    this.abortController = new AbortController();
    this.log = makeLogger("acp-sdk", options?.verbose ?? false);
    this.handleError = options?.onError ?? makeDefaultOnError("ACPAxonConnection");
    this.handlePermission = options?.requestPermission;
    this.disconnectFn = options?.onDisconnect;
    this.axonEventListeners = new ListenerSet<AxonEventListener>(this.handleError);
    this.timelineEventListeners = new ListenerSet<TimelineEventListener<ACPTimelineEvent>>(
      this.handleError,
    );
    this.log("constructor", `axon=${axon.id} devbox=${this.devboxId}`);
  }

  /**
   * Opens the Axon SSE subscription and creates the underlying
   * `ClientSideConnection`. Must be called before {@link initialize}.
   *
   * When `replay` is `true` (the default), queries the axon for the
   * current head sequence and replays all events up to that point
   * without invoking handlers. Unresolved permission requests are
   * dispatched to handlers after replay completes.
   *
   * @throws {ConnectionStateError} If already connected (`code: "already_connected"`).
   * @throws If both `replay` and `afterSequence` are set.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new ConnectionStateError(
        "already_connected",
        "Already connected. Call disconnect() before reconnecting.",
      );
    }

    const replayTargetSequence = await resolveReplayTarget(this.axon, this.options, this.log);

    const verbose = this.options.verbose ?? false;
    const stream = axonStream({
      axon: this.axon,
      signal: this.abortController.signal,
      onAxonEvent: (ev) => {
        this.axonEventListeners.emit(ev);
        this.emitTimelineEvent(ev);
      },
      onError: this.handleError,
      log: verbose ? (tag, ...args) => this.log(tag, ...args) : undefined,
      afterSequence: this.options.afterSequence,
      replayTargetSequence,
    });

    const customCreateClient = this.options.createClient;
    this._protocol = new ClientSideConnection(
      customCreateClient ? (agent) => customCreateClient(agent) : () => this.createClient(),
      stream,
    );
    this.connected = true;
    this.log("connect", "connected");
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    }
  }

  // ---------------------------------------------------------------------------
  // Proxied Agent methods
  // ---------------------------------------------------------------------------

  /**
   * Runs the **ACP `initialize` protocol step** (capability negotiation with the agent).
   *
   * This is **required once** after {@link connect} on first startup of the agent session:
   * the transport is already open after `connect()`, but the ACP wire protocol expects
   * `initialize` before `newSession`, `prompt`, or other agent methods.
   *
   * @param params - Protocol version, client info, and capability negotiation fields.
   * @returns The agent's supported capabilities and protocol version.
   * @throws {InitializationError} If the handshake fails (wraps the underlying cause).
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.ensureConnected();
    try {
      return await this.protocol.initialize(params);
    } catch (err) {
      const wrapped = toACPError(err);
      throw new InitializationError(wrapped.message, { cause: wrapped });
    }
  }

  /**
   * Creates a new conversation session with the agent.
   *
   * @param params - Session configuration including working directory and MCP servers.
   * @returns The newly created session ID and metadata.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.ensureConnected();
    return this.protocol.newSession(params).catch(rethrowAsACPError);
  }

  /**
   * Loads an existing session to resume a previous conversation.
   *
   * @param params - Identifies the session to load.
   * @returns The restored session metadata.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.ensureConnected();
    return this.protocol.loadSession(params).catch(rethrowAsACPError);
  }

  /**
   * Lists existing sessions from the agent.
   *
   * @param params - Optional filter criteria for the session list.
   * @returns An array of session summaries.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.ensureConnected();
    return this.protocol.listSessions(params).catch(rethrowAsACPError);
  }

  /**
   * Sends a user prompt within a session and processes the agent's turn.
   *
   * The returned promise resolves when the agent acknowledges the prompt,
   * but session update notifications (tokens, tool calls, messages) may
   * continue arriving after resolution. Listen via {@link onSessionUpdate}
   * to capture the full turn.
   *
   * @param params - Session ID and prompt content.
   * @returns The agent's prompt acknowledgement.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response
   *   (e.g. quota exhausted, auth required).
   */
  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.ensureConnected();
    return this.protocol.prompt(params).catch(rethrowAsACPError);
  }

  /**
   * Cancels an ongoing prompt turn for a session.
   *
   * @param params - Identifies the session whose turn should be cancelled.
   */
  cancel(params: CancelNotification): Promise<void> {
    this.ensureConnected();
    return this.protocol.cancel(params).catch(rethrowAsACPError);
  }

  /**
   * Authenticates using a method advertised during initialization.
   *
   * @param params - Authentication method and credentials.
   * @returns The authentication result.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.ensureConnected();
    return this.protocol.authenticate(params).catch(rethrowAsACPError);
  }

  /**
   * Sets the operational mode for a session (e.g. "ask", "code").
   *
   * @param params - Session ID and the target mode.
   * @returns Confirmation of the mode change.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    this.ensureConnected();
    return this.protocol.setSessionMode(params).catch(rethrowAsACPError);
  }

  /**
   * Sets a configuration option for a session.
   *
   * @param params - Session ID, option key, and new value.
   * @returns Confirmation of the configuration change.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.ensureConnected();
    return this.protocol.setSessionConfigOption(params).catch(rethrowAsACPError);
  }

  /**
   * Sends an arbitrary extension request not part of the ACP spec.
   *
   * @param method - The custom method name.
   * @param params - Arbitrary key-value payload for the request.
   * @returns The agent's response payload.
   * @throws {ACPRequestError} If the agent returns a JSON-RPC error response.
   */
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureConnected();
    return this.protocol.extMethod(method, params).catch(rethrowAsACPError);
  }

  /**
   * Sends an arbitrary extension notification not part of the ACP spec.
   * Unlike {@link extMethod}, notifications do not expect a response.
   *
   * @param method - The custom method name.
   * @param params - Arbitrary key-value payload for the notification.
   */
  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.ensureConnected();
    return this.protocol.extNotification(method, params).catch(rethrowAsACPError);
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  /**
   * Registers a listener for `session/update` notifications from the agent.
   *
   * @param listener - Callback invoked with the session ID and the update payload
   *   each time the agent emits a session update (message chunks, tool calls, etc.).
   * @returns An unsubscribe function that removes the listener.
   */
  onSessionUpdate(listener: SessionUpdateListener): () => void {
    this.sessionUpdateListeners.add(listener);
    return () => {
      this.sessionUpdateListeners.delete(listener);
    };
  }

  /**
   * Registers a listener for every Axon event (before JSON-RPC translation).
   * Useful for debugging, observability, and building event viewers.
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
   * - `acp_protocol` — a known ACP protocol event (agent or client method)
   * - `system` — a broker system event (`turn.started`, `turn.completed`,
   *   `turn.failed`, `broker.error`)
   * - `unknown` — anything else
   *
   * For a pull-based alternative, see {@link receiveTimelineEvents}.
   * Both APIs deliver the same events; choose whichever fits your
   * consumption pattern.
   *
   * @param listener - Callback invoked with each {@link ACPTimelineEvent}.
   * @returns An unsubscribe function that removes the listener.
   */
  onTimelineEvent(listener: TimelineEventListener<ACPTimelineEvent>): () => void {
    return this.timelineEventListeners.add(listener);
  }

  /**
   * Publishes a custom event to the Axon channel.
   *
   * The event will appear in the SSE stream and be classified by the
   * timeline (typically as `kind: "unknown"` unless the `event_type`
   * matches a known ACP protocol method).
   *
   * @param params - The event to publish (same shape as `Axon.publish()`).
   * @returns The publish result with sequence number and timestamp.
   */
  async publish(params: AxonPublishParams): Promise<PublishResultView> {
    return this.axon.publish(params);
  }

  /**
   * Async generator that yields classified timeline events (pull API).
   *
   * Mirrors the pull-based pattern of `receiveMessages()` in the Claude
   * module. The generator completes when the connection is disconnected
   * or the abort signal fires.
   *
   * For a push-based alternative, see {@link onTimelineEvent}.
   * Both APIs deliver the same events; choose whichever fits your
   * consumption pattern.
   *
   * @returns An async generator of {@link ACPTimelineEvent}.
   */
  async *receiveTimelineEvents(): AsyncGenerator<ACPTimelineEvent, void, undefined> {
    yield* timelineEventGenerator<ACPTimelineEvent>(
      (listener) => this.onTimelineEvent(listener),
      this.abortController.signal,
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * AbortSignal that fires when the connection closes.
   *
   * @returns The underlying protocol's abort signal.
   */
  get signal(): AbortSignal {
    return this.protocol.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   *
   * @returns A promise that settles once the protocol connection is fully closed.
   */
  get closed(): Promise<void> {
    return this.protocol.closed;
  }

  /**
   * Aborts the underlying SSE stream without clearing registered listeners.
   *
   * Unlike {@link disconnect}, this does not run {@link ACPAxonConnectionOptions.onDisconnect}
   * and does not reset {@link connect} state. Prefer {@link disconnect} followed by
   * {@link connect} for a full teardown and reconnect on the same instance.
   */
  abortStream(): void {
    this.abortController.abort();
  }

  /**
   * Aborts the Axon stream, resets protocol state so {@link connect} can be
   * called again, and runs the `onDisconnect` callback (e.g. devbox teardown)
   * if one was provided.
   *
   * User-registered listeners ({@link onSessionUpdate}, {@link onAxonEvent},
   * {@link onTimelineEvent}) are **preserved** across disconnect/reconnect.
   *
   * @returns Resolves once the `onDisconnect` callback (if any) completes.
   */
  async disconnect(): Promise<void> {
    if (!this.connected && !this._protocol) {
      return;
    }
    this.log("disconnect", "disconnecting");
    this.abortStream();
    this.connected = false;
    this._protocol = null;
    this.abortController = new AbortController();
    await runDisconnectHook(this.disconnectFn, this.log, this.handleError);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Classifies a raw Axon event and emits it to timeline listeners.
   */
  private emitTimelineEvent(ev: AxonEventView): void {
    const event = classifyACPAxonEvent(ev);
    this.timelineEventListeners.emit(event);
  }

  /**
   * Builds the ACP `Client` callbacks handed to the `ClientSideConnection`.
   *
   * The returned object handles:
   * - `requestPermission` — delegates to the user-provided handler or
   *   falls back to auto-approve (`allow_always` > `allow_once` > first option).
   * - `sessionUpdate` — fans out session update notifications to all
   *   registered {@link onSessionUpdate} listeners.
   *
   * @returns A `Client` implementation wired to this connection's listeners and options.
   */
  private createClient(): Client {
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        if (this.handlePermission) {
          return this.handlePermission(params);
        }

        const option =
          params.options.find((o: { kind: string }) => o.kind === "allow_always") ??
          params.options.find((o: { kind: string }) => o.kind === "allow_once") ??
          params.options[0];

        if (option) {
          return {
            outcome: { outcome: "selected", optionId: option.optionId },
          };
        }
        return { outcome: { outcome: "cancelled" } };
      },

      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const sessionId = params.sessionId ?? null;
        const update = params.update;
        for (const listener of [...this.sessionUpdateListeners]) {
          try {
            listener(sessionId, update);
          } catch (err) {
            this.handleError(err);
          }
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Timeline event classification
// ---------------------------------------------------------------------------

/**
 * Classifies a raw Axon event into an {@link ACPTimelineEvent}.
 *
 * Classification rules:
 * 1. `SYSTEM_EVENT` with `turn.started` / `turn.completed` / `turn.failed` /
 *    `broker.error` -> `system`
 * 2. Known ACP protocol `event_type` (agent or client method) -> `acp_protocol`
 * 3. Everything else -> `unknown`
 *
 * @category Timeline
 */
export const classifyACPAxonEvent = createClassifier<ACPProtocolTimelineEvent>({
  label: "classifyACPAxonEvent",
  isProtocolEventType: isACPProtocolEventType,
  toProtocolEvent: (data, ev) =>
    ({
      kind: "acp_protocol",
      eventType: ev.event_type,
      data,
      axonEvent: ev,
    }) as ACPProtocolTimelineEvent,
});

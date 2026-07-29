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
import { classifyPiAxonEvent } from "./classify-pi-axon-event.js";
import type {
  ImageContent,
  PiCommand,
  PiCommandFrame,
  PiResponse,
  PiSessionState,
  SessionChange,
  StreamingBehavior,
} from "./protocol/index.js";
import { PI_RESPONSE_EVENT_TYPE } from "./protocol/index.js";
import { PiAxonTransport, type PiFrame, type PiTransport } from "./transport.js";
import type { PiTimelineEvent } from "./types.js";

/** The Pi event that ends an accepted turn. */
const AGENT_SETTLED = "agent_settled";
const GET_STATE_COMMAND = "get_state";
const PROMPT_COMMAND = "prompt";

/** Per-prompt options for {@link PiAxonConnection.send}. @category Configuration */
export interface PiSendOptions {
  images?: ImageContent[];
  /**
   * Required by Pi to accept a prompt while a turn is already streaming.
   * Prefer {@link PiAxonConnection.steer} or
   * {@link PiAxonConnection.followUp}, which do not reopen a broker turn.
   */
  streamingBehavior?: StreamingBehavior;
}

/**
 * A Pi command that came back with `success: false`.
 * Carries the command name and Pi's own `error` string.
 * @category Errors
 */
export class PiCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly error?: string,
  ) {
    super(message);
    this.name = "PiCommandError";
  }
}

/** Options for a native Pi connection. @category Configuration */
export interface PiAxonConnectionOptions extends BaseConnectionOptions {
  requestTimeoutMs?: number;
}

/**
 * Native Pi RPC connection over an Axon channel.
 *
 * Unlike ACP, Claude and Codex, Pi has **no handshake**: there is no
 * `initialize()` to call. {@link connect} is enough. Read session identity
 * with {@link getState} instead.
 *
 * @example
 * ```ts
 * await connection.connect();
 * await connection.send("Explain this repository");
 * for await (const frame of connection.receiveTurn()) console.log(frame);
 * ```
 * @category Connection
 */
export class PiAxonConnection {
  readonly axonId: string;
  readonly devboxId: string;
  private _sessionId: string | undefined;
  private _sessionFile: string | undefined;
  private transport?: PiTransport;
  private running = false;
  private closed = false;
  private fatal = false;
  private everConnected = false;
  private aborted = false;
  private suppressAutoReconnect = false;
  private counter = 0;
  private pending = new PendingRequestMap<string, unknown>();
  private messageQueue: AsyncMessageQueue<PiFrame>;
  private abortController = new AbortController();
  private readonly axonListeners: ListenerSet<AxonEventListener>;
  private readonly timelineListeners: ListenerSet<TimelineEventListener<PiTimelineEvent>>;
  private readonly handleError: (error: unknown) => void;
  private readonly log;
  constructor(
    private readonly axon: Axon,
    devbox: Devbox,
    private readonly options: PiAxonConnectionOptions = {},
  ) {
    this.axonId = axon.id;
    this.devboxId = devbox.id;
    this.handleError = options.onError ?? makeDefaultOnError("PiAxonConnection");
    this.log = makeLogger("pi-sdk", options.verbose ?? false);
    this.axonListeners = new ListenerSet(this.handleError);
    this.timelineListeners = new ListenerSet(this.handleError);
    this.messageQueue = new AsyncMessageQueue(1000, (size) =>
      this.handleError(
        `[PiAxonConnection] Message queue has ${size} buffered messages. ` +
          "Ensure you are consuming messages via receiveAgentEvents() or receiveTurn().",
      ),
    );
  }
  get isConnected(): boolean {
    return this.running && !this.closed;
  }
  get isDisconnected(): boolean {
    return this.everConnected && !this.running;
  }
  /**
   * Pi's session id, captured from `get_state` acknowledgements. The broker
   * issues one after every turn, so this populates without an explicit
   * {@link getState} call — including from replayed history.
   */
  get sessionId(): string | undefined {
    return this._sessionId;
  }
  /**
   * The session transcript path Pi writes to, captured from `get_state`
   * acknowledgements. Pass it to {@link switchSession} to restore a session.
   */
  get sessionFile(): string | undefined {
    return this._sessionFile;
  }
  /**
   * Opens the SSE transport and starts its read loop. There is no handshake
   * to follow it — send a prompt straight away.
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
    this.transport = new PiAxonTransport(this.axon, {
      verbose: this.options.verbose,
      afterSequence: this.options.afterSequence,
      replayTargetSequence,
      onAxonEvent: (event) => {
        this.axonListeners.emit(event);
        this.timelineListeners.emit(classifyPiAxonEvent(event));
        // Session identity is recovered here rather than in route() so that
        // acknowledgements inside the replay window count too.
        if (isFromAgent(event) && event.event_type === PI_RESPONSE_EVENT_TYPE && event.payload)
          try {
            this.captureSessionState(JSON.parse(event.payload) as PiFrame);
          } catch {
            // Classification reports malformed events through the timeline.
          }
      },
    });
    await this.transport.connect();
    this.running = true;
    this.everConnected = true;
    this.readLoop();
  }
  /** Aborts only the current SSE stream, preserving listeners. */
  abortStream(): void {
    this.aborted = true;
    this.transport?.abortStream();
  }
  /** Gracefully closes the transport and rejects pending commands. Idempotent. */
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
    await runDisconnectHook(this.options.onDisconnect, this.log, this.handleError);
    this.closed = false;
  }
  /** Registers a raw Axon event listener. */
  onAxonEvent(listener: AxonEventListener): () => void {
    return this.axonListeners.add(listener);
  }
  /** Registers a classified Pi timeline listener. */
  onTimelineEvent(listener: TimelineEventListener<PiTimelineEvent>): () => void {
    return this.timelineListeners.add(listener);
  }
  /** Pull-based classified timeline event stream. */
  async *receiveTimelineEvents(): AsyncGenerator<PiTimelineEvent> {
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
  private captureSessionState(frame: PiFrame): void {
    const ack = frame as Partial<PiResponse>;
    if (ack.type !== PI_RESPONSE_EVENT_TYPE || ack.command !== GET_STATE_COMMAND || !ack.success)
      return;
    const state = ack.data as Partial<PiSessionState> | undefined;
    if (typeof state?.sessionId === "string") this._sessionId = state.sessionId;
    if (typeof state?.sessionFile === "string") this._sessionFile = state.sessionFile;
  }
  private route(frame: PiFrame): void {
    if (frame.type === PI_RESPONSE_EVENT_TYPE) {
      const ack = frame as Partial<PiResponse>;
      this.captureSessionState(frame);
      // Acks the SDK did not ask for — the adapter's own `broker-N` commands,
      // or an id-less `get_state` — fall through to the queue rather than
      // vanishing.
      const settled =
        typeof ack.id === "string" &&
        (ack.success
          ? this.pending.resolve(ack.id, ack.data)
          : this.pending.reject(ack.id, toCommandError(ack)));
      // A rejected prompt completes the broker turn, so it stays visible to
      // receiveTurn() even though send() already surfaced it as an error.
      if (settled && !(ack.command === PROMPT_COMMAND && !ack.success)) return;
    }
    this.messageQueue.push(frame);
  }
  /**
   * Publishes a Pi command and awaits its acknowledgement, correlated on an
   * SDK-stamped `id`.
   * @throws {@link ConnectionStateError} with `terminated` or `not_connected`.
   * @throws {@link PiCommandError} If Pi answers `success: false`.
   */
  private async request<T>(
    command: PiCommand | PiCommandFrame,
    timeoutMs = this.options.requestTimeoutMs ?? 60_000,
  ): Promise<T> {
    if (this.fatal)
      throw new ConnectionStateError(
        "terminated",
        "This connection hit a fatal broker error and cannot be reused. Create a new instance.",
      );
    if (!this.transport?.isReady())
      throw new ConnectionStateError("not_connected", "Not connected. Call connect() first.");
    const id = command.id ?? `pi-sdk-${++this.counter}-${Math.random().toString(36).slice(2, 10)}`;
    const promise = this.pending.create(id, timeoutMs, `Command timeout: ${command.type}`);
    try {
      await this.transport.write({ ...command, id });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return (await promise) as T;
  }
  /**
   * Starts a turn with a `prompt` command.
   *
   * **Resolves on acceptance, not completion.** Pi's ack means only that the
   * prompt was accepted; the turn ends later at `agent_settled`. Await
   * {@link receiveTurn} (or the `turn.completed` system event) for the
   * response. Pi rejects a prompt sent while it is already streaming unless
   * {@link PiSendOptions.streamingBehavior} is set.
   * @throws {@link PiCommandError} If Pi rejects the prompt.
   */
  async send(message: string, options?: PiSendOptions): Promise<void> {
    await this.request({ type: PROMPT_COMMAND, message, ...options });
  }
  /** Steers the in-flight turn without reopening a broker turn. */
  async steer(message: string, images?: ImageContent[]): Promise<void> {
    await this.request({ type: "steer", message, ...(images ? { images } : {}) });
  }
  /** Queues a follow-up message without reopening a broker turn. */
  async followUp(message: string, images?: ImageContent[]): Promise<void> {
    await this.request({ type: "follow_up", message, ...(images ? { images } : {}) });
  }
  /** Aborts the in-flight turn. */
  async interrupt(): Promise<void> {
    await this.request({ type: "abort" });
  }
  /** Reads Pi's session state — the supported way to get `sessionFile`. */
  async getState(): Promise<PiSessionState> {
    return this.request<PiSessionState>({ type: GET_STATE_COMMAND });
  }
  /** Starts a fresh Pi session, optionally branching from an existing one. */
  async newSession(parentSession?: string): Promise<SessionChange> {
    return this.request<SessionChange>({
      type: "new_session",
      ...(parentSession != null ? { parentSession } : {}),
    });
  }
  /** Restores a persisted session from its transcript path. */
  async switchSession(sessionPath: string): Promise<SessionChange> {
    return this.request<SessionChange>({ type: "switch_session", sessionPath });
  }
  /**
   * Sends any Pi command this class does not wrap (`set_model`, `compact`,
   * `bash`, `get_messages`, `export_html`, …) and returns its ack `data`.
   */
  async command<T = unknown>(frame: PiCommandFrame): Promise<T> {
    return this.request<T>(frame);
  }
  /** Yields agent frames until the connection closes. */
  async *receiveAgentEvents(): AsyncGenerator<PiFrame> {
    while (true) {
      // Delegate closed-state handling to the queue so frames buffered before
      // a fatal error or stream end remain drainable; disconnect() clears them.
      const value = await this.messageQueue.next();
      if (!value) return;
      yield value;
    }
  }
  /**
   * Yields one turn and terminates at `agent_settled` — **not** at
   * `agent_end`, which Pi may follow with an automatic retry
   * (`willRetry: true`). Also terminates on a rejected `prompt`, which
   * completes the turn immediately.
   */
  async *receiveTurn(): AsyncGenerator<PiFrame> {
    for await (const frame of this.receiveAgentEvents()) {
      yield frame;
      if (frame.type === AGENT_SETTLED) return;
      const ack = frame as Partial<PiResponse>;
      if (ack.type === PI_RESPONSE_EVENT_TYPE && ack.command === PROMPT_COMMAND && !ack.success)
        return;
    }
  }
  async publish(params: AxonPublishParams): Promise<PublishResultView> {
    return this.axon.publish(params);
  }
}

function toCommandError(ack: Partial<PiResponse>): PiCommandError {
  const command = ack.command ?? "unknown";
  return new PiCommandError(ack.error ?? `Pi rejected the ${command} command`, command, ack.error);
}

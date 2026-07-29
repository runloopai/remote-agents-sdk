import { RunloopSDK } from "@runloop/api-client";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { PiAxonConnection, type PiSessionState } from "@runloop/remote-agents-sdk/pi";
import type { AxonEventView } from "@runloop/remote-agents-sdk/shared";
import { HttpError } from "./http-errors.ts";
import type { WsBroadcaster, WsEvent, BaseWsEvent } from "./ws.ts";

export interface PiStartOptions {
  blueprintName?: string;
  launchCommands?: string[];
  /** Extra CLI args for the `pi` binary, appended after the defaults. */
  launchArgs?: string[];
  workingDir?: string;
  model?: string;
}

// Provider/model id from the models.json written at launch. GLM-5.2 runs on
// Runloop's dedicated Nebius endpoint.
const DEFAULT_PI_MODEL = "nebius/glm-5.2";

// Pi resolves custom providers from ~/.pi/agent/models.json. `apiKey` keeps the
// literal "$NEBIUS_API_KEY" because Pi interpolates $ENV_VAR itself, so the key
// never lands in the file — only the env var name does. python3's json.dumps
// handles any characters in the base URL safely; hand-assembling JSON in shell
// would break on quotes and backslashes.
const WRITE_PI_MODELS_CMD =
  'mkdir -p "$HOME/.pi/agent" && umask 077 && python3 -c \'import json, os; print(json.dumps({"providers": {"nebius": {"baseUrl": os.environ["NEBIUS_BASE_URL"], "api": "openai-completions", "apiKey": "$NEBIUS_API_KEY", "models": [{"id": "glm-5.2", "name": "GLM 5.2 (Nebius)", "reasoning": True, "contextWindow": 262144, "maxTokens": 32000}], "compat": {"thinkingFormat": "zai"}}}}))\' > "$HOME/.pi/agent/models.json"';

export class PiConnectionManager {
  connection: PiAxonConnection | null = null;
  axonEvents: AxonEventView[] = [];

  private axon: Axon | null = null;
  private devbox: Devbox | null = null;

  constructor(
    private ws: WsBroadcaster,
    private agentId: string,
  ) {}

  private tag(event: BaseWsEvent): WsEvent {
    return { ...event, agentId: this.agentId } as WsEvent;
  }

  async start(opts: PiStartOptions) {
    const apiKey = process.env.RUNLOOP_API_KEY;
    const baseUrl = process.env.RUNLOOP_BASE_URL;
    const nebiusApiKey = process.env.NEBIUS_API_KEY;
    const nebiusBaseUrl = process.env.NEBIUS_BASE_URL;

    if (!apiKey) throw new HttpError(401, "RUNLOOP_API_KEY not set in server .env");
    if (!nebiusApiKey) throw new HttpError(401, "NEBIUS_API_KEY not set in server .env");
    if (!nebiusBaseUrl) throw new HttpError(401, "NEBIUS_BASE_URL not set in server .env");

    const sdk = new RunloopSDK({
      bearerToken: apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Creating Axon channel..." }));
    const axon = await sdk.axon.create({ name: "combined-app-pi" });
    this.axon = axon;

    // The broker accepts protocol "pi_json", but the published
    // @runloop/api-client mount types don't include it yet.
    const brokerProtocol: "acp" | "claude_json" | "pi_json" = "pi_json";

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Provisioning sandbox..." }));
    const devbox = await sdk.devbox.create({
      name: "combined-app-pi",
      blueprint_name: opts.blueprintName ?? "axon-agents",
      mounts: [
        {
          type: "broker_mount" as const,
          axon_id: axon.id,
          protocol: brokerProtocol as "acp" | "claude_json",
          agent_binary: "/usr/local/bin/pi",
          // `--mode rpc` and `--session-dir` are broker-owned: the broker
          // appends both, and `--session-dir` must stay on the durable state
          // root for resume to survive devbox snapshots. Never set either here.
          launch_args: ["--model", opts.model ?? DEFAULT_PI_MODEL, ...(opts.launchArgs ?? [])],
          ...(opts.workingDir ? { working_directory: opts.workingDir } : {}),
        },
      ],
      environment_variables: {
        NEBIUS_API_KEY: nebiusApiKey,
        NEBIUS_BASE_URL: nebiusBaseUrl,
      },
      launch_parameters: {
        launch_commands: [WRITE_PI_MODELS_CMD, ...(opts.launchCommands ?? [])],
        lifecycle: {
          after_idle: {
            idle_time_seconds: 60,
            on_idle: "suspend",
          },
          resume_triggers: {
            axon_event: true,
          },
        },
      },
    });

    this.devbox = devbox;

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Connecting to Pi..." }));
    // Pi has no handshake, so connect() is the whole setup — there is no
    // initialize() to run here.
    const conn = this.wireConnection(axon, devbox, {
      onDisconnect: async () => {
        await devbox.shutdown();
      },
    });
    await conn.connect();

    return {
      devboxId: devbox.id,
      axonId: axon.id,
      sessionId: conn.sessionId ?? null,
      runloopUrl: baseUrl ?? "https://platform.runloop.ai",
    };
  }

  private wireConnection(
    axon: Axon,
    devbox: Devbox,
    opts?: { onDisconnect?: () => Promise<void>; afterSequence?: number },
  ): PiAxonConnection {
    // A fresh wire replays full history for the client; a resume-from-sequence
    // rewire keeps the accumulated events so the UI sees no duplicates.
    if (opts?.afterSequence == null) this.axonEvents = [];

    const conn = new PiAxonConnection(axon, devbox, {
      verbose: true,
      ...(opts?.afterSequence != null ? { afterSequence: opts.afterSequence, replay: false } : {}),
      ...(opts?.onDisconnect ? { onDisconnect: opts.onDisconnect } : {}),
    });

    this.connection = conn;

    conn.onAxonEvent((ev) => {
      this.axonEvents.push(ev);
    });

    conn.onTimelineEvent((ev) => {
      this.ws.broadcast(this.tag({ type: "timeline_event", event: ev }));
    });

    return conn;
  }

  async subscribe(): Promise<void> {
    if (!this.axon || !this.devbox) throw new Error("No axon/devbox — agent not started");
    if (this.connection) {
      this.connection.abortStream();
    }
    const conn = this.wireConnection(this.axon, this.devbox);
    await conn.connect();
  }

  /**
   * Starts a turn. Resolves when Pi *accepts* the prompt, not when the turn
   * finishes — the UI tracks completion from the timeline events instead.
   */
  async send(prompt: string): Promise<void> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.ensureLiveConnection();
    await this.connection.send(prompt);
  }

  /**
   * Queues a message against the turn already in flight: `steer` redirects it,
   * `follow_up` runs after it settles. Neither starts a turn, so neither goes
   * through the broker's turn tracking.
   */
  async queue(message: string, mode: "steer" | "follow_up"): Promise<void> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.ensureLiveConnection();
    if (mode === "steer") {
      await this.connection.steer(message);
    } else {
      await this.connection.followUp(message);
    }
  }

  /** Pi's session snapshot: model, streaming flag, `sessionId`, `sessionFile`. */
  async getState(): Promise<PiSessionState> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.ensureLiveConnection();
    return this.connection.getState();
  }

  /**
   * Re-wires the connection if its SSE stream silently died (the SDK retries
   * a dropped stream once per connection lifetime, so a long idle/suspended
   * devbox can outlive it). Resumes from the last seen sequence so previously
   * broadcast events are not replayed to the client.
   */
  private async ensureLiveConnection(): Promise<void> {
    if (!this.connection || !this.connection.isDisconnected) return;
    if (!this.axon || !this.devbox) throw new HttpError(400, "Not connected");
    console.log("[pi] event stream dropped — re-wiring connection before send");
    const afterSequence = this.axonEvents.at(-1)?.sequence;
    const conn = this.wireConnection(this.axon, this.devbox, {
      ...(afterSequence != null ? { afterSequence } : {}),
    });
    await conn.connect();
  }

  async interrupt(): Promise<void> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.connection.interrupt();
  }

  async shutdown(): Promise<void> {
    if (this.connection) {
      await this.connection.disconnect();
    }
    this.connection = null;
    this.axon = null;
    this.devbox = null;
    this.axonEvents = [];
  }
}

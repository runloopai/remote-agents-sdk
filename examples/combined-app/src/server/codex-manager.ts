import { RunloopSDK } from "@runloop/api-client";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import {
  CodexAxonConnection,
  type ApprovalRequest,
  type InputItem,
} from "@runloop/remote-agents-sdk/codex";
import type { AxonEventView } from "@runloop/remote-agents-sdk/shared";
import { HttpError } from "./http-errors.ts";
import type { WsBroadcaster, WsEvent, BaseWsEvent } from "./ws.ts";

export interface CodexStartOptions {
  blueprintName?: string;
  launchCommands?: string[];
  /** Extra CLI args for the `codex` binary, appended after the defaults. */
  launchArgs?: string[];
  workingDir?: string;
  systemPrompt?: string;
  model?: string;
  autoApprovePermissions?: boolean;
}

// Full-auto defaults: `--dangerously-bypass-approvals-and-sandbox` is a
// `codex exec` flag the app-server doesn't accept; these config overrides are
// its app-server equivalent (no approval traffic, unsandboxed execution).
// Skipped when interactive approvals are on so the UI approval flow still fires.
const FULL_AUTO_LAUNCH_ARGS = [
  "-c",
  "approval_policy=never",
  "-c",
  "sandbox_mode=danger-full-access",
];

// Give the user plenty of time to answer an approval in the UI before the
// SDK's handler timeout declines it.
const APPROVAL_TIMEOUT_MS = 600_000;

// Codex reads credentials from ~/.codex/auth.json, not the OPENAI_API_KEY env
// var, so a launch command materializes the file from $CODEX_AUTH_JSON before
// the broker spawns `codex app-server`.
const WRITE_CODEX_AUTH_CMD =
  'mkdir -p "$HOME/.codex" && umask 077 && printf \'%s\' "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"';

/**
 * Resolve the auth.json contents to install on the devbox. `CODEX_AUTH_JSON`
 * (full file contents, e.g. `$(cat ~/.codex/auth.json)` for ChatGPT-plan
 * auth) wins; otherwise an api-key-mode file is built from `OPENAI_API_KEY`.
 */
function resolveCodexAuthJson(): string | undefined {
  if (process.env.CODEX_AUTH_JSON) {
    try {
      // Validate and normalize to a single line so the devbox writes exactly
      // what Codex expects, and a bad paste fails here rather than in the box.
      return JSON.stringify(JSON.parse(process.env.CODEX_AUTH_JSON));
    } catch {
      throw new HttpError(400, "CODEX_AUTH_JSON is not valid JSON");
    }
  }
  if (process.env.OPENAI_API_KEY)
    return JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  return undefined;
}

export class CodexConnectionManager {
  connection: CodexAxonConnection | null = null;
  axonEvents: AxonEventView[] = [];

  private axon: Axon | null = null;
  private devbox: Devbox | null = null;
  private storedOptions: CodexStartOptions = {};
  // The initialize handshake is per app-server *process*, which outlives our
  // client connections (including suspend/resume). Run it once per devbox and
  // skip it on rewires so navigation doesn't publish redundant handshakes.
  private appServerInitialized = false;
  // Sticky turn/start overrides set by slash commands (/model, /effort).
  // The protocol applies them "for this turn and subsequent turns", but we
  // resend them every turn so they survive connection rewires.
  private turnOverrides: Record<string, unknown> = {};
  // Native collaboration mode (/plan, /default), sent as turn/start's
  // collaborationMode param. null = never set; let the app-server default.
  private modeKind: "plan" | "default" | null = null;
  // Live thread settings mirrored from thread/settings/updated notifications;
  // collaborationMode.settings requires a model, so we echo the thread's own.
  private threadSettings: { model?: string; effort?: string | null } = {};
  private pendingApprovals = new Map<
    string,
    { request: ApprovalRequest; resolve: (approve: boolean) => void }
  >();

  constructor(
    private ws: WsBroadcaster,
    private agentId: string,
  ) {}

  private tag(event: BaseWsEvent): WsEvent {
    return { ...event, agentId: this.agentId } as WsEvent;
  }

  async start(opts: CodexStartOptions) {
    const apiKey = process.env.RUNLOOP_API_KEY;
    const baseUrl = process.env.RUNLOOP_BASE_URL;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const codexAuthJson = resolveCodexAuthJson();

    if (!apiKey) throw new HttpError(401, "RUNLOOP_API_KEY not set in server .env");
    if (!codexAuthJson)
      throw new HttpError(401, "Neither OPENAI_API_KEY nor CODEX_AUTH_JSON set in server .env");

    const sdk = new RunloopSDK({
      bearerToken: apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Creating Axon channel..." }));
    const axon = await sdk.axon.create({ name: "combined-app-codex" });
    this.axon = axon;

    // The broker accepts protocol "codex_json", but the published
    // @runloop/api-client mount types don't include it yet.
    const brokerProtocol: "acp" | "claude_json" | "codex_json" = "codex_json";

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Provisioning sandbox..." }));
    const devbox = await sdk.devbox.create({
      name: "combined-app-codex",
      blueprint_name: opts.blueprintName ?? "axon-agents",
      mounts: [
        {
          type: "broker_mount" as const,
          axon_id: axon.id,
          protocol: brokerProtocol as "acp" | "claude_json",
          agent_binary: "/home/user/.local/bin/codex",
          launch_args: [
            ...(opts.autoApprovePermissions !== false ? FULL_AUTO_LAUNCH_ARGS : []),
            ...(opts.launchArgs ?? []),
          ],
          ...(opts.workingDir ? { working_directory: opts.workingDir } : {}),
        },
      ],
      environment_variables: {
        CODEX_AUTH_JSON: codexAuthJson,
        ...(openaiApiKey ? { OPENAI_API_KEY: openaiApiKey } : {}),
      },
      launch_parameters: {
        launch_commands: [WRITE_CODEX_AUTH_CMD, ...(opts.launchCommands ?? [])],
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
    this.storedOptions = opts;

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Connecting to Codex..." }));
    const conn = this.wireConnection(axon, devbox, {
      onDisconnect: async () => { await devbox.shutdown(); },
    });
    await conn.connect();
    await this.initializeOnce(conn);

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Starting thread..." }));
    try {
      await conn.startThread();
    } catch (err) {
      await this.shutdown();
      throw err;
    }

    return {
      devboxId: devbox.id,
      axonId: axon.id,
      threadId: conn.threadId ?? null,
      runloopUrl: baseUrl ?? "https://platform.runloop.ai",
    };
  }

  private wireConnection(
    axon: Axon,
    devbox: Devbox,
    opts?: { onDisconnect?: () => Promise<void>; afterSequence?: number },
  ): CodexAxonConnection {
    // A fresh wire replays full history for the client; a resume-from-sequence
    // rewire keeps the accumulated events so the UI sees no duplicates.
    if (opts?.afterSequence == null) this.axonEvents = [];

    const interactiveApprovals = this.storedOptions.autoApprovePermissions === false;

    const conn = new CodexAxonConnection(axon, devbox, {
      verbose: true,
      ...(opts?.afterSequence != null ? { afterSequence: opts.afterSequence, replay: false } : {}),
      ...(opts?.onDisconnect ? { onDisconnect: opts.onDisconnect } : {}),
      ...(interactiveApprovals ? { requestTimeoutMs: APPROVAL_TIMEOUT_MS } : {}),
      threadStartParams: {
        ...(this.storedOptions.workingDir ? { cwd: this.storedOptions.workingDir } : {}),
        ...(this.storedOptions.model ? { model: this.storedOptions.model } : {}),
        ...(this.storedOptions.systemPrompt
          ? { developerInstructions: this.storedOptions.systemPrompt }
          : {}),
        // Route command/file approvals through the client so the frontend can
        // show a dialog. With auto-approve the SDK's default handlers answer.
        ...(interactiveApprovals ? { approvalPolicy: "on-request" as const } : {}),
      },
    });

    this.connection = conn;

    conn.onAxonEvent((ev) => {
      this.axonEvents.push(ev);
      if (ev.origin === "AGENT_EVENT" && ev.event_type === "thread/settings/updated" && ev.payload) {
        try {
          const frame = JSON.parse(ev.payload) as {
            params?: { threadSettings?: { model?: string; effort?: string | null } };
          };
          const settings = frame.params?.threadSettings;
          if (settings?.model) {
            this.threadSettings = { model: settings.model, effort: settings.effort ?? null };
          }
        } catch {
          // Malformed payloads surface through the normal timeline path.
        }
      }
    });

    conn.onTimelineEvent((ev) => {
      this.ws.broadcast(this.tag({ type: "timeline_event", event: ev }));
    });

    // Without handlers the SDK auto-approves (accept commands/file changes,
    // grant requested permissions for the turn). With interactive approvals,
    // forward command/file requests to the frontend and wait for the answer.
    if (interactiveApprovals) {
      const forward = (request: ApprovalRequest) => this.forwardApproval(request);
      conn.onApprovalRequest("item/commandExecution/requestApproval", forward);
      conn.onApprovalRequest("item/fileChange/requestApproval", forward);
      conn.onApprovalRequest("execCommandApproval", forward);
      conn.onApprovalRequest("applyPatchApproval", forward);
    }

    return conn;
  }

  private forwardApproval(request: ApprovalRequest): Promise<unknown> {
    const requestId = String(request.id);
    console.log(`[approval] ${request.method} request: id=${requestId}`);
    this.ws.broadcast(this.tag({ type: "approval_request", requestId, request }));

    return new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(requestId, {
        request,
        resolve: (approve: boolean) => resolve(buildApprovalResponse(request, approve)),
      });
    });
  }

  resolveApproval(requestId: string, approve: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(approve);
    return true;
  }

  async subscribe(): Promise<void> {
    if (!this.axon || !this.devbox) throw new Error("No axon/devbox — agent not started");
    if (this.connection) {
      this.connection.abortStream();
    }
    const conn = this.wireConnection(this.axon, this.devbox);
    await conn.connect();
    await this.initializeOnce(conn);
  }

  private async initializeOnce(conn: CodexAxonConnection): Promise<void> {
    if (this.appServerInitialized) return;
    await conn.initialize();
    this.appServerInitialized = true;
  }

  async send(prompt: string | InputItem[]): Promise<void> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.ensureLiveConnection();
    const collaborationMode = this.buildCollaborationMode();
    if (Object.keys(this.turnOverrides).length > 0 || collaborationMode) {
      const threadId = this.connection.threadId ?? (await this.connection.startThread());
      const input: InputItem[] =
        typeof prompt === "string" ? [{ type: "text", text: prompt, text_elements: [] }] : prompt;
      await this.connection.request("turn/start", {
        threadId,
        input,
        ...this.turnOverrides,
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      return;
    }
    await this.connection.send(prompt);
  }

  /**
   * Codex's native mode switch: turn/start's collaborationMode param
   * ({ mode: "plan" | "default", settings }). Its settings require a model,
   * so echo the thread's live model/effort (mirrored from
   * thread/settings/updated), letting /model and /effort overrides win.
   */
  private buildCollaborationMode(): Record<string, unknown> | undefined {
    if (!this.modeKind) return undefined;
    const model =
      (this.turnOverrides.model as string | undefined) ??
      this.threadSettings.model ??
      this.storedOptions.model;
    if (!model) return undefined; // no settings seen yet; warned at /plan time
    return {
      mode: this.modeKind,
      settings: {
        model,
        reasoning_effort:
          (this.turnOverrides.effort as string | undefined) ?? this.threadSettings.effort ?? null,
        developer_instructions: null, // null = the mode's built-in instructions
      },
    };
  }

  /**
   * Native slash commands, mapped onto app-server JSON-RPC methods.
   * Returns false when the text is not a recognized command (the caller
   * should send it as a normal prompt).
   */
  async handleSlashCommand(raw: string): Promise<boolean> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    const [cmd = "", ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();

    switch (cmd.toLowerCase()) {
      case "plan":
        this.modeKind = "plan";
        this.note(
          this.buildCollaborationMode()
            ? "Plan mode on: Codex will read and plan, not modify. /default to exit."
            : "Plan mode armed — it applies from your next message (waiting on thread settings for the model).",
        );
        return true;
      case "default":
        this.modeKind = "default";
        this.note("Default mode restored.");
        return true;
      case "model":
        if (!arg) {
          this.note("Usage: /model <model-name>");
          return true;
        }
        this.turnOverrides = { ...this.turnOverrides, model: arg };
        this.note(`Model override for subsequent turns: ${arg}`);
        return true;
      case "effort":
        if (!arg) {
          this.note("Usage: /effort <low|medium|high>");
          return true;
        }
        this.turnOverrides = { ...this.turnOverrides, effort: arg };
        this.note(`Reasoning effort for subsequent turns: ${arg}`);
        return true;
      case "compact": {
        await this.ensureLiveConnection();
        const threadId = this.connection.threadId;
        if (!threadId) {
          this.note("No active thread to compact.");
          return true;
        }
        await this.connection.request("thread/compact/start", { threadId });
        this.note("Compacting thread context…");
        return true;
      }
      case "review": {
        await this.ensureLiveConnection();
        const threadId = this.connection.threadId ?? (await this.connection.startThread());
        const target = arg
          ? { type: "custom", instructions: arg }
          : { type: "uncommittedChanges" };
        await this.connection.request("review/start", { threadId, target });
        this.note(arg ? `Review started: ${arg}` : "Reviewing uncommitted changes…");
        return true;
      }
      case "help":
        this.note(
          "Commands: /plan, /default, /model <name>, /effort <low|medium|high>, /compact, /review [instructions], /help",
        );
        return true;
      default:
        return false;
    }
  }

  // Notes are published to the Axon (not just the live WS) so slash-command
  // outcomes are part of the durable event log and replay on resubscribe.
  private note(text: string): void {
    void this.connection
      ?.publish({
        event_type: "app/system_note",
        origin: "EXTERNAL_EVENT",
        source: "combined-app",
        payload: JSON.stringify({ text }),
      })
      .catch((err: unknown) => console.error("[codex] failed to publish note:", err));
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
    console.log("[codex] event stream dropped — re-wiring connection before send");
    const afterSequence = this.axonEvents.at(-1)?.sequence;
    const conn = this.wireConnection(this.axon, this.devbox, {
      ...(afterSequence != null ? { afterSequence } : {}),
    });
    await conn.connect();
    await this.initializeOnce(conn);
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
    this.storedOptions = {};
    this.appServerInitialized = false;
    this.turnOverrides = {};
    this.modeKind = null;
    this.threadSettings = {};
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
  }
}

/** Map a boolean UI answer onto the method-specific response shape. */
function buildApprovalResponse(request: ApprovalRequest, approve: boolean): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: approve ? "accept" : "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approve ? "approved" : "denied" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/permissions/requestApproval":
      return approve
        ? {
            permissions: {
              ...(request.params.permissions.network
                ? { network: request.params.permissions.network }
                : {}),
              ...(request.params.permissions.fileSystem
                ? { fileSystem: request.params.permissions.fileSystem }
                : {}),
            },
            scope: "turn",
          }
        : { permissions: {}, scope: "turn" };
  }
}

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
  workingDir?: string;
  systemPrompt?: string;
  model?: string;
  autoApprovePermissions?: boolean;
}

// Give the user plenty of time to answer an approval in the UI before the
// SDK's handler timeout declines it.
const APPROVAL_TIMEOUT_MS = 600_000;

export class CodexConnectionManager {
  connection: CodexAxonConnection | null = null;
  axonEvents: AxonEventView[] = [];

  private axon: Axon | null = null;
  private devbox: Devbox | null = null;
  private storedOptions: CodexStartOptions = {};
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

    if (!apiKey) throw new HttpError(401, "RUNLOOP_API_KEY not set in server .env");
    if (!openaiApiKey) throw new HttpError(401, "OPENAI_API_KEY not set in server .env");

    const sdk = new RunloopSDK({
      bearerToken: apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    this.ws.broadcast(this.tag({ type: "connection_progress", step: "Creating Axon channel..." }));
    const axon = await sdk.axon.create({ name: "combined-app-codex" });
    this.axon = axon;

    // The broker accepts protocol "codex", but the published
    // @runloop/api-client mount types don't include it yet.
    const brokerProtocol: "acp" | "claude_json" | "codex" = "codex";

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
          ...(opts.workingDir ? { working_directory: opts.workingDir } : {}),
        },
      ],
      environment_variables: {
        OPENAI_API_KEY: openaiApiKey,
      },
      launch_parameters: {
        ...(opts.launchCommands?.length ? { launch_commands: opts.launchCommands } : {}),
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
    opts?: { onDisconnect?: () => Promise<void> },
  ): CodexAxonConnection {
    this.axonEvents = [];

    const interactiveApprovals = this.storedOptions.autoApprovePermissions === false;

    const conn = new CodexAxonConnection(axon, devbox, {
      verbose: true,
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
  }

  async send(prompt: string | InputItem[]): Promise<void> {
    if (!this.connection) throw new HttpError(400, "Not connected");
    await this.connection.send(prompt);
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

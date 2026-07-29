import { RunloopSDK, type Secret } from "@runloop/api-client";
import { ACPAxonConnection, PROTOCOL_VERSION } from "@runloop/remote-agents-sdk/acp";
import { ClaudeAxonConnection } from "@runloop/remote-agents-sdk/claude";
import { CodexAxonConnection } from "@runloop/remote-agents-sdk/codex";
import { PiAxonConnection } from "@runloop/remote-agents-sdk/pi";
import type { AgentConfig, AgentConfigOverride, BrokerMount, UseCase, RunContext } from "./types.js";
import { SkipError } from "./types.js";
import { withTimeout } from "./validator.js";

interface SetupResult {
  ctx: RunContext;
  sdk: RunloopSDK;
}

const DEFAULT_WORKING_DIRECTORY = "/home/user";
const SETUP_STEP_TIMEOUT_MS = 30_000;
const SETUP_ERROR_CLEANUP_TIMEOUT_MS = 10_000;
const DEVBOX_PROVISION_TIMEOUT_MS = 180_000; // 3 minutes for cold start with agent mounts

// Pi resolves custom providers from ~/.pi/agent/models.json. `apiKey` keeps the
// literal "$NEBIUS_API_KEY" because Pi interpolates $ENV_VAR itself, so the key
// never lands in the file — only the env var name does. python3's json.dumps
// handles any characters in the base URL safely; hand-assembling JSON in shell
// would break on quotes and backslashes.
const WRITE_PI_MODELS_CMD =
  'mkdir -p "$HOME/.pi/agent" && umask 077 && python3 -c \'import json, os; print(json.dumps({"providers": {"nebius": {"baseUrl": os.environ["NEBIUS_BASE_URL"], "api": "openai-completions", "apiKey": "$NEBIUS_API_KEY", "models": [{"id": "glm-5.2", "name": "GLM 5.2 (Nebius)", "reasoning": True, "contextWindow": 262144, "maxTokens": 32000}], "compat": {"thinkingFormat": "zai"}}}}))\' > "$HOME/.pi/agent/models.json"';

/**
 * Provision a devbox with secrets, then initialize a connection.
 *
 * Flow: merge config → validate → create resources → create devbox → connect.
 */
export async function setup(agent: AgentConfig, useCase: UseCase): Promise<SetupResult> {
  const runloopApiKey = process.env.RUNLOOP_API_KEY;
  if (!runloopApiKey) {
    throw new SkipError("RUNLOOP_API_KEY not set");
  }

  const sdk = new RunloopSDK({ bearerToken: runloopApiKey });

  // Merge use-case overrides, then per-agent overrides.
  const withUseCaseOverrides = applyOverrides(agent, useCase.provisionOverrides);
  const mergedAgent = applyOverrides(
    withUseCaseOverrides,
    useCase.provisionOverridesByAgent?.[agent.name],
  );

  // Validate merged config before provisioning.
  validateConfig(mergedAgent);

  // Validate that all required secrets are available in the local environment.
  const secretsConfig = mergedAgent.secrets ?? {};
  for (const [devboxEnv, localEnv] of Object.entries(secretsConfig)) {
    if (!process.env[localEnv]) {
      throw new SkipError(`${localEnv} not set (required for ${mergedAgent.name})`);
    }
  }

  const log = (msg: string) => {
    console.log(`[${agent.name}/${useCase.name}] ${msg}`);
  };

  // Unique prefix with timestamp to avoid collisions in parallel runs.
  const timestamp = Date.now().toString(36);
  const resourcePrefix = `${useCase.name}-${agent.name}-${timestamp}`;

  log("Creating Axon channel...");
  const axon = await sdk.axon.create({ name: resourcePrefix });

  // Create Runloop secrets for each entry in the agent's secrets config.
  const createdSecrets: Secret[] = [];
  const devboxSecretsMap: Record<string, string> = {};
  for (const [devboxEnv, localEnv] of Object.entries(secretsConfig)) {
    const value = process.env[localEnv]!;
    log(`Creating secret for ${devboxEnv}...`);
    const secret = await sdk.secret.create({
      name: `${resourcePrefix}-${devboxEnv.toLowerCase()}`,
      value,
    });
    createdSecrets.push(secret);
    devboxSecretsMap[devboxEnv] = secret.name;
  }

  // Build the devbox mounts array from the merged config.
  const mounts = buildDevboxMounts(axon.id, mergedAgent);

  log("Creating devbox...");
  const devbox = await sdk.devbox.create(
    {
      name: resourcePrefix,
      blueprint_name: mergedAgent.install.blueprint,
      mounts,
      ...(Object.keys(devboxSecretsMap).length > 0 && { secrets: devboxSecretsMap }),
      launch_parameters: {
        keep_alive_time_seconds: 300,
        // Codex reads credentials from ~/.codex/auth.json, not the
        // OPENAI_API_KEY env var, so materialize an api-key-mode auth file
        // before the broker spawns `codex app-server`.
        ...(mergedAgent.protocol === "codex" && {
          launch_commands: [
            // python3 json.dumps handles any characters in the key safely;
            // hand-assembling JSON in shell would break on quotes/backslashes.
            'mkdir -p "$HOME/.codex" && umask 077 && python3 -c \'import json, os; print(json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]}))\' > "$HOME/.codex/auth.json"',
          ],
        }),
        // Pi reads the nebius/glm-5.2 provider from ~/.pi/agent/models.json,
        // so materialize it before the broker spawns `pi`.
        ...(mergedAgent.protocol === "pi" && {
          launch_commands: [WRITE_PI_MODELS_CMD],
        }),
      },
    },
    { longPoll: { timeoutMs: DEVBOX_PROVISION_TIMEOUT_MS } },
  );
  log(`Devbox ready: ${devbox.id}`);

  // Cleanup: delete secrets after devbox shutdown (for example only).
  const cleanup = async () => {
    log("Shutting down devbox...");
    await devbox.shutdown();

    for (const secret of createdSecrets) {
      log(`Deleting secret ${secret.name}...`);
      try {
        await secret.delete();
      } catch (err) {
        log(`Failed to delete secret (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    if (mergedAgent.protocol === "acp") {
      const conn = new ACPAxonConnection(axon, devbox, {
        createClient: useCase.createClient,
      });

      log("Connecting (ACP)...");
      await withTimeout(conn.connect(), SETUP_STEP_TIMEOUT_MS, "ACP connect");

      log("Initializing (ACP)...");
      await withTimeout(
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "feature-examples", version: "0.1.0" },
          ...(useCase.clientCapabilities ? { clientCapabilities: useCase.clientCapabilities } : {}),
        }),
        SETUP_STEP_TIMEOUT_MS,
        "ACP initialize",
      );

      // Some ACP agents (e.g. codex-acp) require `authenticate()` before `newSession()`.
      if (mergedAgent.acpAuthMethodId) {
        log(`Authenticating (ACP: ${mergedAgent.acpAuthMethodId})...`);
        await withTimeout(
          conn.authenticate({ methodId: mergedAgent.acpAuthMethodId }),
          SETUP_STEP_TIMEOUT_MS,
          `ACP authenticate (${mergedAgent.acpAuthMethodId})`,
        );
      }

      log("Creating session...");
      const session = await withTimeout(
        conn.newSession({
          cwd: mergedAgent.brokerMount.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
          mcpServers: [],
        }),
        SETUP_STEP_TIMEOUT_MS,
        "ACP newSession",
      );
      log(`Session ready: ${session.sessionId}`);

      const ctx: RunContext = {
        agent: mergedAgent,
        acp: conn,
        claude: null,
        codex: null,
        pi: null,
        sessionId: session.sessionId,
        log,
        skip: (reason: string) => {
          throw new SkipError(reason);
        },
        cleanup,
      };

      return { ctx, sdk };
    }

    if (mergedAgent.protocol === "codex") {
      const conn = new CodexAxonConnection(axon, devbox);

      log("Connecting (Codex)...");
      await withTimeout(conn.connect(), SETUP_STEP_TIMEOUT_MS, "Codex connect");
      await withTimeout(conn.initialize(), SETUP_STEP_TIMEOUT_MS, "Codex initialize");

      // After the handshake, the first send() (or an explicit startThread())
      // creates the thread.
      const ctx: RunContext = {
        agent: mergedAgent,
        acp: null,
        claude: null,
        codex: conn,
        pi: null,
        sessionId: null,
        log,
        skip: (reason: string) => {
          throw new SkipError(reason);
        },
        cleanup,
      };

      return { ctx, sdk };
    }

    if (mergedAgent.protocol === "pi") {
      const conn = new PiAxonConnection(axon, devbox);

      log("Connecting (Pi)...");
      await withTimeout(conn.connect(), SETUP_STEP_TIMEOUT_MS, "Pi connect");

      // Pi has no handshake — the broker issues `get_state` at spawn and after
      // every turn, so there is deliberately no initialize() step here.
      const ctx: RunContext = {
        agent: mergedAgent,
        acp: null,
        claude: null,
        codex: null,
        pi: conn,
        sessionId: null,
        log,
        skip: (reason: string) => {
          throw new SkipError(reason);
        },
        cleanup,
      };

      return { ctx, sdk };
    }

    const conn = new ClaudeAxonConnection(axon, devbox);

    log("Connecting (Claude)...");
    await withTimeout(conn.connect(), SETUP_STEP_TIMEOUT_MS, "Claude connect");

    log("Initializing (Claude)...");
    await withTimeout(conn.initialize(), SETUP_STEP_TIMEOUT_MS, "Claude initialize");

    const ctx: RunContext = {
      agent: mergedAgent,
      acp: null,
      claude: conn,
      codex: null,
      pi: null,
      sessionId: null,
      log,
      skip: (reason: string) => {
        throw new SkipError(reason);
      },
      cleanup,
    };

    return { ctx, sdk };
  } catch (err) {
    await cleanupAfterSetupError(cleanup, log);
    throw err;
  }
}

/**
 * Disconnect the connection (transport only, no devbox shutdown).
 */
export async function disconnect(ctx: RunContext): Promise<void> {
  if (ctx.acp) {
    ctx.log("Disconnecting ACP...");
    await ctx.acp.disconnect();
  } else if (ctx.claude) {
    ctx.log("Disconnecting Claude...");
    await ctx.claude.disconnect();
  } else if (ctx.codex) {
    ctx.log("Disconnecting Codex...");
    await ctx.codex.disconnect();
  } else if (ctx.pi) {
    ctx.log("Disconnecting Pi...");
    await ctx.pi.disconnect();
  }
}

/**
 * Shut down the devbox.
 */
export async function cleanup(ctx: RunContext): Promise<void> {
  await ctx.cleanup();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cleanupAfterSetupError(
  cleanupFn: () => Promise<void>,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await withTimeout(cleanupFn(), SETUP_ERROR_CLEANUP_TIMEOUT_MS, "setup cleanup");
  } catch (cleanupErr) {
    log(
      `Cleanup timeout/error after setup failure (continuing): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
    );
  }
}

/**
 * Validate that the merged config is internally consistent.
 */
function validateConfig(agent: AgentConfig): void {
  // Ensure broker protocol matches client protocol expectation.
  const brokerProtocolByClientProtocol = {
    acp: "acp",
    claude: "claude_json",
    codex: "codex_json",
    pi: "pi_json",
  } as const;
  const expectedBrokerProtocol = brokerProtocolByClientProtocol[agent.protocol];
  if (agent.brokerMount.protocol !== expectedBrokerProtocol) {
    throw new Error(
      `Config error for ${agent.name}: protocol "${agent.protocol}" expects brokerMount.protocol "${expectedBrokerProtocol}", got "${agent.brokerMount.protocol}"`,
    );
  }
}

/**
 * Build the devbox mounts array from the agent config.
 *
 * - **catalog** install: adds an `agent_mount` (to install from catalog) + `broker_mount`.
 * - **blueprint** install: only a `broker_mount` (agent is pre-baked).
 */
function buildDevboxMounts(
  axonId: string,
  agent: AgentConfig,
): Array<
  | { type: "agent_mount"; agent_id: null; agent_name: string }
  | {
      type: "broker_mount";
      axon_id: string;
      protocol: "acp" | "claude_json";
      agent_binary?: string;
      launch_args?: string[];
      working_directory?: string;
    }
> {
  const brokerMount = buildBrokerMount(axonId, agent.brokerMount);

  if (agent.install.kind === "agent-mount") {
    const agentMount = {
      type: "agent_mount" as const,
      agent_id: null,
      agent_name: agent.install.agentName,
    };
    return [agentMount, brokerMount];
  }

  // Blueprint install: agent is already in the image.
  return [brokerMount];
}

/**
 * Build a broker_mount object from the BrokerMount config.
 */
function buildBrokerMount(
  axonId: string,
  config: BrokerMount,
): {
  type: "broker_mount";
  axon_id: string;
  protocol: "acp" | "claude_json";
  agent_binary?: string;
  launch_args?: string[];
  working_directory?: string;
} {
  return {
    type: "broker_mount" as const,
    axon_id: axonId,
    // The broker accepts protocols "codex_json" and "pi_json", but the
    // published @runloop/api-client mount types don't include either yet.
    protocol: config.protocol as "acp" | "claude_json",
    ...(config.agentBinary && { agent_binary: config.agentBinary }),
    ...(config.launchArgs && { launch_args: config.launchArgs }),
    ...(config.workingDirectory && { working_directory: config.workingDirectory }),
  };
}

/**
 * Apply overrides to an agent config.
 *
 * - `install` replaces entirely when provided.
 * - `brokerMount` is shallow-merged.
 * - `env` and `secrets` are shallow-merged.
 * - Other fields replace when provided.
 */
function applyOverrides(agent: AgentConfig, overrides?: AgentConfigOverride): AgentConfig {
  if (!overrides) return agent;

  return {
    ...agent,
    install: overrides.install ?? agent.install,
    brokerMount: {
      ...agent.brokerMount,
      ...overrides.brokerMount,
    },
    acpAuthMethodId: overrides.acpAuthMethodId ?? agent.acpAuthMethodId,
    env: {
      ...agent.env,
      ...overrides.env,
    },
    secrets: {
      ...agent.secrets,
      ...overrides.secrets,
    },
  };
}

import { parseArgs } from "util";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import type { RunResult, AgentConfig, UseCase, RunContext } from "./types.js";
import { SkipError } from "./types.js";
import { AGENTS } from "./agents.js";
import { USE_CASES } from "./use-cases/index.js";
import { setup, disconnect, cleanup } from "./scaffold.js";
import { withTimeout } from "./validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const FEATURE_EXAMPLES_DIR = resolve(__dirname, "..");
const TEMPLATES_DIR = resolve(FEATURE_EXAMPLES_DIR, "templates");
const SDK_PACKAGE_JSON = resolve(REPO_ROOT, "sdk/package.json");

async function getSdkVersion(): Promise<string> {
  const content = await readFile(SDK_PACKAGE_JSON, "utf-8");
  const pkg = JSON.parse(content) as { version: string };
  return pkg.version;
}

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

function printHelp(): void {
  console.log(`
Usage: bun run feature-compat [options]

Options:
  --agent <name>       Run only for this agent (default: all)
  --protocol <proto>   Run only for this protocol: acp, claude (default: all)
  --use-case <name>    Run only this use case (default: all)
  --parallel <n>       Max concurrent devboxes (default: 5)
  --timeout <ms>       Default timeout per use case, capped at 30000 (default: 10000)
  --validate           Validate generated output without running (checks compatibility.md and llms.txt)
  --help               Show help

Examples:
  bun run feature-compat                           # Run all use cases with all agents
  bun run feature-compat --agent opencode          # Run all use cases with opencode only
  bun run feature-compat --use-case single-prompt  # Run single-prompt with all agents
  bun run feature-compat --validate                # Validate generated output
`);
}

const DISCONNECT_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_USE_CASE_TIMEOUT_MS = 30_000;

async function runOne(
  agent: AgentConfig,
  useCase: UseCase,
  defaultTimeout: number,
): Promise<RunResult> {
  let ctx: RunContext | null = null;
  let agentStartMs: number | null = null;
  const expectedFailReason = useCase.expectedFailures?.[agent.name];
  const getDurationMs = () => (agentStartMs === null ? 0 : Date.now() - agentStartMs);

  // Pre-setup skip: avoids provisioning a devbox we know we cannot use
  // (e.g. an account with an exhausted API quota for this agent).
  const preSkipReason = useCase.skipForAgents?.[agent.name];
  if (preSkipReason) {
    return {
      agent: agent.name,
      useCase: useCase.name,
      protocol: agent.protocol,
      status: "skip",
      reason: preSkipReason,
      durationMs: 0,
    };
  }

  try {
    const { ctx: setupCtx } = await setup(agent, useCase);
    ctx = setupCtx;

    agentStartMs = Date.now();
    const timeout = Math.min(
      useCase.timeoutMs ?? defaultTimeout,
      MAX_USE_CASE_TIMEOUT_MS,
    );
    await withTimeout(useCase.run(ctx), timeout, `${useCase.name} execution`);

    if (expectedFailReason) {
      return {
        agent: agent.name,
        useCase: useCase.name,
        protocol: agent.protocol,
        status: "xpass",
        reason: "Expected to fail but passed",
        durationMs: getDurationMs(),
      };
    }
    return {
      agent: agent.name,
      useCase: useCase.name,
      protocol: agent.protocol,
      status: "pass",
      durationMs: getDurationMs(),
    };
  } catch (err) {
    if (err instanceof SkipError) {
      return {
        agent: agent.name,
        useCase: useCase.name,
        protocol: agent.protocol,
        status: "skip",
        reason: err.reason,
        durationMs: getDurationMs(),
      };
    }
    if (expectedFailReason) {
      return {
        agent: agent.name,
        useCase: useCase.name,
        protocol: agent.protocol,
        status: "xfail",
        error: err instanceof Error ? err.message : String(err),
        xfailReason: expectedFailReason,
        durationMs: getDurationMs(),
      };
    }
    return {
      agent: agent.name,
      useCase: useCase.name,
      protocol: agent.protocol,
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
      durationMs: getDurationMs(),
    };
  } finally {
    if (ctx) {
      try {
        await withTimeout(disconnect(ctx), DISCONNECT_TIMEOUT_MS, "disconnect");
      } catch (err) {
        ctx.log(`Disconnect timeout/error (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await withTimeout(cleanup(ctx), CLEANUP_TIMEOUT_MS, "cleanup (devbox shutdown)");
      } catch (err) {
        ctx.log(`Cleanup timeout/error (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function printResults(results: RunResult[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("RESULTS");
  console.log("=".repeat(80));

  const maxAgent = results.length > 0
    ? Math.max(...results.map((r) => r.agent.length), 10)
    : 10;
  const maxUseCase = results.length > 0
    ? Math.max(...results.map((r) => r.useCase.length), 10)
    : 10;

  console.log(
    `${"Agent".padEnd(maxAgent)} | ${"Use Case".padEnd(maxUseCase)} | Protocol | Status | Duration | Notes`,
  );
  console.log("-".repeat(80));

  for (const r of results) {
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    const notes = r.error ?? r.reason ?? "";
    const notesTrunc = notes.length > 40 ? notes.slice(0, 37) + "..." : notes;
    console.log(
      `${r.agent.padEnd(maxAgent)} | ${r.useCase.padEnd(maxUseCase)} | ${r.protocol.padEnd(8)} | ${r.status.padEnd(6)} | ${duration.padStart(8)} | ${notesTrunc}`,
    );
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const xfailed = results.filter((r) => r.status === "xfail").length;
  const xpassed = results.filter((r) => r.status === "xpass").length;

  console.log("-".repeat(80));
  let summary = `Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`;
  if (xfailed > 0) summary += ` | XFail: ${xfailed}`;
  if (xpassed > 0) summary += ` | XPass: ${xpassed}`;
  console.log(summary);
}

async function loadTemplate(name: string): Promise<string> {
  const templatePath = resolve(TEMPLATES_DIR, `${name}.template`);
  return readFile(templatePath, "utf-8");
}

/**
 * Assert that no template placeholders remain in the output.
 * Throws if any {{placeholder}} patterns are found.
 */
function assertNoUnresolvedPlaceholders(output: string, templateName: string): void {
  const placeholderMatch = output.match(/\{\{[^}]+\}\}/g);
  if (placeholderMatch) {
    throw new Error(
      `Unresolved placeholder(s) in ${templateName}: ${placeholderMatch.join(", ")}`,
    );
  }
}

/**
 * Aggregate multiple agent results for a single protocol into one status.
 * Rules (in priority order):
 *   1. If any result is "fail", the protocol status is "fail".
 *   2. If any result is "pass" or "xpass", the protocol status is "pass".
 *   3. If any result is "xfail", the protocol status is "xfail".
 *   4. If any result is "skip", the protocol status is "skip".
 *   5. Otherwise (no results), status is "pending".
 */
function aggregateProtocolStatus(results: RunResult[]): RunResult["status"] | "pending" {
  if (results.length === 0) return "pending";
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "pass" || r.status === "xpass")) return "pass";
  if (results.some((r) => r.status === "xfail")) return "xfail";
  if (results.some((r) => r.status === "skip")) return "skip";
  return "pending";
}

function buildProtocolFeatureRows(results: RunResult[], useCases: UseCase[]): string {
  let rows = "";
  for (const uc of useCases) {
    const acpResults = results.filter(
      (r) => r.useCase === uc.name && r.protocol === "acp",
    );
    const claudeResults = results.filter(
      (r) => r.useCase === uc.name && r.protocol === "claude",
    );

    const acpStatus = uc.protocols.includes("acp")
      ? aggregateProtocolStatus(acpResults)
      : "N/A";
    const claudeStatus = uc.protocols.includes("claude")
      ? aggregateProtocolStatus(claudeResults)
      : "N/A";

    rows += `| ${uc.name} | ${acpStatus} | ${claudeStatus} |\n`;
  }
  return rows.trimEnd();
}

function buildAcpAgentFeatureTable(
  results: RunResult[],
  useCases: UseCase[],
  agents: AgentConfig[],
): string {
  const acpAgents = agents.filter((a) => a.protocol === "acp" && a.enabled !== false);
  if (acpAgents.length === 0) {
    return "No ACP agents configured.";
  }

  let table = "| Use Case |";
  for (const agent of acpAgents) {
    table += ` ${agent.name} |`;
  }
  table += "\n|----------|";
  for (const _ of acpAgents) {
    table += "------------|";
  }
  table += "\n";

  const acpUseCases = useCases.filter((uc) => uc.protocols.includes("acp"));
  for (const uc of acpUseCases) {
    table += `| ${uc.name} |`;
    for (const agent of acpAgents) {
      const result = results.find(
        (r) => r.useCase === uc.name && r.agent === agent.name,
      );
      table += ` ${result?.status ?? "pending"} |`;
    }
    table += "\n";
  }
  return table.trimEnd();
}

function buildRunDetailsRows(results: RunResult[]): string {
  let rows = "";
  for (const r of results) {
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    let notes = r.error ?? r.reason ?? "";
    if (r.status === "xfail" && r.xfailReason) {
      notes = `[xfail: ${r.xfailReason}] ${notes}`;
    }
    rows += `| ${r.agent} | ${r.useCase} | ${r.status} | ${duration} | ${notes} |\n`;
  }
  return rows.trimEnd();
}

async function generateCompatibilityMd(
  results: RunResult[],
  useCases: UseCase[],
  agents: AgentConfig[],
): Promise<string> {
  const template = await loadTemplate("compatibility.md");
  const sdkVersion = await getSdkVersion();

  const output = template
    .replace("{{sdkVersion}}", sdkVersion)
    .replace("{{protocolFeatureRows}}", buildProtocolFeatureRows(results, useCases))
    .replace("{{acpAgentFeatureTable}}", buildAcpAgentFeatureTable(results, useCases, agents))
    .replace("{{runDetailsRows}}", buildRunDetailsRows(results));

  assertNoUnresolvedPlaceholders(output, "compatibility.md");
  return output;
}

const GITHUB_REPO_BASE = "https://github.com/runloopai/remote-agents-sdk/blob/main";

function buildUseCasesList(useCases: UseCase[]): string {
  let list = "";
  for (const uc of useCases) {
    const protocols = uc.protocols.join(" + ");
    const url = `${GITHUB_REPO_BASE}/examples/feature-examples/src/use-cases/${uc.name}.ts`;
    list += `- [${uc.name}](${url}) — ${uc.description} (${protocols})\n`;
  }
  return list.trimEnd();
}

async function generateLlmsTxt(useCases: UseCase[]): Promise<string> {
  const template = await loadTemplate("llms.txt");
  const output = template.replace("{{useCasesList}}", buildUseCasesList(useCases));

  assertNoUnresolvedPlaceholders(output, "llms.txt");
  return output;
}

interface ValidationError {
  file: string;
  issue: string;
}

/**
 * Validate that generated output files contain the expected content.
 * For llms.txt, only the generated use-case list is validated (the exact format
 * produced by buildUseCasesList), so hand-edited guidance sections won't break tests.
 */
async function validateOutput(
  useCases: UseCase[],
  agents: AgentConfig[],
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  const compatPath = resolve(FEATURE_EXAMPLES_DIR, "compatibility.md");
  const llmsPath = resolve(REPO_ROOT, "llms.txt");

  if (!existsSync(compatPath)) {
    errors.push({ file: "compatibility.md", issue: "File does not exist" });
  } else {
    const content = await readFile(compatPath, "utf-8");

    for (const uc of useCases) {
      if (!content.includes(`| ${uc.name} |`)) {
        errors.push({
          file: "compatibility.md",
          issue: `Use case "${uc.name}" not found in table`,
        });
      }
    }

    const acpAgents = agents.filter((a) => a.protocol === "acp" && a.enabled !== false);
    for (const agent of acpAgents) {
      if (!content.includes(agent.name)) {
        errors.push({
          file: "compatibility.md",
          issue: `Agent "${agent.name}" not found`,
        });
      }
    }

    if (content.includes("{{") && content.includes("}}")) {
      errors.push({
        file: "compatibility.md",
        issue: "Unresolved template placeholder detected",
      });
    }
  }

  if (!existsSync(llmsPath)) {
    errors.push({ file: "llms.txt", issue: "File does not exist" });
  } else {
    const content = await readFile(llmsPath, "utf-8");

    for (const uc of useCases) {
      const expectedUrl = `${GITHUB_REPO_BASE}/examples/feature-examples/src/use-cases/${uc.name}.ts`;
      if (!content.includes(expectedUrl)) {
        errors.push({
          file: "llms.txt",
          issue: `Use case "${uc.name}" not in generated list (expected URL: ${expectedUrl})`,
        });
      }
    }

    if (content.includes("{{") && content.includes("}}")) {
      errors.push({
        file: "llms.txt",
        issue: "Unresolved template placeholder detected",
      });
    }
  }

  return errors;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      agent: { type: "string" },
      protocol: { type: "string" },
      "use-case": { type: "string" },
      parallel: { type: "string", default: "5" },
      timeout: { type: "string", default: "10000" },
      validate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const parallel = parseInt(args.parallel ?? "5", 10);
  if (Number.isNaN(parallel) || parallel < 1) {
    console.error(`Invalid --parallel value: ${args.parallel}`);
    console.error("Must be a number >= 1");
    process.exit(1);
  }

  const timeout = parseInt(args.timeout!, 10);
  if (Number.isNaN(timeout) || timeout < 1) {
    console.error(`Invalid --timeout value: ${args.timeout}`);
    console.error("Must be a number >= 1");
    process.exit(1);
  }

  if (args.validate) {
    console.log("Validating generated output...\n");
    const errors = await validateOutput(USE_CASES, AGENTS);
    if (errors.length === 0) {
      console.log("Validation passed!");
      process.exit(0);
    } else {
      console.log("Validation failed:");
      for (const err of errors) {
        console.log(`  [${err.file}] ${err.issue}`);
      }
      process.exit(1);
    }
  }

  // Filter to enabled agents only (unless explicitly requested by name)
  let filteredAgents = AGENTS.filter((a) => a.enabled !== false);
  let filteredUseCases = USE_CASES;

  if (args.agent) {
    // When explicitly requesting an agent by name, include it even if disabled
    filteredAgents = AGENTS.filter((a) => a.name === args.agent);
    if (filteredAgents.length === 0) {
      console.error(`Unknown agent: ${args.agent}`);
      console.error(`Available: ${AGENTS.map((a) => a.name).join(", ")}`);
      process.exit(1);
    }
  }

  if (args.protocol) {
    if (args.protocol !== "acp" && args.protocol !== "claude") {
      console.error(`Unknown protocol: ${args.protocol}`);
      console.error("Available: acp, claude");
      process.exit(1);
    }
    filteredAgents = filteredAgents.filter((a) => a.protocol === args.protocol);
  }

  if (args["use-case"]) {
    filteredUseCases = USE_CASES.filter((uc) => uc.name === args["use-case"]);
    if (filteredUseCases.length === 0) {
      console.error(`Unknown use case: ${args["use-case"]}`);
      console.error(`Available: ${USE_CASES.map((uc) => uc.name).join(", ")}`);
      process.exit(1);
    }
  }

  const pairs: Array<{ agent: AgentConfig; useCase: UseCase }> = [];
  for (const agent of filteredAgents) {
    for (const useCase of filteredUseCases) {
      if (useCase.protocols.includes(agent.protocol)) {
        pairs.push({ agent, useCase });
      }
    }
  }

  if (pairs.length === 0) {
    console.log("No use cases to run (no matching agent/use-case/protocol combinations).");
    process.exit(0);
  }

  console.log(`Running ${pairs.length} test(s) with parallelism ${parallel}...\n`);

  const semaphore = new Semaphore(parallel);
  const results = await Promise.all(
    pairs.map(async ({ agent, useCase }) => {
      await semaphore.acquire();
      try {
        return await runOne(agent, useCase, timeout);
      } finally {
        semaphore.release();
      }
    }),
  );

  printResults(results);

  const isPartialRun = !!(args.agent || args.protocol || args["use-case"]);

  if (isPartialRun) {
    console.log("\nPartial run detected — skipping generation of canonical files.");
    console.log("Run without --agent, --protocol, or --use-case filters to regenerate compatibility.md and llms.txt.\n");
  } else {
    console.log("\nGenerating compatibility.md...");
    const compatMd = await generateCompatibilityMd(results, USE_CASES, AGENTS);
    await writeFile(resolve(FEATURE_EXAMPLES_DIR, "compatibility.md"), compatMd);

    console.log("Generating llms.txt...");
    const llmsTxt = await generateLlmsTxt(USE_CASES);
    await writeFile(resolve(REPO_ROOT, "llms.txt"), llmsTxt);

    console.log("\nValidating output...");
    const validationErrors = await validateOutput(USE_CASES, AGENTS);
    if (validationErrors.length > 0) {
      console.log("Validation failed:");
      for (const err of validationErrors) {
        console.log(`  [${err.file}] ${err.issue}`);
      }
      process.exit(1);
    }
    console.log("Validation passed!");
  }

  const failed = results.filter((r) => r.status === "fail").length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

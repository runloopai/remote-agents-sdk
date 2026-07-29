# @runloop/example-blueprint

> **Alpha — subject to change.** This example uses an SDK in early development. APIs and behavior may change without notice between versions.

Builds the shared `axon-agents` Runloop [blueprint](https://docs.runloop.ai/guides/blueprints) used by examples that demonstrate pre-baked agent images. The blueprint bakes the agent binaries (Claude Code, OpenCode, Codex ACP, Codex CLI, Pi) into a devbox image so subsequent devboxes start quickly and reproducibly.

**You must run this once before any other example will work.** The other examples create devboxes with `blueprint_name: "axon-agents"` — if that blueprint does not exist on your Runloop account, devbox creation will fail.

## Prerequisites

- Node.js 22+ / [Bun](https://bun.sh)
- A [Runloop](https://runloop.ai) API key (`RUNLOOP_API_KEY`)

## Running

From the monorepo root:

```bash
bun install
bun run build-blueprint
```

Or directly from this directory:

```bash
cd examples/blueprint
bun run build-blueprint.ts
```

The script builds the `axon-agents` blueprint and prints its status. A successful build ends with:

```
Blueprint build complete.
Use blueprint_name: "axon-agents" in devbox.create()
```

You only need to do this once per Runloop account. Re-run it to update the image when the `Dockerfile` changes.

## What's in the blueprint

See [`Dockerfile`](Dockerfile) for the exact contents. At the time of writing it installs:

- [Claude Code](https://docs.claude.com/en/docs/claude-code) — for the Claude module examples
- [OpenCode](https://opencode.ai) — for ACP examples using OpenCode
- [Codex ACP](https://www.npmjs.com/package/@zed-industries/codex-acp) — for ACP examples using Codex
- [Codex CLI](https://developers.openai.com/codex/cli) — for native Codex module examples (pinned to 0.144.1, matching the SDK's vendored protocol types)
- [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — for native Pi module examples (pinned to 0.82.1, matching the wire types hand-written in `sdk/src/pi/protocol/`)

## Alternatives

Using a pre-baked blueprint is the fastest path, but not the only option. You can instead attach agents to any standard Runloop image as late-binding mounts. See [Getting Agents onto the Devbox](../../README.md#getting-agents-onto-the-devbox) in the root README for a comparison.

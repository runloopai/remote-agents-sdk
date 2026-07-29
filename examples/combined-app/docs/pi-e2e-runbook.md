# Pi end-to-end verification runbook

Operator procedure for verifying the Pi protocol path end to end: blueprint →
devbox → broker (`pi_json`) → `PiAxonConnection` → combined-app UI. Run it
against a live devbox on a broker that has Pi protocol selection deployed;
`compatibility.md` and the unit suites cover nothing that happens on the wire.

Every step lists what to do and what to expect, so a failure localises to one
hop. The instrument for the UI steps is a scripted browser (vbrowser); nothing
here is wired into CI. Recurring live coverage belongs in
[`runloopai/remote-agents-sdk-smoke-tests`](https://github.com/runloopai/remote-agents-sdk-smoke-tests).

## 0. Preconditions

| Requirement | Check |
|-------------|-------|
| Broker with Pi protocol selection deployed to the target environment | Ask for the deployed broker version; a broker without it rejects the mount below with an unknown-protocol error |
| `RUNLOOP_API_KEY` (and `RUNLOOP_BASE_URL` if not production) | `env \| grep RUNLOOP_` |
| `NEBIUS_API_KEY`, `NEBIUS_BASE_URL` — Runloop's dedicated GLM-5.2 endpoint | `env \| grep NEBIUS_` |
| `axon-agents` blueprint built from a `Dockerfile` that pins `@earendil-works/pi-coding-agent@0.82.1` | Step 1 |

Credentials come from the environment or a local `.env`. Never commit them.

## 1. Build the blueprint

```bash
# From the monorepo root
bun install && bun run build
bun run build-blueprint
```

Expected: the build succeeds and the image contains Pi at
`/usr/local/bin/pi`. Confirm the pin on a scratch devbox:

```bash
pi --version   # 0.82.1
```

An `axon-agents` image built before Pi was added to
[`../../blueprint/Dockerfile`](../../blueprint/Dockerfile) fails step 4 with a
missing-binary agent error. Rebuild rather than debugging the mount.

## 2. The mount under test

The combined-app's Pi manager creates this broker mount
([`../src/server/pi-manager.ts`](../src/server/pi-manager.ts)):

```json
{
  "type": "broker_mount",
  "axon_id": "<axon id>",
  "protocol": "pi_json",
  "agent_binary": "/usr/local/bin/pi",
  "launch_args": ["--model", "nebius/glm-5.2"]
}
```

`--mode rpc` and `--session-dir` are **broker-owned**: the broker appends both,
and `--session-dir` must stay on the durable state root or resume will not
survive a devbox snapshot. If you see either in `launch_args` anywhere in this
repo, that is the bug.

The devbox also runs a launch command that writes `~/.pi/agent/models.json`
with a `nebius` provider whose `apiKey` is the literal `"$NEBIUS_API_KEY"` —
Pi interpolates the environment variable itself, so the key never lands on
disk. On a devbox, verify:

```bash
cat ~/.pi/agent/models.json   # apiKey must read "$NEBIUS_API_KEY", not a key
```

## 3. Start the app

```bash
cd examples/combined-app
cp .env.example .env    # then fill in RUNLOOP_API_KEY, NEBIUS_API_KEY, NEBIUS_BASE_URL
bun run dev
```

Expected: the server logs `NEBIUS_API_KEY: set, NEBIUS_BASE_URL: set (Pi agents
need both)`. If either says `NOT SET`, `POST /api/start` returns 401 before any
devbox is created.

Open http://localhost:5176.

## 4. Provision a Pi agent

In the UI: **Agent Type → Pi**, blueprint `axon-agents`, model
`nebius/glm-5.2`, then **Start Agent**.

Expected:

- Progress steps: `Creating Axon channel…` → `Provisioning sandbox…` →
  `Connecting to Pi…`.
- The sidebar shows a `P` badge and the agent name.
- The Timeline tab shows an `agent_started` config event (`CFG` badge).
- No `initialize` event of any kind. Pi has no handshake; `connect()` is the
  whole setup.

Failure modes: an unknown-protocol error means the broker predates Pi support
(step 0); a missing-binary agent error means a stale blueprint (step 1).

## 5. Stream a turn

Prompt: `List the files in the working directory, then explain what this
project is in two sentences.`

Expected, in the Timeline tab (`PI` badge):

1. `turn/start` published outbound, then `response prompt` with `success: true`
   — Pi *accepted* the prompt. This is not turn completion.
2. `agent_start`, `turn_start`.
3. `message_start`, then a run of `message_update` events:
   `thinking_delta` (thinking blocks in the chat view) and `text_delta`
   (streamed assistant text).
4. `tool_execution_start` / `_update` / `_end` around the directory listing,
   with the tool name in the summary.
5. `message_end`, `turn_end`, `agent_end`.
6. `agent_settled` — **the only event that ends a turn.** The composer
   re-enables here.

The distinction in 5–6 is the point of this step. An `agent_end` with
`willRetry` shown in its summary is followed by more streaming, not by the end
of the turn. A UI that finalises on `agent_end` truncates retried turns; watch
for the composer re-enabling early.

Capture: a screenshot of the streamed turn with both a thinking block and a
text block rendered, and one of the Timeline showing `agent_end` followed by
`agent_settled`.

## 6. Interrupt a turn

Send a prompt that runs long (`Count slowly from 1 to 200, one number per
line.`), then hit **Cancel** mid-stream.

Expected: a `cancel` event goes out; streaming stops; the turn finalises and
the composer re-enables. Capture a screenshot of the interrupted turn.

## 7. Steer and follow up

With a turn in flight, `POST /api/pi/queue`:

```bash
curl -sX POST localhost:3003/api/pi/queue \
  -H 'content-type: application/json' \
  -d '{"agentId":"<id>","message":"Actually, keep it to one sentence.","mode":"steer"}'
```

Expected: the in-flight turn changes course without a new `turn/start`, and no
second turn appears. Repeat with `"mode":"follow_up"` and expect the message to
run after the current turn settles instead. Neither mode starts a turn, so
neither goes through the broker's turn tracking.

## 8. Session state, suspend, resume

```bash
curl -sX POST localhost:3003/api/pi/state \
  -H 'content-type: application/json' -d '{"agentId":"<id>"}'
```

Expected: `sessionId` and `sessionFile` are populated (the UI shows
`Session: <id>` above the chat), and `model` reflects `nebius/glm-5.2`.

The devbox is provisioned with a 60s idle-suspend lifecycle and
`resume_triggers.axon_event`. Leave the agent idle past that window, then send
a prompt referring to something established earlier in the conversation.

Expected: the devbox resumes on the published event, the turn runs, and the
answer shows the earlier context survived. Capture a screenshot of the
post-resume turn together with the `devbox.suspended` / `devbox.resumed` system
events in the Timeline.

## 9. Reconnect with replay

Reload the browser tab. The client re-issues `POST /api/subscribe`, which
re-wires the connection and replays history.

Expected: the full prior conversation renders once, with no duplicated blocks,
and `sessionId` is unchanged.

## 10. feature-examples suite

```bash
bun run feature-compat --agent pi
```

Expected: `pass` for `single-prompt`, `agent-via-blueprint` and
`session-resume-pi`. This regenerates `compatibility.md` and `llms.txt` from
live results — commit the regenerated files rather than hand-editing them, and
regenerate from a full run (`bun run feature-compat`) so other agents' rows are
not downgraded to `skip` by a filtered run.

Any row that cannot pass must carry a written reason in the use case, following
the `elicitation-acp` convention.

## What this runbook does not cover

- Nothing here runs in CI, by design. Add the Pi case to
  `runloopai/remote-agents-sdk-smoke-tests` for recurring coverage.
- Image attachments: the combined-app flattens Pi prompts to a single string
  and drops images (see [`../src/server/routes/prompt.ts`](../src/server/routes/prompt.ts)).
- Approvals: Pi has no approval protocol, so there is no permission step to
  exercise. The auto-approve toggle is inert for Pi agents.

import type { Axon } from "@runloop/api-client/sdk";
import { getLastSequence } from "./replay.js";
import type { BaseConnectionOptions, LogFn } from "./types.js";

/**
 * Resolves the replay target sequence number from the `replay` option.
 * Shared by the ACP, Claude, and Codex connection classes.
 *
 * The target is independent of `afterSequence`: with both set, the
 * subscription starts after `afterSequence` and replay semantics apply to
 * the events in `(afterSequence, head]`.
 *
 * @returns The current head sequence, or `undefined` if replay is disabled
 *   (`replay: false`) or the axon has no events.
 */
export async function resolveReplayTarget(
  axon: Axon,
  options: Pick<BaseConnectionOptions, "replay" | "afterSequence">,
  log: LogFn,
): Promise<number | undefined> {
  if (options.replay === false) return undefined;
  const seq = await getLastSequence(axon);
  if (seq != null) {
    log("connect", `replay target sequence: ${seq}`);
  }
  return seq;
}

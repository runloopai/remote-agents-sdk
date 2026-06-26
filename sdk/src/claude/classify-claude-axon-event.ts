import { hasStringType } from "../shared/structural-guards.js";
import { createClassifier } from "../shared/timeline.js";
import { MESSAGE_TYPE_TO_EVENT_TYPE } from "./transport.js";
import type { ClaudeProtocolTimelineEvent } from "./types.js";

const CLAUDE_KNOWN_EVENT_TYPES: Set<string> = new Set([
  ...Object.keys(MESSAGE_TYPE_TO_EVENT_TYPE),
  ...Object.values(MESSAGE_TYPE_TO_EVENT_TYPE),
]);

/**
 * Returns `true` if `eventType` is a known Claude protocol event type.
 *
 * @category Timeline
 */
export function isClaudeProtocolEventType(eventType: string): boolean {
  return CLAUDE_KNOWN_EVENT_TYPES.has(eventType);
}

/**
 * Classifies a raw Axon event into a {@link ClaudeTimelineEvent}.
 *
 * Classification rules:
 * 1. `SYSTEM_EVENT` with `turn.started` / `turn.completed` / `turn.failed` /
 *    `broker.error` -> `system`
 * 2. Known Claude protocol `event_type` -> `claude_protocol` with `eventType` discriminator
 * 3. Everything else -> `unknown`
 *
 * @category Timeline
 */
export const classifyClaudeAxonEvent = createClassifier<ClaudeProtocolTimelineEvent>({
  label: "classifyClaudeAxonEvent",
  isProtocolEventType: isClaudeProtocolEventType,
  toProtocolEvent: (data, ev) => {
    if (hasStringType(data)) {
      return {
        kind: "claude_protocol",
        eventType: ev.event_type,
        data,
        axonEvent: ev,
      } as ClaudeProtocolTimelineEvent;
    }
    return null;
  },
});

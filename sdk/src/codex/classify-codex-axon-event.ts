import { createClassifier } from "../shared/timeline.js";
import {
  CODEX_APPROVAL_REQUEST_METHOD_SET,
  CODEX_NOTIFICATION_METHOD_SET,
  RESPONSE_EVENT_TYPE,
} from "./protocol/index.js";
import type { CodexProtocolTimelineEvent } from "./types.js";

/** Returns whether an Axon event type is one of the classified Codex wire methods. */
export function isCodexProtocolEventType(eventType: string): boolean {
  return (
    eventType === RESPONSE_EVENT_TYPE ||
    CODEX_NOTIFICATION_METHOD_SET.has(eventType) ||
    CODEX_APPROVAL_REQUEST_METHOD_SET.has(eventType)
  );
}

/** Classifies a raw Axon event as Codex protocol, shared system, or unknown. */
export const classifyCodexAxonEvent = createClassifier<CodexProtocolTimelineEvent>({
  label: "classifyCodexAxonEvent",
  isProtocolEventType: isCodexProtocolEventType,
  toProtocolEvent: (data, ev) => {
    if (typeof data !== "object" || data === null) return null;
    return {
      kind: "codex_protocol",
      eventType: ev.event_type,
      data,
      axonEvent: ev,
    } as CodexProtocolTimelineEvent;
  },
});

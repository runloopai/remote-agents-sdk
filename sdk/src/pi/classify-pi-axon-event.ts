import { createClassifier } from "../shared/timeline.js";
import { PI_EVENT_TYPE_SET, PI_RESPONSE_EVENT_TYPE } from "./protocol/index.js";
import type { PiProtocolTimelineEvent } from "./types.js";

/** Returns whether an Axon event type is one of the classified Pi wire frames. */
export function isPiProtocolEventType(eventType: string): boolean {
  return PI_EVENT_TYPE_SET.has(eventType) || eventType === PI_RESPONSE_EVENT_TYPE;
}

/** Classifies a raw Axon event as Pi protocol, shared system, or unknown. */
export const classifyPiAxonEvent = createClassifier<PiProtocolTimelineEvent>({
  label: "classifyPiAxonEvent",
  isProtocolEventType: isPiProtocolEventType,
  toProtocolEvent: (data, ev) => {
    if (typeof data !== "object" || data === null) return null;
    return {
      kind: "pi_protocol",
      eventType: ev.event_type,
      data,
      axonEvent: ev,
    } as PiProtocolTimelineEvent;
  },
});

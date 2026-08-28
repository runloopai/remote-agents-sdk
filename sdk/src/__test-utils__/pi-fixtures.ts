/**
 * Wire-correct Pi frame builders, transcribed from
 * `java/rust/broker/clients/pi-codes/tests/protocol_tests.rs`.
 */
import type {
  AssistantContent,
  AssistantMessage,
  AssistantMessageEvent,
  MessageUpdateEvent,
  StopReason,
  ToolResultMessage,
} from "../pi/protocol/index.js";

export function assistantMessage(
  content: AssistantContent[],
  stopReason: StopReason,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
    stopReason,
    timestamp: 1_700_000_000_000,
  };
}

/**
 * An assistant message for a request that failed before any token accounting
 * was recorded: `stopReason: "error"`, an `errorMessage`, and no `usage`.
 */
export function assistantErrorMessageWithoutUsage(): AssistantMessage {
  const { usage: _usage, ...message } = assistantMessage([], "error");
  return { ...message, errorMessage: "overloaded" };
}

export function toolResultMessage(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "/work" }],
    isError: false,
    timestamp: 1_700_000_000_001,
  };
}

export function messageUpdate(delta: AssistantMessageEvent): MessageUpdateEvent {
  return {
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "Hi" }], "stop"),
    assistantMessageEvent: delta,
  };
}

import type { SDKControlResponse } from "@anthropic-ai/claude-agent-sdk";
import type { Axon, Devbox } from "@runloop/api-client/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createControllableStream,
  type MockAxonEvent,
  makeAgentEvent,
  makeSystemEvent,
  makeUserEvent,
} from "../__test-utils__/mock-axon.js";
import { ClaudeAxonConnection } from "./connection.js";

const question = (id: string, sequence: number) =>
  makeAgentEvent(
    "control_request",
    {
      type: "control_request",
      request_id: id,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: `tool-${id}`,
        input: { questions: [{ question: "Continue?", header: "Next", options: [] }] },
      },
    },
    sequence,
  );

const cancel = (id: string, sequence: number) =>
  makeAgentEvent(
    "control_cancel_request",
    { type: "control_cancel_request", request_id: id },
    sequence,
  );

/** Only the Axon boundary is fake; connection, transport and read loop are real. */
class FakeAxon {
  readonly id = "axon-replay-contract";
  readonly subscriptions: Array<number | undefined> = [];
  readonly streams: ReturnType<typeof createControllableStream>[] = [];
  readonly published: unknown[] = [];
  readonly client = { get: async () => ({ total_count: this.history.at(-1)?.sequence }) };

  constructor(
    readonly history: MockAxonEvent[],
    private readonly disconnectAfter?: number,
  ) {}

  async subscribeSse(options?: { after_sequence: number }) {
    this.subscriptions.push(options?.after_sequence);
    const stream = createControllableStream(true);
    stream.stream.controller?.abort.mockImplementation(() => stream.end());
    this.streams.push(stream);
    for (const event of this.history) {
      if ((event.sequence ?? 0) <= (options?.after_sequence ?? 0)) continue;
      stream.push(event);
      if (this.streams.length === 1 && event.sequence === this.disconnectAfter) {
        stream.end();
        break;
      }
    }
    return stream.stream;
  }

  async publish(event: unknown) {
    this.published.push(event);
  }
}

const connections: ClaudeAxonConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.disconnect()));
});

async function connect(axon: FakeAxon, afterSequence?: number) {
  const dispatched: string[] = [];
  const observed: number[] = [];
  const connection = new ClaudeAxonConnection(
    axon as unknown as Axon,
    { id: "devbox-replay-contract" } as Devbox,
    { afterSequence, retry: { baseDelayMs: 1, maxDelayMs: 1 } },
  );
  connections.push(connection);
  connection.onAxonEvent((event) => observed.push(event.sequence));
  connection.onControlRequest("can_use_tool", (request) => {
    dispatched.push(request.request_id);
    // Model a parked application question. No response is persisted yet.
    return new Promise<SDKControlResponse>(() => {});
  });
  await connection.connect();
  return { connection, dispatched, observed };
}

describe("Claude question replay contract", () => {
  it.each([
    undefined,
    4,
  ])("does not re-park cancelled history (afterSequence=%s)", async (bound) => {
    const history = [
      question("old", 1),
      cancel("old", 2),
      makeSystemEvent("agent.interrupted", { agentId: "agent" }, 3),
      makeAgentEvent("result", { type: "result" }, 4),
      makeUserEvent("query", { type: "user" }, 5),
      question("current", 6),
    ];
    const axon = new FakeAxon(history);
    const result = await connect(axon, bound);
    await vi.waitFor(() => expect(result.dispatched).toEqual(["current"]));
    expect(result.observed).toEqual(bound === undefined ? [1, 2, 3, 4, 5, 6] : [5, 6]);
    expect(axon.subscriptions).toEqual([bound]);
    expect(axon.published).toEqual([]);
  });

  it.each([
    "allow",
    "deny",
    "error",
  ])("does not re-park an answered request (%s)", async (behavior) => {
    const axon = new FakeAxon([
      question("answered", 1),
      makeUserEvent(
        "control_response",
        {
          type: "control_response",
          response: {
            request_id: "answered",
            subtype: behavior === "error" ? "error" : "success",
            response: { behavior },
          },
        },
        2,
      ),
      question("pending", 3),
    ]);
    const result = await connect(axon);
    await vi.waitFor(() => expect(result.dispatched).toEqual(["pending"]));
  });

  it("preserves a pending identity across a newer query and a new owner connection", async () => {
    const axon = new FakeAxon([
      question("pending", 1),
      makeUserEvent("query", { type: "user" }, 2),
    ]);
    const first = await connect(axon);
    await vi.waitFor(() => expect(first.dispatched).toEqual(["pending"]));
    await first.connection.disconnect();
    const second = await connect(axon);
    await vi.waitFor(() => expect(second.dispatched).toEqual(["pending"]));
    expect(axon.published).toEqual([]);
  });

  it("only retires the matching id on an agent cancellation", async () => {
    const axon = new FakeAxon([
      question("pending", 1),
      cancel("unrelated", 2),
      makeUserEvent(
        "control_cancel_request",
        { type: "control_cancel_request", request_id: "pending" },
        3,
      ),
      makeAgentEvent("control_cancel_request", { type: "control_cancel_request" }, 4),
    ]);
    const result = await connect(axon);
    await vi.waitFor(() => expect(result.dispatched).toEqual(["pending"]));
  });

  it.each([
    true,
    false,
  ])("finishes replay after a dropped stream before dispatch (cancelled=%s)", async (cancelled) => {
    const axon = new FakeAxon(
      [
        question("old", 1),
        cancelled ? cancel("old", 2) : makeUserEvent("query", { type: "user" }, 2),
        question("current", 3),
      ],
      1,
    );
    const result = await connect(axon);
    await vi.waitFor(() =>
      expect(result.dispatched).toEqual(cancelled ? ["current"] : ["old", "current"]),
    );
    expect(axon.subscriptions).toEqual([undefined, 1]);
    expect(result.observed).toEqual([1, 2, 3]);
  });
});

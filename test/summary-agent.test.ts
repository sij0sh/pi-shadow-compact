import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsApiStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUMMARY_MAX_TOKENS } from "../src/constants.js";
import {
  runSummaryAgent,
  type CompletionInterface,
} from "../src/summary-agent.js";
import type { NormalizedPacket } from "../src/types.js";

function usage(n: number): Usage {
  return {
    input: n,
    output: n * 2,
    cacheRead: n * 3,
    cacheWrite: n * 4,
    totalTokens: n * 5,
    cost: { input: n, output: n, cacheRead: n, cacheWrite: n, total: n * 4 },
  };
}

function response(text: string, n = 1, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "summary",
    usage: usage(n),
    stopReason,
    timestamp: Date.now(),
  };
}

const sections = {
  objective: [{ text: "Implement the summary agent", evidenceRefs: ["ev-1"] }],
  constraints: [],
  completedWork: [],
  discoveries: [],
  decisions: [],
  currentState: [],
  rejectedApproaches: [],
  openIssues: [],
  nextActions: [],
  continuityData: [],
  modifiedFiles: [{ path: "src/summary-agent.ts", evidenceRefs: ["ev-1"] }],
  referencedFiles: [],
};
const inventory = JSON.stringify(sections);
const checkpoint = inventory;

const packet: NormalizedPacket = {
  evidence: [{ evidenceId: "ev-1", sourceEntryId: "entry-1", kind: "user", text: "Build it" }],
  digest: "digest",
  truncated: false,
  usedPreviousCheckpointFallback: false,
};

const config = {
  softCompactThresholdPercent: 60,
  summarizerModel: { provider: "configured", id: "summary-model" },
};

function messageText(message: Context["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function context(model: Model<Api>, finds: Array<[string, string]>): Pick<ExtensionContext, "model" | "modelRegistry"> {
  return {
    model,
    modelRegistry: {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        return model;
      },
    } as ExtensionContext["modelRegistry"],
  };
}

class FakeCompletion implements CompletionInterface {
  readonly calls: Array<{
    model: Model<Api>;
    context: Context;
    options: ModelsApiStreamOptions<Api>;
  }> = [];

  constructor(private readonly responses: AssistantMessage[]) {}

  async complete(
    model: Model<Api>,
    requestContext: Context,
    options: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage> {
    this.calls.push({ model, context: requestContext, options });
    const next = this.responses.shift();
    if (!next) throw new Error("Unexpected completion");
    return next;
  }
}

const model = { provider: "configured", id: "summary-model", api: "test" } as Model<Api>;

describe("runSummaryAgent", () => {
  it("runs extract, audit, and compress in one private conversation", async () => {
    const completion = new FakeCompletion([
      response(inventory, 1),
      response(inventory, 2),
      response(checkpoint, 3),
    ]);
    const finds: Array<[string, string]> = [];

    const result = await runSummaryAgent(context(model, finds), packet, config, {
      completion,
      customFocus: "Keep the user's exact API constraint",
    });

    assert.deepEqual(finds, [["configured", "summary-model"]]);
    assert.equal(completion.calls.length, 3);
    assert.ok(completion.calls.every((call) => call.model === model));
    const messageArrays = completion.calls.map((call) => call.context.messages);
    assert.ok(messageArrays.every((messages) => messages === messageArrays[0]));
    assert.deepEqual(messageArrays.map((messages) => messages.length), [6, 6, 6]);
    assert.match(messageText(messageArrays[0]![0]!), /Keep the user's exact API constraint/);
    const ids = completion.calls.map((call) => call.options.sessionId);
    assert.equal(new Set(ids).size, 1);
    assert.match(ids[0]!, /^[0-9a-f-]{36}$/i);
    for (const call of completion.calls) {
      assert.equal(call.options.cacheRetention, "none");
      assert.equal(call.options.maxTokens, SUMMARY_MAX_TOKENS);
    }
    assert.equal(result.usage.input, 6);
    assert.equal(result.usage.output, 12);
    assert.equal(result.usage.totalTokens, 30);
    assert.equal(result.usage.cost.total, 24);
    assert.deepEqual(result.evidenceRefs, ["ev-1"]);
    assert.match(result.summary, /^# Continuation Checkpoint/);
    assert.match(result.summary, /## Objective\n- Implement the summary agent/);
    assert.match(result.summary, /## Constraints and Preferences\n\(none\)/);
    assert.match(result.summary, /## Modified Files\n- src\/summary-agent\.ts/);
    assert.doesNotMatch(result.summary, /ev-1/);
  });

  it("uses the current Pi session model when the configured provider is blank", async () => {
    const completion = new FakeCompletion([
      response(inventory),
      response(inventory),
      response(checkpoint),
    ]);
    const finds: Array<[string, string]> = [];

    await runSummaryAgent(
      context(model, finds),
      packet,
      { ...config, summarizerModel: { provider: "", id: "" } },
      { completion },
    );

    assert.deepEqual(finds, []);
    assert.ok(completion.calls.every((call) => call.model === model));
  });

  it("allows one correction and includes its usage", async () => {
    const completion = new FakeCompletion([
      response(JSON.stringify({ ...sections, objective: [{ text: "bad", evidenceRefs: ["missing"] }] }), 1),
      response(inventory, 2),
      response(inventory, 3),
      response(checkpoint, 4),
    ]);

    const result = await runSummaryAgent(context(model, []), packet, config, { completion });

    assert.equal(completion.calls.length, 4);
    assert.match(
      messageText(completion.calls[1]!.context.messages[2]!),
      /Unknown evidence reference: missing/,
    );
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.totalTokens, 50);
  });

  it("rejects a second invalid response for a turn", async () => {
    const completion = new FakeCompletion([
      response("not json"),
      response("still not json"),
      response(inventory),
    ]);

    await assert.rejects(
      runSummaryAgent(context(model, []), packet, config, { completion }),
      /Model output is not valid JSON/,
    );
    assert.equal(completion.calls.length, 2);
  });

  it("rejects missing configured models", async () => {
    const ctx = {
      model,
      modelRegistry: { find: () => undefined } as unknown as ExtensionContext["modelRegistry"],
    };
    await assert.rejects(
      runSummaryAgent(ctx, packet, config),
      /Summary model not found: configured\/summary-model/,
    );
  });

  for (const testCase of [
    { name: "model errors", value: response("error", 1, "error"), error: /stopped with error/ },
    { name: "length stops", value: response("partial", 1, "length"), error: /stopped with length/ },
    { name: "empty output", value: response("  "), error: /empty response/ },
    {
      name: "tool calls",
      value: { ...response("ignored"), content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] } as AssistantMessage,
      error: /tool call/,
    },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      const completion = new FakeCompletion([testCase.value]);
      await assert.rejects(
        runSummaryAgent(context(model, []), packet, config, { completion }),
        testCase.error,
      );
      assert.equal(completion.calls.length, 1);
    });
  }

  it("passes the caller's abort signal and max-token override", async () => {
    const controller = new AbortController();
    const completion = new FakeCompletion([
      response(inventory),
      response(inventory),
      response(checkpoint),
    ]);
    await runSummaryAgent(context(model, []), packet, config, {
      completion,
      signal: controller.signal,
      maxTokens: 1234,
    });
    assert.ok(completion.calls.every((call) => call.options.signal === controller.signal));
    assert.ok(completion.calls.every((call) => call.options.maxTokens === 1234));
  });
});

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
import {
  SUMMARY_MAX_TOKENS,
  resolveSummarizerModel,
  runSummaryAgent,
  type CompletionInterface,
} from "../src/summary.js";
import type { NormalizedPacket } from "../src/normalize.js";

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

const checkpoint = {
  objective: [{ text: "Ship the summary agent", evidenceRefs: ["ev-1"] }],
  constraints: [{ text: "Stay evidence grounded", evidenceRefs: ["ev-1"] }],
  completedWork: [{ text: "Implemented runSummaryAgent", evidenceRefs: ["ev-1"] }],
  currentState: [],
  decisions: [],
  openIssues: [],
  nextActions: [],
  criticalContext: [],
  modifiedFiles: [{ text: "src/summary.ts", evidenceRefs: ["ev-1"] }],
  referencedFiles: [],
};
const valid = JSON.stringify(checkpoint);

const rendered = `# Continuation Checkpoint

## Objective
- Ship the summary agent

## Constraints
- Stay evidence grounded

## Completed Work
- Implemented runSummaryAgent

## Current State
(none)

## Decisions
(none)

## Open Issues
(none)

## Next Actions
(none)

## Critical Context
(none)

## Modified Files
- src/summary.ts

## Referenced Files
(none)
`;

const packet: NormalizedPacket = {
  evidence: [{ evidenceId: "ev-1", sourceEntryId: "e1", kind: "user", text: "Build it" }],
};

const config = {
  softCompactThresholdPercent: 60,
  summarizerModel: { provider: "configured", id: "summary" },
};
const blankModelConfig = { ...config, summarizerModel: { provider: "", id: "" } };

const sessionModel = { provider: "session", id: "current", api: "test" } as Model<Api>;
const summaryModel = { provider: "configured", id: "summary", api: "test" } as Model<Api>;

type SummaryContext = Pick<ExtensionContext, "model" | "modelRegistry">;

function registry(finds: Array<[string, string]>, found: Model<Api> | undefined): ExtensionContext["modelRegistry"] {
  return {
    find(provider: string, id: string) {
      finds.push([provider, id]);
      return found;
    },
  } as unknown as ExtensionContext["modelRegistry"];
}

function context(
  finds: Array<[string, string]>,
  found: Model<Api> | undefined,
): SummaryContext {
  return { model: sessionModel, modelRegistry: registry(finds, found) };
}

function contextWithoutSessionModel(
  finds: Array<[string, string]>,
  found: Model<Api> | undefined,
): SummaryContext {
  return { model: undefined, modelRegistry: registry(finds, found) };
}

class FakeCompletion implements CompletionInterface {
  readonly calls: Array<{
    model: Model<Api>;
    context: Context;
    messageCount: number;
    options: ModelsApiStreamOptions<Api>;
  }> = [];

  constructor(private readonly responses: AssistantMessage[]) {}

  async complete(
    model: Model<Api>,
    requestContext: Context,
    options?: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage> {
    this.calls.push({
      model,
      context: requestContext,
      messageCount: requestContext.messages.length,
      options: options as ModelsApiStreamOptions<Api>,
    });
    const next = this.responses.shift();
    if (!next) throw new Error("Unexpected completion");
    return next;
  }
}

function messageText(message: Context["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("resolveSummarizerModel", () => {
  it("resolves the configured pair through the model registry", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(context(finds, summaryModel), config);

    assert.deepEqual(finds, [["configured", "summary"]]);
    assert.equal(resolved, summaryModel);
  });

  it("uses the session model when the configured pair is blank", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(context(finds, summaryModel), blankModelConfig);

    assert.deepEqual(finds, []);
    assert.equal(resolved, sessionModel);
  });

  it("throws when the configured model is missing", () => {
    assert.throws(
      () => resolveSummarizerModel(context([], undefined), config),
      /Summary model not found: configured\/summary/,
    );
  });

  it("throws when the pair is blank and no session model exists", () => {
    assert.throws(
      () => resolveSummarizerModel(contextWithoutSessionModel([], summaryModel), blankModelConfig),
      /Summary model not found: current Pi session model/,
    );
  });
});

describe("runSummaryAgent", () => {
  it("returns the rendered checkpoint in a single turn", async () => {
    const completion = new FakeCompletion([response(valid)]);
    const finds: Array<[string, string]> = [];

    const result = await runSummaryAgent(context(finds, summaryModel), packet, config, {
      completion,
    });

    assert.deepEqual(finds, [["configured", "summary"]]);
    assert.equal(completion.calls.length, 1);
    const call = completion.calls[0]!;
    assert.equal(call.model, summaryModel);
    assert.equal(call.messageCount, 1);
    assert.match(call.context.systemPrompt ?? "", /evidence-grounded coding-session checkpoints/);
    assert.match(call.context.systemPrompt ?? "", /untrusted data/);
    const prompt = messageText(call.context.messages[0]!);
    assert.match(prompt, /Create a durable continuation checkpoint/);
    assert.ok(prompt.includes(JSON.stringify(packet.evidence)));
    assert.equal(call.options.maxTokens, SUMMARY_MAX_TOKENS);
    assert.equal(call.options.cacheRetention, "none");
    assert.match(call.options.sessionId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(result.summary, rendered);
    assert.doesNotMatch(result.summary, /ev-1/);
    assert.deepEqual(result.usage, usage(1));
  });

  it("runs on the session model for a blank configured pair", async () => {
    const completion = new FakeCompletion([response(valid)]);
    const finds: Array<[string, string]> = [];

    await runSummaryAgent(context(finds, summaryModel), packet, blankModelConfig, { completion });

    assert.deepEqual(finds, []);
    assert.equal(completion.calls[0]!.model, sessionModel);
  });

  it("validates one correction then succeeds, summing usage across attempts", async () => {
    const completion = new FakeCompletion([response("{not json", 2), response(valid, 3)]);

    const result = await runSummaryAgent(context([], summaryModel), packet, config, { completion });

    assert.equal(completion.calls.length, 2);
    assert.equal(completion.calls[0]!.messageCount, 1);
    assert.equal(completion.calls[1]!.messageCount, 3);
    assert.ok(completion.calls[1]!.context.messages === completion.calls[0]!.context.messages);
    assert.ok(completion.calls[1]!.options === completion.calls[0]!.options);
    assert.equal(
      completion.calls[1]!.options.sessionId,
      completion.calls[0]!.options.sessionId,
    );
    const correction = messageText(completion.calls[1]!.context.messages[2]!);
    assert.match(correction, /Your response was invalid: Model output is not valid JSON/);
    assert.match(correction, /Correct it once/);
    assert.equal(result.usage.input, 5);
    assert.equal(result.usage.output, 10);
    assert.equal(result.usage.totalTokens, 25);
    assert.equal(result.usage.cost.total, 20);
    assert.equal(result.summary, rendered);
  });

  it("throws when the second response is also invalid", async () => {
    const completion = new FakeCompletion([response("not json"), response("still not json")]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), packet, config, { completion }),
      /Model output is not valid JSON/,
    );
    assert.equal(completion.calls.length, 2);
  });

  for (const testCase of [
    { name: "error stops", value: response("boom", 1, "error"), error: /stopped with error/ },
    { name: "length stops", value: response("partial", 1, "length"), error: /stopped with length/ },
    {
      name: "tool calls",
      value: {
        ...response("ignored"),
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      } as AssistantMessage,
      error: /tool call/,
    },
    { name: "empty text", value: response("   "), error: /empty response/ },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      const completion = new FakeCompletion([testCase.value]);

      await assert.rejects(
        runSummaryAgent(context([], summaryModel), packet, config, { completion }),
        testCase.error,
      );
      assert.equal(completion.calls.length, 1);
    });
  }

  it("rejects unknown evidence references", async () => {
    const invalid = JSON.stringify({
      ...checkpoint,
      objective: [{ text: "Drift", evidenceRefs: ["ev-9"] }],
    });
    const completion = new FakeCompletion([response(invalid), response(invalid)]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), packet, config, { completion }),
      /Unknown evidence reference: ev-9/,
    );
  });

  it("rejects unexpected checkpoint keys", async () => {
    const invalid = JSON.stringify({ ...checkpoint, surprises: [] });
    const completion = new FakeCompletion([response(invalid), response(invalid)]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), packet, config, { completion }),
      /Unexpected checkpoint key: surprises/,
    );
  });

  it("rejects an entirely empty checkpoint", async () => {
    const invalid = JSON.stringify(Object.fromEntries(
      Object.keys(checkpoint).map((section) => [section, []]),
    ));
    const completion = new FakeCompletion([response(invalid), response(invalid)]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), packet, config, { completion }),
      /Checkpoint cannot be entirely empty/,
    );
  });

  it("passes the signal, max-token override, and custom focus on every attempt", async () => {
    const controller = new AbortController();
    const completion = new FakeCompletion([response("not json"), response(valid)]);
    const finds: Array<[string, string]> = [];

    const result = await runSummaryAgent(context(finds, summaryModel), packet, config, {
      completion,
      signal: controller.signal,
      maxTokens: 1234,
      customFocus: "Preserve the exact API contract",
    });

    assert.equal(completion.calls.length, 2);
    for (const call of completion.calls) {
      assert.equal(call.options.signal, controller.signal);
      assert.equal(call.options.maxTokens, 1234);
      assert.equal(call.options.cacheRetention, "none");
      assert.match(call.options.sessionId ?? "", /^[0-9a-f-]{36}$/i);
    }
    const firstPrompt = messageText(completion.calls[0]!.context.messages[0]!);
    assert.match(
      firstPrompt,
      /Preserve this explicit custom focus as a priority: "Preserve the exact API contract"/,
    );
    assert.equal(result.summary, rendered);
  });
});

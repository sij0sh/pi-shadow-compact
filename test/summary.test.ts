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
  ACTION_FIRST_ENV_VAR,
  RENDER_SECTIONS,
  isActionFirstEnabled,
  resolveRenderSections,
  resolveSummarizerModel,
  resolveVerificationModel,
  runSummaryAgent,
  runVerificationAgent,
  type Checkpoint,
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

## Next Actions
(none)

## Open Issues
(none)

## Current State
(none)

## Critical Context
(none)

## Completed Work
- Implemented runSummaryAgent

## Decisions
(none)

## Modified Files
- src/summary.ts

## Referenced Files
(none)
`;

const renderedLegacy = `# Continuation Checkpoint

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
  overflow: [],
  manifest: "",
  manifestOmitted: 0,
  rawEvidenceCount: 1,
  normalizedEvidenceCount: 1,
  evictedEvidenceCount: 0,
  truncatedItemCount: 0,
  packetTruncated: false,
  oldestRetainedSourceEntryId: "e1",
  newestRetainedSourceEntryId: "e1",
};

const config = {
  softCompactThresholdPercent: 60,
  hardCompactThresholdPercent: 80,
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
    assert.equal("maxTokens" in call.options, false);
    assert.equal(call.options.cacheRetention, "none");
    assert.match(call.options.sessionId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(result.summary, renderedLegacy);
    assert.doesNotMatch(result.summary, /ev-1/);
    assert.deepEqual(result.usage, usage(1));
  });

  it("forwards thinkingLevel as reasoning only for reasoning models", async () => {
    const reasoningModel = { provider: "configured", id: "summary", reasoning: true } as Model<Api>;
    const completion = new FakeCompletion([response(valid)]);
    await runSummaryAgent(context([], reasoningModel), packet, config, {
      completion,
      thinkingLevel: "high",
    });
    assert.equal((completion.calls[0]!.options as { reasoning?: unknown }).reasoning, "high");

    const off = new FakeCompletion([response(valid)]);
    await runSummaryAgent(context([], summaryModel), packet, config, {
      completion: off,
      thinkingLevel: "off",
    });
    assert.equal("reasoning" in off.calls[0]!.options, false);

    const plainModel = { provider: "p", id: "plain", api: "test" } as Model<Api>;
    const plain = new FakeCompletion([response(valid)]);
    await runSummaryAgent(context([], plainModel), packet, config, {
      completion: plain,
      thinkingLevel: "high",
    });
    assert.equal("reasoning" in plain.calls[0]!.options, false);
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
    assert.equal(result.summary, renderedLegacy);
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
    assert.equal(result.summary, renderedLegacy);
  });
});

describe("archived evidence retrieval handshake", () => {
  const archivedPacket: NormalizedPacket = {
    evidence: [{ evidenceId: "E0001", sourceEntryId: "e1", kind: "user", text: "Build it" }],
    overflow: [
      {
        evidenceId: "E0002",
        sourceEntryId: "e0",
        kind: "user",
        reason: "evicted",
        preview: "ARCHIVED_DETAIL deploy…",
        fullText: "ARCHIVED_DETAIL deploy only after canary",
      },
      {
        evidenceId: "E0003",
        sourceEntryId: "e-1",
        kind: "assistant",
        reason: "evicted",
        preview: "second archived…",
        fullText: "second archived note",
      },
      {
        evidenceId: "E0004",
        sourceEntryId: "e-2",
        kind: "assistant",
        reason: "evicted",
        preview: "third archived…",
        fullText: "third archived note",
      },
    ],
    manifest: '[\n{"id":"E0002","kind":"user","source":"e0","reason":"evicted","preview":"ARCHIVED_DETAIL deploy…"},\n{"id":"E0003","kind":"assistant","source":"e-1","reason":"evicted","preview":"second archived…"},\n{"id":"E0004","kind":"assistant","source":"e-2","reason":"evicted","preview":"third archived…"}\n]',
    manifestOmitted: 0,
    rawEvidenceCount: 4,
    normalizedEvidenceCount: 1,
    evictedEvidenceCount: 3,
    truncatedItemCount: 0,
    packetTruncated: true,
    oldestRetainedSourceEntryId: "e1",
    newestRetainedSourceEntryId: "e1",
  };

  function checkpointCiting(ref: string, objective = "Ship it after canary"): string {
    const remapped = Object.fromEntries(
      Object.entries(checkpoint).map(([section, items]) => [
        section,
        (items as Array<{ text: string }>).map((item) => ({ ...item, evidenceRefs: [ref] })),
      ]),
    );
    return JSON.stringify({
      ...remapped,
      objective: [{ text: objective, evidenceRefs: [ref] }],
    });
  }

  it("supplies archived full text on request, then accepts the citing checkpoint", async () => {
    const completion = new FakeCompletion([
      response(JSON.stringify({ needEvidence: ["E0002"] })),
      response(checkpointCiting("E0002")),
    ]);

    const result = await runSummaryAgent(context([], summaryModel), archivedPacket, config, {
      completion,
    });

    assert.equal(completion.calls.length, 2);
    assert.equal(result.retrievalRounds, 1);
    const supplied = messageText(completion.calls[1]!.context.messages[2]!);
    assert.match(supplied, /ARCHIVED_DETAIL deploy only after canary/);
    assert.match(result.summary, /Ship it after canary/);
  });

  it("rejects citations of never-fetched archived ids", async () => {
    const completion = new FakeCompletion([
      response(checkpointCiting("E0002")),
      response(checkpointCiting("E0002")),
    ]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), archivedPacket, config, { completion }),
      /Unknown evidence reference: E0002/,
    );
  });

  it("routes unknown-id requests through one correction", async () => {
    const completion = new FakeCompletion([
      response(JSON.stringify({ needEvidence: ["E9999"] })),
      response(checkpointCiting("E0001")),
    ]);

    const result = await runSummaryAgent(context([], summaryModel), archivedPacket, config, {
      completion,
    });

    assert.equal(completion.calls.length, 2);
    assert.equal(result.retrievalRounds, 0);
    const correction = messageText(completion.calls[1]!.context.messages[2]!);
    assert.match(correction, /Unknown archived evidence reference: E9999/);
  });

  it("throws once retrieval rounds are exhausted with no valid checkpoint", async () => {
    const completion = new FakeCompletion([
      response(JSON.stringify({ needEvidence: ["E9999"] })),
      response(JSON.stringify({ needEvidence: ["E0002"] })),
      response(JSON.stringify({ needEvidence: ["E0003"] })),
      response(JSON.stringify({ needEvidence: ["E0004"] })),
    ]);

    await assert.rejects(
      runSummaryAgent(context([], summaryModel), archivedPacket, config, { completion }),
      /retrieval exceeds 2 rounds/,
    );
    assert.equal(completion.calls.length, 4);
  });

  it("embeds the manifest in the prompt only when overflow exists", async () => {
    const withOverflow = new FakeCompletion([response(checkpointCiting("E0001"))]);
    await runSummaryAgent(context([], summaryModel), archivedPacket, config, {
      completion: withOverflow,
    });
    const overflowPrompt = messageText(withOverflow.calls[0]!.context.messages[0]!);
    assert.match(overflowPrompt, /Archived overflow evidence/);
    assert.match(overflowPrompt, /"E0002"/);
    assert.match(overflowPrompt, /needEvidence/);

    const withoutOverflow = new FakeCompletion([response(valid)]);
    await runSummaryAgent(context([], summaryModel), packet, config, {
      completion: withoutOverflow,
    });
    assert.doesNotMatch(
      messageText(withoutOverflow.calls[0]!.context.messages[0]!),
      /Archived overflow evidence/,
    );
  });
});

describe("action-first representation toggle", () => {
  it("defaults to legacy schema order", () => {
    const saved = process.env[ACTION_FIRST_ENV_VAR];
    delete process.env[ACTION_FIRST_ENV_VAR];
    try {
      assert.equal(isActionFirstEnabled(), false);
      assert.deepEqual([...resolveRenderSections()], [
        "objective",
        "constraints",
        "completedWork",
        "currentState",
        "decisions",
        "openIssues",
        "nextActions",
        "criticalContext",
        "modifiedFiles",
        "referencedFiles",
      ]);
    } finally {
      if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
      else process.env[ACTION_FIRST_ENV_VAR] = saved;
    }
  });

  for (const value of ["1", "true", "yes", "on", "TRUE", " 1 "]) {
    it(`enables action-first for ${JSON.stringify(value)}`, () => {
      const saved = process.env[ACTION_FIRST_ENV_VAR];
      process.env[ACTION_FIRST_ENV_VAR] = value;
      try {
        assert.equal(isActionFirstEnabled(), true);
        assert.deepEqual([...resolveRenderSections()], [...RENDER_SECTIONS]);
        assert.deepEqual([...resolveRenderSections()], [
          "objective",
          "constraints",
          "nextActions",
          "openIssues",
          "currentState",
          "criticalContext",
          "completedWork",
          "decisions",
          "modifiedFiles",
          "referencedFiles",
        ]);
      } finally {
        if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
        else process.env[ACTION_FIRST_ENV_VAR] = saved;
      }
    });
  }

  for (const value of ["0", "false", "no", "off", "FALSE", " 0 ", "", "2", "banana"]) {
    it(`disables action-first for ${JSON.stringify(value)}`, () => {
      const saved = process.env[ACTION_FIRST_ENV_VAR];
      process.env[ACTION_FIRST_ENV_VAR] = value;
      try {
        assert.equal(isActionFirstEnabled(), false);
        assert.deepEqual([...resolveRenderSections()], [
          "objective",
          "constraints",
          "completedWork",
          "currentState",
          "decisions",
          "openIssues",
          "nextActions",
          "criticalContext",
          "modifiedFiles",
          "referencedFiles",
        ]);
      } finally {
        if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
        else process.env[ACTION_FIRST_ENV_VAR] = saved;
      }
    });
  }

  it("renders legacy schema order with the legacy prompt when disabled", async () => {
    const saved = process.env[ACTION_FIRST_ENV_VAR];
    process.env[ACTION_FIRST_ENV_VAR] = "0";
    try {
      const completion = new FakeCompletion([response(valid)]);
      const result = await runSummaryAgent(context([], summaryModel), packet, config, {
        completion,
      });
      assert.equal(result.summary, renderedLegacy);
      const prompt = messageText(completion.calls[0]!.context.messages[0]!);
      assert.doesNotMatch(prompt, /required observable outcome/);
    } finally {
      if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
      else process.env[ACTION_FIRST_ENV_VAR] = saved;
    }
  });

  it("renders action-first order with the contracts instruction when explicitly enabled", async () => {
    const saved = process.env[ACTION_FIRST_ENV_VAR];
    process.env[ACTION_FIRST_ENV_VAR] = "1";
    try {
      const completion = new FakeCompletion([response(valid)]);
      const result = await runSummaryAgent(context([], summaryModel), packet, config, {
        completion,
      });
      assert.equal(result.summary, rendered);
      const prompt = messageText(completion.calls[0]!.context.messages[0]!);
      assert.match(prompt, /required observable outcome/);
      assert.match(prompt, /must not regress/);
      assert.match(prompt, /what verification remains necessary/);
      assert.match(prompt, /merely because code changed/);
      assert.match(prompt, /keep it explicitly unresolved/);
    } finally {
      if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
      else process.env[ACTION_FIRST_ENV_VAR] = saved;
    }
  });

  it("omits the contracts instruction from the legacy prompt by default", async () => {
    const saved = process.env[ACTION_FIRST_ENV_VAR];
    delete process.env[ACTION_FIRST_ENV_VAR];
    try {
      const completion = new FakeCompletion([response(valid)]);
      await runSummaryAgent(context([], summaryModel), packet, config, { completion });
      const prompt = messageText(completion.calls[0]!.context.messages[0]!);
      assert.doesNotMatch(prompt, /required observable outcome/);
      assert.doesNotMatch(prompt, /keep it explicitly unresolved/);
    } finally {
      if (saved === undefined) delete process.env[ACTION_FIRST_ENV_VAR];
      else process.env[ACTION_FIRST_ENV_VAR] = saved;
    }
  });
});

const verifierModel = { provider: "configured", id: "verifier", api: "test" } as Model<Api>;
const verifierConfig = {
  ...config,
  verificationModel: { provider: "configured", id: "verifier" },
};
const draft = checkpoint as Checkpoint;

describe("resolveVerificationModel", () => {
  it("reuses the summarizer model when no verification pair is configured", () => {
    const finds: Array<[string, string]> = [];

    assert.equal(resolveVerificationModel(context(finds, summaryModel), config), summaryModel);
    assert.deepEqual(finds, [["configured", "summary"]]);
  });

  it("reuses the session model when both pairs are blank", () => {
    const finds: Array<[string, string]> = [];

    assert.equal(resolveVerificationModel(context(finds, summaryModel), blankModelConfig), sessionModel);
    assert.deepEqual(finds, []);
  });

  it("resolves a configured verification pair through the model registry", () => {
    const finds: Array<[string, string]> = [];
    const registryWithVerifier = {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        return provider === "configured" && id === "verifier" ? verifierModel : undefined;
      },
    } as unknown as SummaryContext["modelRegistry"];

    const resolved = resolveVerificationModel(
      { model: sessionModel, modelRegistry: registryWithVerifier },
      verifierConfig,
    );

    assert.equal(resolved, verifierModel);
    assert.deepEqual(finds, [["configured", "verifier"]]);
  });

  it("throws when the configured verification model is missing", () => {
    assert.throws(
      () => resolveVerificationModel(context([], undefined), verifierConfig),
      /Verification model not found: configured\/verifier/,
    );
  });
});

describe("runVerificationAgent", () => {
  it("audits the draft against the evidence and returns the corrected checkpoint", async () => {
    const corrected = JSON.stringify({
      ...checkpoint,
      completedWork: [],
      openIssues: [{ text: "Tests still failing", evidenceRefs: ["ev-1"] }],
    });
    const completion = new FakeCompletion([response(corrected)]);
    const finds: Array<[string, string]> = [];

    const result = await runVerificationAgent(context(finds, summaryModel), packet, draft, config, {
      completion,
    });

    assert.deepEqual(finds, [["configured", "summary"]]);
    assert.equal(completion.calls.length, 1);
    const prompt = messageText(completion.calls[0]!.context.messages[0]!);
    assert.match(prompt, /Audit this draft continuation checkpoint/);
    assert.match(prompt, /claims of success such as tests passing/);
    assert.match(prompt, /high-risk/);
    assert.ok(prompt.includes(JSON.stringify(draft)));
    assert.ok(prompt.includes(JSON.stringify(packet.evidence)));
    assert.match(result.summary, /Tests still failing/);
    assert.doesNotMatch(result.summary, /Implemented runSummaryAgent/);
    assert.deepEqual(result.checkpoint.openIssues, [
      { text: "Tests still failing", evidenceRefs: ["ev-1"] },
    ]);
  });

  it("runs on the configured verification model when set", async () => {
    const completion = new FakeCompletion([response(valid)]);
    const finds: Array<[string, string]> = [];
    const registryWithVerifier = {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        if (provider === "configured" && id === "verifier") return verifierModel;
        if (provider === "configured" && id === "summary") return summaryModel;
        return undefined;
      },
    } as unknown as SummaryContext["modelRegistry"];

    await runVerificationAgent(
      { model: sessionModel, modelRegistry: registryWithVerifier },
      packet,
      draft,
      verifierConfig,
      { completion },
    );

    assert.deepEqual(finds, [["configured", "verifier"]]);
    assert.equal(completion.calls[0]!.model, verifierModel);
  });

  it("validates one correction then succeeds, summing usage across attempts", async () => {
    const completion = new FakeCompletion([response("{not json", 2), response(valid, 3)]);

    const result = await runVerificationAgent(context([], summaryModel), packet, draft, config, {
      completion,
    });

    assert.equal(completion.calls.length, 2);
    assert.equal(result.usage.input, 5);
    assert.equal(result.summary, renderedLegacy);
  });

  it("rejects unknown evidence references", async () => {
    const invalid = JSON.stringify({
      ...checkpoint,
      objective: [{ text: "Drift", evidenceRefs: ["ev-9"] }],
    });
    const completion = new FakeCompletion([response(invalid), response(invalid)]);

    await assert.rejects(
      runVerificationAgent(context([], summaryModel), packet, draft, config, { completion }),
      /Unknown evidence reference: ev-9/,
    );
  });

  it("treats an empty repair as unreliable so the caller fails closed", async () => {
    const completion = new FakeCompletion([response("{}"), response("{}")]);

    await assert.rejects(
      runVerificationAgent(context([], summaryModel), packet, draft, config, { completion }),
      /Missing checkpoint section: objective/,
    );
    assert.equal(completion.calls.length, 2);
  });

  it("labels verification failures distinctly from summary failures", async () => {
    const completion = new FakeCompletion([response("boom", 1, "error")]);

    await assert.rejects(
      runVerificationAgent(context([], summaryModel), packet, draft, config, { completion }),
      /Verification model stopped with error/,
    );
  });

  it("forwards thinkingLevel as reasoning only for reasoning models", async () => {
    const reasoningVerifier = { provider: "configured", id: "verifier", reasoning: true } as Model<Api>;
    const completion = new FakeCompletion([response(valid)]);
    await runVerificationAgent(context([], reasoningVerifier), packet, draft, config, {
      completion,
      thinkingLevel: "high",
    });
    assert.equal((completion.calls[0]!.options as { reasoning?: unknown }).reasoning, "high");

    const plain = new FakeCompletion([response(valid)]);
    await runVerificationAgent(context([], summaryModel), packet, draft, config, {
      completion: plain,
      thinkingLevel: "high",
    });
    assert.equal("reasoning" in plain.calls[0]!.options, false);
  });

  it("passes the signal and max-token override on every attempt", async () => {
    const controller = new AbortController();
    const completion = new FakeCompletion([response("not json"), response(valid)]);

    await runVerificationAgent(context([], summaryModel), packet, draft, config, {
      completion,
      signal: controller.signal,
      maxTokens: 1234,
    });

    assert.equal(completion.calls.length, 2);
    for (const call of completion.calls) {
      assert.equal(call.options.signal, controller.signal);
      assert.equal(call.options.maxTokens, 1234);
      assert.match(call.options.sessionId ?? "", /^[0-9a-f-]{36}$/i);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  runCheckpointBuilderAgent,
  runCheckpointVerifierAgent,
  UnusableCheckpointError,
} from "../src/checkpoint-agent.js";
import { defaultConfig } from "../src/config.js";
import { SessionHistoryIndex } from "../src/session-reader.js";
import type { Checkpoint } from "../src/summary.js";
import { userEntry } from "./helpers/index-fixture.js";

const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = { provider: "test", id: "agent", api: "test" } as Model<Api>;
const ctx = { model, modelRegistry: { find: () => model } } as unknown as Pick<
  ExtensionContext,
  "model" | "modelRegistry"
>;
const config = defaultConfig();

function branchFixture(): SessionEntry[] {
  return [
    userEntry("e1", null, "Set up the project scaffolding now"),
    userEntry("e2", "e1", "Add retry logic to the sync client"),
  ];
}

function checkpointPayload(objective = "Set up scaffolding", ref = "E0001"): Record<string, unknown> {
  return {
    objective: [{ text: objective, evidenceRefs: [ref] }],
    constraints: [],
    completedWork: [],
    currentState: [],
    decisions: [],
    openIssues: [],
    nextActions: [],
    criticalContext: [],
    modifiedFiles: [],
    referencedFiles: [],
    verificationState: [],
    continuationState: {
      currentGoal: objective,
      currentApproach: "work through the turns",
      immediateNextStep: "continue",
    },
  };
}

function toolResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.args as { [key: string]: import("@earendil-works/pi-ai").JsonValue },
    })),
    api: "test",
    provider: "test",
    model: "agent",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function textResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "agent",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type Handler = (context: Context) => AssistantMessage;

function scripted(handler: Handler) {
  const calls: Context[] = [];
  return {
    calls,
    completion: {
      async complete(_model: Model<Api>, context: Context, _options?: ModelsSimpleStreamOptions) {
        calls.push(context);
        return handler(context);
      },
    },
  };
}

function toolNames(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "toolResult")
    .map((message) => (message as { toolName: string }).toolName);
}

describe("runCheckpointBuilderAgent", () => {
  it("reports bounded sanitized provider failures with the model and builder stage", async () => {
    const secret = "unrecognized-" + "q".repeat(40);
    const failure = JSON.stringify({ api_key: secret, error: "gateway quota exceeded" }) + "x".repeat(2000);
    const fake = scripted(() => ({ ...textResponse(""), stopReason: "error", errorMessage: failure }));
    await assert.rejects(
      runCheckpointBuilderAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), config, { completion: fake.completion, model }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Summary model \(test\/agent\) stopped with error/);
        assert.match(error.message, /gateway quota exceeded/);
        assert.ok(!error.message.includes(secret));
        assert.ok(error.message.length < 1100);
        return true;
      },
    );
  });

  it("uses provider-neutral streaming for nested model calls", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => toolNames(context).includes("read_turn_range")
      ? toolResponse([{ id: "c2", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } }])
      : toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]));
    let simpleCalls = 0;
    const streamCtx = {
      model,
      modelRegistry: {
        complete: () => { throw new Error("provider-neutral requests must use streamSimple"); },
        streamSimple: (requestModel: Model<Api>, context: Context, options: unknown) => {
          simpleCalls++;
          assert.equal((options as { toolChoice: string }).toolChoice, "auto");
          return { result: () => fake.completion.complete(requestModel, context) };
        },
      },
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
    const outcome = await runCheckpointBuilderAgent(streamCtx, index, config, { model });
    assert.equal(outcome.coverageEndEntryId, "e2");
    assert.equal(simpleCalls, 2);
  });

  it("reads the session and submits a validated checkpoint", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        { id: "c2", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } },
      ]);
    });
    const outcome = await runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model });
    assert.ok(outcome.summary.includes("Set up scaffolding"));
    assert.equal(outcome.coverageEndEntryId, "e2");
    assert.equal(outcome.inspectedEntries, 2);
    assert.equal(outcome.toolRounds, 2);
  });

  it("rejects premature submits, then accepts once requirements are met", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      const names = toolNames(context);
      const submits = names.filter((name) => name === "submit_checkpoint").length;
      if (submits === 0) {
        return toolResponse([
          { id: "c1", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } },
        ]);
      }
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c2", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        { id: "c3", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } },
      ]);
    });
    const outcome = await runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model });
    assert.equal(outcome.coverageEndEntryId, "e2");
    // The rejection travels as a tool error, not a thrown exception.
    const results = fake.calls.at(-1)!.messages.filter((message) => message.role === "toolResult");
    assert.ok(results.some((message) => (message as { isError: boolean }).isError));
  });

  it("recovers after a bare-string completedWork item", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const bad = checkpointPayload();
    (bad as Record<string, unknown>).completedWork = ["Did the scaffolding"];
    const fake = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      const submits = names.filter((name) => name === "submit_checkpoint").length;
      if (submits === 0) {
        return toolResponse([
          { id: "c2", name: "submit_checkpoint", args: { checkpoint: bad, coverageEndEntryId: "e2" } },
        ]);
      }
      return toolResponse([
        { id: "c3", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } },
      ]);
    });
    const outcome = await runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model });
    assert.equal(outcome.coverageEndEntryId, "e2");
    const texts = fake.calls.flatMap((call) =>
      call.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => JSON.stringify((message as { content: Array<{ text: string }> }).content)),
    ).join("\n");
    assert.match(texts, /must be an object like/);
  });

  it("fails after repeated invalid submits", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        { id: "c2", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "nope" } },
      ]);
    });
    await assert.rejects(
      runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model }),
      /not on this branch/,
    );
  });

  it("rejects uncited evidence and empty continuation handoffs", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const badRef = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        {
          id: "c2",
          name: "submit_checkpoint",
          args: { checkpoint: checkpointPayload("goal", "E9999"), coverageEndEntryId: "e2" },
        },
      ]);
    });
    await assert.rejects(
      runCheckpointBuilderAgent(ctx, index, config, { completion: badRef.completion, model }),
      /Unknown evidence reference/,
    );

    const emptyHandoff = { ...checkpointPayload(), continuationState: undefined };
    const index2 = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const badHandoff = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        { id: "c2", name: "submit_checkpoint", args: { checkpoint: emptyHandoff, coverageEndEntryId: "e2" } },
      ]);
    });
    await assert.rejects(
      runCheckpointBuilderAgent(ctx, index2, config, { completion: badHandoff.completion, model }),
      /continuationState must carry/,
    );
  });

  it("rejects token-limited checkpoint output even when it contains a submit call", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => toolNames(context).includes("read_turn_range")
      ? { ...toolResponse([{ id: "c2", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e2" } }]), stopReason: "length" }
      : toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]));
    await assert.rejects(runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model }), /stopped with length/);
  });

  it("rewrites oversized recovery prose instead of slicing off the handoff", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      if (!toolNames(context).includes("read_turn_range")) {
        return toolResponse([{ id: "read", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      const rewritten = toolNames(context).includes("submit_checkpoint");
      return toolResponse([{ id: "submit", name: "submit_checkpoint", args: {
        checkpoint: checkpointPayload(rewritten ? "Concise goal" : "Repeated historical detail ".repeat(100)),
        coverageEndEntryId: "e2",
      } }]);
    });
    const result = await runCheckpointBuilderAgent(ctx, index, config, {
      completion: fake.completion, model, incompleteDraft: "unfinished historical prose",
      targetSummaryChars: 1000,
    });
    assert.equal(fake.calls.length, 3);
    assert.ok(result.summary.length <= 1000);
    assert.equal(result.checkpoint.continuationState.immediateNextStep, "continue");
    assert.ok(fake.calls.at(-1)!.messages.some((message) => message.role === "toolResult" &&
      JSON.stringify(message.content).includes("Rewrite the complete checkpoint")));
  });

  it("semantically rewrites ordinary checkpoints above the default prose target", async () => {
    const fake = scripted((context) => {
      if (!toolNames(context).includes("read_turn_range")) {
        return toolResponse([{ id: "read", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      const payload = checkpointPayload("Current goal");
      if (!toolNames(context).includes("submit_checkpoint")) {
        payload.decisions = Array.from({ length: 4 }, () => ({ text: "old decisions ".repeat(400), evidenceRefs: ["E0001"] }));
      }
      return toolResponse([{ id: "submit", name: "submit_checkpoint", args: { checkpoint: payload, coverageEndEntryId: "e2" } }]);
    });
    const result = await runCheckpointBuilderAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), config, { completion: fake.completion, model });
    assert.equal(fake.calls.length, 3);
    assert.ok(result.summary.length <= 16000);
    assert.equal(result.checkpoint.continuationState.immediateNextStep, "continue");
    assert.match(JSON.stringify(fake.calls.at(-1)), /Rewrite the complete checkpoint/);
  });

  it("fails closed when ordinary prose remains oversized through bounded corrections", async () => {
    const fake = scripted((context) => {
      if (!toolNames(context).includes("read_turn_range")) return toolResponse([{ id: "read", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      const payload = checkpointPayload();
      payload.decisions = Array.from({ length: 4 }, () => ({ text: "old decisions ".repeat(400), evidenceRefs: ["E0001"] }));
      return toolResponse([{ id: "submit", name: "submit_checkpoint", args: { checkpoint: payload, coverageEndEntryId: "e2" } }]);
    });
    await assert.rejects(runCheckpointBuilderAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), config, { completion: fake.completion, model }), /Rewrite the complete checkpoint/);
    assert.equal(fake.calls.length, 4, "one read and at most three rejected submissions");
  });

  it("throws when the model never calls tools", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted(() => textResponse("here is my summary prose"));
    await assert.rejects(
      runCheckpointBuilderAgent(ctx, index, config, { completion: fake.completion, model }),
      /without a tool call/,
    );
  });
});

describe("runCheckpointVerifierAgent", () => {
  const draft = checkpointPayload("Draft goal") as unknown as Checkpoint;
  const draftCoverage = {
    sourceStartEntryId: null,
    coverageEndEntryId: "e2",
    preparedAtLeafId: "e2",
    publishedAtLeafId: "e2",
  };

  it("accepts after independent inspection", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_session_turn")) {
        return toolResponse([{ id: "c1", name: "read_session_turn", args: { turnId: "turn-2" } }]);
      }
      return toolResponse([{ id: "c2", name: "submit_verdict", args: { verdict: "accept" } }]);
    });
    const outcome = await runCheckpointVerifierAgent(ctx, index, draft, draftCoverage, config, {
      completion: fake.completion,
      model,
    });
    assert.equal(outcome.verdict, "accept");
    assert.ok(outcome.summary.includes("Draft goal"));
  });

  it("repairs with a corrected checkpoint grounded in its own reads", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        {
          id: "c2",
          name: "submit_verdict",
          args: {
            verdict: "repair",
            checkpoint: checkpointPayload("Repaired goal"),
            coverageEndEntryId: "e2",
          },
        },
      ]);
    });
    const outcome = await runCheckpointVerifierAgent(ctx, index, draft, draftCoverage, config, {
      completion: fake.completion,
      model,
    });
    assert.equal(outcome.verdict, "repair");
    assert.ok(outcome.summary.includes("Repaired goal"));
  });

  it("requires full independent coverage before accepting a compressed recovery checkpoint", async () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const fake = scripted((context) => {
      if (!toolNames(context).includes("read_session_turn")) {
        return toolResponse([{ id: "read", name: "read_session_turn", args: { turnId: "turn-2" } }]);
      }
      return toolResponse([{ id: "accept", name: "submit_verdict", args: { verdict: "accept" } }]);
    });
    await assert.rejects(runCheckpointVerifierAgent(ctx, index, draft, draftCoverage, config, {
      completion: fake.completion, model, targetSummaryChars: 1000,
    }), /inspection requirements unmet/);
  });

  it("rejects oversized compressed repairs and repeated token-limited verdicts", async () => {
    const oversized = scripted((context) => toolNames(context).includes("read_turn_range")
      ? toolResponse([{ id: "repair", name: "submit_verdict", args: {
          verdict: "repair", checkpoint: checkpointPayload("old prose ".repeat(500)), coverageEndEntryId: "e2",
        } }])
      : toolResponse([{ id: "read", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]));
    await assert.rejects(runCheckpointVerifierAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), draft, draftCoverage, config, {
      completion: oversized.completion, model, targetSummaryChars: 1000,
    }), /Rewrite the complete checkpoint/);
    const capped = scripted(() => ({
      ...toolResponse([{ id: "accept", name: "submit_verdict", args: { verdict: "accept" } }]),
      stopReason: "length",
    }));
    await assert.rejects(runCheckpointVerifierAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), draft, draftCoverage, config, {
      completion: capped.completion, model, targetSummaryChars: 1000,
    }), /stopped with length/);
    assert.equal(capped.calls.length, 1, "a recovery cap is terminal even with a parsed submit call");
  });

  it("rejects an oversized ordinary verifier repair instead of installing or slicing it", async () => {
    const fake = scripted((context) => {
      if (!toolNames(context).includes("read_turn_range")) return toolResponse([{ id: "read", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      const payload = checkpointPayload();
      payload.decisions = Array.from({ length: 4 }, () => ({ text: "old decisions ".repeat(400), evidenceRefs: ["E0001"] }));
      return toolResponse([{ id: "repair", name: "submit_verdict", args: { verdict: "repair", checkpoint: payload, coverageEndEntryId: "e2" } }]);
    });
    await assert.rejects(runCheckpointVerifierAgent(ctx, new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" }), draft, draftCoverage, config, { completion: fake.completion, model }), /Rewrite the complete checkpoint/);
    assert.equal(fake.calls.length, 4);
  });

  it("requires inspection and surfaces unusable verdicts", async () => {
    const hasty = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const noRead = scripted(() =>
      toolResponse([{ id: "c1", name: "submit_verdict", args: { verdict: "accept" } }]),
    );
    await assert.rejects(
      runCheckpointVerifierAgent(ctx, hasty, draft, draftCoverage, config, { completion: noRead.completion, model }),
      /at least one read tool/,
    );

    const hopeless = new SessionHistoryIndex({ branch: branchFixture(), cwd: "/repo" });
    const unusable = scripted((context) => {
      const names = toolNames(context);
      if (!names.includes("read_turn_range")) {
        return toolResponse([{ id: "c1", name: "read_turn_range", args: { startTurn: 1, count: 10 } }]);
      }
      return toolResponse([
        { id: "c2", name: "submit_verdict", args: { verdict: "unusable", reason: "empty history" } },
      ]);
    });
    await assert.rejects(
      runCheckpointVerifierAgent(ctx, hopeless, draft, draftCoverage, config, {
        completion: unusable.completion,
        model,
      }),
      UnusableCheckpointError,
    );
  });
});

describe("private transcript bounds", () => {
  it("elides older read results explicitly once the transcript exceeds its budget", async () => {
    const small = { ...model, contextWindow: 10_000 } as Model<Api>;
    const branch: SessionEntry[] = [];
    for (let i = 1; i <= 6; i++) branch.push(userEntry(`e${i}`, i > 1 ? `e${i - 1}` : null, `task ${i} `.repeat(500)));
    const fake = scripted((context) => {
      const reads = toolNames(context).filter((name) => name === "read_session_entries").length;
      if (reads < 3) {
        return toolResponse([{ id: `r${reads}`, name: "read_session_entries", args: { start: reads * 2, count: 2 } }]);
      }
      return toolResponse([{ id: "submit", name: "submit_checkpoint", args: { checkpoint: checkpointPayload(), coverageEndEntryId: "e6" } }]);
    });
    const outcome = await runCheckpointBuilderAgent(ctx, new SessionHistoryIndex({ branch, cwd: "/repo" }), config, { completion: fake.completion, model: small });
    assert.equal(outcome.coverageEndEntryId, "e6");
    const last = fake.calls.at(-1)!;
    const results = last.messages.filter((message) => message.role === "toolResult")
      .map((message) => (message as { content: Array<{ text: string }> }).content[0]!.text);
    const elided = results.filter((text) => text.includes('"elided":true'));
    assert.ok(elided.length >= 1);
    assert.deepEqual(JSON.parse(elided[0]!).evidenceIds, { first: "E0001", last: "E0002", count: 2 });
    assert.ok(!results.at(-1)!.includes('"elided":true'), "the latest read stays visible");
    const transcript = last.messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
    assert.ok(transcript <= 20_000, `transcript ${transcript} exceeds budget`);
  });
});

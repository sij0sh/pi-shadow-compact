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

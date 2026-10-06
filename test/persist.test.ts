import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { MODE_ENV_VAR } from "../src/config.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_CUSTOM_TYPE_LEGACY,
  collectShadowSummaries,
  checkpointStalenessReason,
  findLatestPersistedCheckpoint,
  findLatestRestorableCheckpoint,
  isPersistedShadowCheckpoint,
  SHADOW_CHAIN_LIMIT,
  toPreparedResult,
  type PersistedShadowCheckpoint,
  type PersistedShadowCheckpointV1,
  type PersistedShadowCheckpointV2Legacy,
  type PersistedShadowCheckpointV3,
} from "../src/persist.js";
import { combineUsage } from "../src/summary.js";
import { SessionHistoryIndex } from "../src/session-reader.js";
import { TRACE_FILE_ENV_VAR } from "../src/trace.js";
import {
  fixture,
  fixtureWithHistory,
  userEntry,
  waitFor,
  tick,
  USAGE,
  type Fixture,
} from "./helpers/index-fixture.js";

function assistantToolCallEntry(id: string, parentId: string, callId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }],
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(id: string, parentId: string, callId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

const SWAP_CONFIG = {
  prepareThresholdPercent: 60,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
};

function structuredFixture(): PersistedShadowCheckpointV3["structured"] {
  return {
    objective: [{ text: "objective", evidenceRefs: ["E0001"] }],
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
      currentGoal: "goal",
      currentApproach: "approach",
      immediateNextStep: "next",
    },
  };
}

function checkpointDataV3(
  overrides: Partial<PersistedShadowCheckpointV3> = {},
): PersistedShadowCheckpointV3 {
  return {
    ...checkpointData(),
    version: 3,
    structured: structuredFixture(),
    coverage: {
      sourceStartEntryId: null,
      coverageEndEntryId: "e3",
      preparedAtLeafId: "e4",
      publishedAtLeafId: "e4",
    },
    prompts: { summaryPromptVersion: 2, verifierPromptVersion: 2 },
    generatedAt: 0,
    ...overrides,
  };
}

function checkpointDataV2Legacy(
  overrides: Partial<PersistedShadowCheckpointV2Legacy> = {},
): PersistedShadowCheckpointV2Legacy {
  return {
    ...checkpointData(),
    version: 2,
    structured: structuredFixture(),
    coverage: {
      sourceStartEntryId: null,
      coverageEndEntryId: "e3",
      preparedAtLeafId: "e4",
      publishedAtLeafId: "e4",
    },
    prompts: { summaryPromptVersion: 2, verifierPromptVersion: 2, relevancePromptVersion: 1 },
    historicTurns: [],
    generatedAt: 0,
    ...overrides,
  };
}

function checkpointData(
  overrides: Partial<PersistedShadowCheckpointV1> = {},
): PersistedShadowCheckpointV1 {
  return {
    version: 1,
    checkpointId: "checkpoint-test",
    sessionId: "session-1",
    summary: "# Continuation Checkpoint\n\n## Objective\n- test checkpoint",
    firstKeptEntryId: "e4",
    leafId: "e4",
    latestCompactionId: null,
    contextTokensBefore: 600,
    usage: USAGE,
    details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

type TraceRecord = Record<string, unknown> & { event: string };

async function withTraceFile<T>(run: () => Promise<T>): Promise<{ result: T; events: TraceRecord[] }> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-persist-"));
  const path = join(dir, "trace.jsonl");
  const previous = process.env[TRACE_FILE_ENV_VAR];
  process.env[TRACE_FILE_ENV_VAR] = path;
  try {
    const result = await run();
    let events: TraceRecord[] = [];
    try {
      const text = await readFile(path, "utf8");
      events = text
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TraceRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { result, events };
  } finally {
    if (previous === undefined) delete process.env[TRACE_FILE_ENV_VAR];
    else process.env[TRACE_FILE_ENV_VAR] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function ofType(events: TraceRecord[], type: string): TraceRecord[] {
  return events.filter((event) => event.event === type);
}

describe("persisted checkpoint validation", () => {
  it("accepts a well-formed checkpoint and rejects malformed ones", () => {
    assert.equal(isPersistedShadowCheckpoint(checkpointData()), true);
    assert.equal(isPersistedShadowCheckpoint(undefined), false);
    assert.equal(isPersistedShadowCheckpoint("garbage"), false);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointData(), version: 2 }), false);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointData(), summary: "" }), false);
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointData(), latestCompactionId: 42 }),
      false,
    );
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointData(), details: { readFiles: "x" } }),
      false,
    );
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointData(), usage: { input: 1 } }),
      false,
    );
  });

  it("finds the newest valid checkpoint, skipping foreign and corrupt entries", async () => {
    const f = await fixture();
    try {
      assert.equal(findLatestPersistedCheckpoint(f.branch), undefined);
      f.appendCustom({ hello: "foreign" }, "other-extension.state");
      assert.equal(findLatestPersistedCheckpoint(f.branch), undefined);
      f.appendCustom(checkpointData({ checkpointId: "A" }));
      f.appendCustom("corrupt", CHECKPOINT_CUSTOM_TYPE);
      assert.equal(findLatestPersistedCheckpoint(f.branch)?.checkpoint.checkpointId, "A");
      f.appendCustom(checkpointData({ checkpointId: "B" }));
      const found = findLatestPersistedCheckpoint(f.branch);
      assert.equal(found?.checkpoint.checkpointId, "B");
    } finally {
      await f.cleanup();
    }
  });

  it("reports the exact staleness reason", async () => {
    const f = await fixture();
    try {
      const branch = f.branch;
      assert.equal(checkpointStalenessReason(branch, "session-1", checkpointData()), undefined);
      assert.equal(
        checkpointStalenessReason(branch, "other", checkpointData()),
        "session-mismatch",
      );
      assert.equal(
        checkpointStalenessReason(branch, "session-1", checkpointData({ firstKeptEntryId: "missing" })),
        "missing-first-kept",
      );
      assert.equal(
        checkpointStalenessReason(branch, "session-1", checkpointData({ leafId: "missing" })),
        "missing-leaf",
      );
      f.appendCompaction();
      assert.equal(
        checkpointStalenessReason(f.branch, "session-1", checkpointData()),
        "compaction-mismatch",
      );
      assert.equal(
        checkpointStalenessReason(
          f.branch,
          "session-1",
          checkpointData({ latestCompactionId: "c1" }),
        ),
        undefined,
      );
    } finally {
      await f.cleanup();
    }
  });

  it("round-trips a checkpoint back into the serving shape", () => {
    const data = checkpointData({ checkpointId: "round-trip" });
    const result = toPreparedResult(data);
    assert.equal(result.checkpointId, "round-trip");
    assert.equal(result.sessionId, "session-1");
    assert.equal(result.summary, data.summary);
    assert.equal(result.firstKeptEntryId, "e4");
    assert.equal(result.leafId, "e4");
    assert.equal(result.latestCompactionId, null);
    assert.equal(result.contextTokensBefore, 600);
    assert.deepEqual(result.usage, USAGE);
    assert.deepEqual(result.details, { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] });
    assert.equal(result.coverage, undefined);
    assert.equal(result.structured, undefined);
  });

  it("accepts v3 checkpoints and rejects malformed v3 payloads", () => {
    assert.equal(isPersistedShadowCheckpoint(checkpointDataV3()), true);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV3(), structured: {} }), false);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV3(), coverage: null }), false);
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointDataV3(), coverage: { coverageEndEntryId: "e3" } }),
      false,
    );
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV3(), prompts: {} }), false);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV3(), generatedAt: "now" }), false);
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV3(), version: 4 }), false);
  });

  it("accepts legacy v2 checkpoints and rejects malformed v2 payloads", () => {
    assert.equal(isPersistedShadowCheckpoint(checkpointDataV2Legacy()), true);
    // The Jev payload must be structurally present (a corrupt v2 entry is
    // skipped like any corrupt entry) even though restore ignores it.
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointDataV2Legacy(), historicTurns: {} }),
      false,
    );
    assert.equal(
      isPersistedShadowCheckpoint({
        ...checkpointDataV2Legacy(),
        prompts: { summaryPromptVersion: 2, verifierPromptVersion: 2 },
      }),
      false,
    );
    assert.equal(isPersistedShadowCheckpoint({ ...checkpointDataV2Legacy(), structured: {} }), false);
    assert.equal(
      isPersistedShadowCheckpoint({ ...checkpointDataV2Legacy(), generatedAt: "now" }),
      false,
    );
  });

  it("reports missing-coverage-end for v2 and v3 checkpoints off the branch", async () => {
    const f = await fixture();
    try {
      // The v2 arm is the migration regression: old checkpoints must not
      // skip coverage validation just because the schema moved to v3.
      for (const data of [checkpointDataV2Legacy(), checkpointDataV3()]) {
        assert.equal(checkpointStalenessReason(f.branch, "session-1", data), undefined);
        assert.equal(
          checkpointStalenessReason(f.branch, "session-1", {
            ...data,
            coverage: {
              sourceStartEntryId: null,
              coverageEndEntryId: "missing",
              preparedAtLeafId: "e4",
              publishedAtLeafId: "e4",
            },
          }),
          "missing-coverage-end",
        );
      }
    } finally {
      await f.cleanup();
    }
  });

  it("round-trips a v3 checkpoint back into the serving shape", () => {
    const data = checkpointDataV3({ checkpointId: "round-trip-v3" });
    const result = toPreparedResult(data);
    assert.equal(result.checkpointId, "round-trip-v3");
    assert.equal(result.coverage?.coverageEndEntryId, "e3");
    assert.equal(result.structured?.objective[0]?.text, "objective");
    assert.deepEqual(result.prompts, {
      summaryPromptVersion: 2,
      verifierPromptVersion: 2,
    });
    assert.ok(!("historicTurns" in result));
  });

  it("restores a legacy v2 checkpoint while discarding its Jev payload", () => {
    const data = checkpointDataV2Legacy({
      checkpointId: "round-trip-v2",
      historicTurns: [{ turn: { id: "turn-1" }, relevance: 0.9, reason: "fake" }],
    });
    const result = toPreparedResult(data);
    assert.equal(result.checkpointId, "round-trip-v2");
    assert.equal(result.coverage?.coverageEndEntryId, "e3");
    assert.equal(result.structured?.objective[0]?.text, "objective");
    assert.deepEqual(result.prompts, {
      summaryPromptVersion: 2,
      verifierPromptVersion: 2,
    });
    assert.ok(!("historicTurns" in result));
  });
});

describe("newest current checkpoint wins", () => {
  it("skips a stale newest checkpoint and restores the older current one", async () => {
    const f = await fixture();
    try {
      f.appendCustom(checkpointData({ checkpointId: "A" }));
      f.appendCustom(checkpointData({ checkpointId: "B", firstKeptEntryId: "missing" }));
      const search = findLatestRestorableCheckpoint(f.branch, "session-1");
      assert.equal(search.found?.checkpoint.checkpointId, "A");
      assert.deepEqual(search.skippedStale, [
        { checkpointId: "B", reason: "missing-first-kept" },
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("reports every stale candidate newest-first and ignores corrupt entries", async () => {
    const f = await fixture();
    try {
      f.appendCustom(checkpointData({ checkpointId: "old", sessionId: "other-session" }));
      f.appendCustom("corrupt", CHECKPOINT_CUSTOM_TYPE);
      f.appendCustom(checkpointData({ checkpointId: "new", firstKeptEntryId: "missing" }));
      const search = findLatestRestorableCheckpoint(f.branch, "session-1");
      assert.equal(search.found, undefined);
      assert.deepEqual(search.skippedStale, [
        { checkpointId: "new", reason: "missing-first-kept" },
        { checkpointId: "old", reason: "session-mismatch" },
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("reload serves the older current checkpoint past a stale newest one", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture(SWAP_CONFIG);
      try {
        f.appendCustom(checkpointData({ checkpointId: "A", summary: "SUMMARY-A" }));
        f.appendCustom(
          checkpointData({ checkpointId: "B", summary: "SUMMARY-B", firstKeptEntryId: "missing" }),
        );
        const g = f.restart();
        try {
          await g.emit("session_start");
          const outcome = (await g.emit("context", { messages: g.contextMessages() })) as {
            messages: Array<Record<string, unknown>>;
          };
          assert.match(outcome.messages[0]?.summary as string, /SUMMARY-A/);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });
    const rejected = ofType(events, "checkpoint_restore_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.checkpointId, "B");
    const restored = ofType(events, "checkpoint_restored");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.checkpointId, "A");
  });

  it("skips the swap when the restored cut would orphan a tool result", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture(SWAP_CONFIG);
      try {
        f.setBranch([
          userEntry("e1", null, "one"),
          assistantToolCallEntry("a1", "e1", "call-1"),
          toolResultEntry("r1", "a1", "call-1"),
          userEntry("e2", "r1", "two"),
        ]);
        f.appendCustom(checkpointData({ firstKeptEntryId: "r1", leafId: "e2" }));
        const g = f.restart();
        try {
          await g.emit("session_start");
          // The cut lands on the tool result while its call drops off: serving
          // it would poison the request, so the swap stays out and Pi sends the
          // full context instead.
          assert.equal(await g.emit("context", { messages: g.contextMessages() }), undefined);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });
    // The checkpoint restored into service, so the skip came from the
    // pair-integrity guard rather than from having nothing to serve.
    assert.equal(ofType(events, "checkpoint_restored").length, 1);
    const swaps = ofType(events, "swap_applied");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]?.action, "skipped-orphan");
    assert.equal(swaps[0]?.messagesDropped, 2);
  });

  it("reload serves a legacy v2 checkpoint while discarding its obsolete historic-turn payload", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.appendCustom(
        checkpointDataV2Legacy({
          checkpointId: "V2",
          summary: "SUMMARY-V2",
          // Obsolete payload, including entries long off the branch: restore
          // must ignore it entirely, not filter or serve it.
          historicTurns: [
            { turn: { id: "turn-1", entryIds: ["gone"] }, relevance: 1, reason: "fake" },
          ],
        }),
      );
      const g = f.restart();
      try {
        await g.emit("session_start");
        const outcome = (await g.emit("context", { messages: g.contextMessages() })) as {
          messages: Array<Record<string, unknown>>;
        };
        const summary = outcome.messages[0]?.summary as string;
        assert.match(summary, /SUMMARY-V2/);
        assert.ok(!summary.includes("turn-1"));
      } finally {
        await g.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  });

  it("reads checkpoints persisted under the legacy namespace", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.appendCustom(
        checkpointData({ checkpointId: "LEGACY", summary: "SUMMARY-LEGACY" }),
        CHECKPOINT_CUSTOM_TYPE_LEGACY,
      );
      const g = f.restart();
      try {
        await g.emit("session_start");
        const outcome = (await g.emit("context", { messages: g.contextMessages() })) as {
          messages: Array<Record<string, unknown>>;
        };
        assert.match(outcome.messages[0]?.summary as string, /SUMMARY-LEGACY/);
      } finally {
        await g.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  });
});

describe("soft durability without compaction", () => {
  it("persists once at settle with the full checkpoint payload; raw evidence stays intact", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture(SWAP_CONFIG);
      try {
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled === 4);
        await tick();
        await f.emit("agent_settled");

        assert.equal(f.compactCalls.length, 0, "no ctx.compact() on ordinary soft settle");
        assert.equal(f.appendedEntries.length, 1);
        const [persisted] = f.appendedEntries;
        assert.equal(persisted?.customType, CHECKPOINT_CUSTOM_TYPE);
        const data = persisted?.data as PersistedShadowCheckpoint;
        assert.equal(data.version, 3);
        assert.ok(data.version === 3);
        assert.ok(typeof data.checkpointId === "string" && data.checkpointId.length > 0);
        assert.equal(data.sessionId, "session-1");
        assert.match(data.summary, /Prepared continuation checkpoint/);
        assert.equal(data.firstKeptEntryId, "e1");
        assert.equal(data.leafId, "e4");
        assert.equal(data.latestCompactionId, null);
        assert.equal(data.contextTokensBefore, 600);
        assert.deepEqual(data.usage, [USAGE, USAGE, USAGE, USAGE].reduce(combineUsage));
        assert.deepEqual(data.details, {
          readFiles: ["src/read.ts"],
          modifiedFiles: ["src/edited.ts"],
        });
        assert.ok(typeof data.createdAt === "number");
        assert.equal(data.coverage.coverageEndEntryId, "e4");
        assert.equal(data.coverage.preparedAtLeafId, "e4");
        assert.equal(data.coverage.publishedAtLeafId, "e4");
        assert.deepEqual(data.prompts, {
          summaryPromptVersion: 3,
          verifierPromptVersion: 3,
        });
        assert.match(data.structured.objective[0]?.text ?? "", /Prepared continuation checkpoint/);
        assert.ok(!("historicTurns" in data), "v3 carries no historic-turn payload");

        // The session file still holds the complete raw pre-checkpoint evidence.
        const ids = f.branch.map((entry) => entry.id);
        assert.deepEqual(ids.slice(0, 4), ["e1", "e2", "e3", "e4"]);
        assert.ok(f.branch.every((entry) => entry.type !== "compaction"));

        await f.emit("agent_settled");
        assert.equal(f.appendedEntries.length, 1, "settle persists exactly once");
      } finally {
        await f.cleanup();
      }
    });
    assert.equal(ofType(events, "checkpoint_persisted").length, 1);
  });

  it("custom checkpoint entries do not enter LLM context", async () => {
    const f = await fixture();
    try {
      const before = buildSessionContext(f.branch, "e4").messages;
      f.appendCustom(checkpointData());
      const after = buildSessionContext(f.branch, "e4").messages;
      assert.deepEqual(after, before);
      assert.ok(before.length > 0);
    } finally {
      await f.cleanup();
    }
  });

  it("the emergency hatch still runs one native compaction and persists nothing", async () => {
    const f = await fixture();
    try {
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
      assert.equal(f.appendedEntries.length, 0);
    } finally {
      await f.cleanup();
    }
  });
});

describe("persistent two-turn lifecycle with reload", () => {
  it("turn 1 persists A, turn 2 replaces it with B, reload restores B serving", async () => {
    const { result, events } = await withTraceFile(async () => {
      const f = await fixtureWithHistory(SWAP_CONFIG);
      try {
        // USER TURN 1: cross 60% -> prepare A -> publish -> swap -> settle -> persist A.
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled === 4);
        await tick();
        const swapA = (await f.emit("context", { messages: f.contextMessages() })) as {
          messages: Array<Record<string, unknown>>;
        };
        assert.equal(swapA?.messages[0]?.role, "compactionSummary");
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0, "NO ctx.compact() on soft settle");
        assert.equal(f.appendedEntries.length, 1, "A persisted as CustomEntry");
        const checkpointA = f.appendedEntries[0]?.data as PersistedShadowCheckpoint;

        // USER TURN 2: A still serves while context grows back across soft.
        const stillA = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(stillA, "A still serves");
        f.setPercent(30);
        await f.emit("turn_end");
        assert.equal(f.registry.calls, 4, "below-threshold re-arms without preparing");
        f.setPercent(65);
        f.gate();
        await f.emit("turn_end");
        assert.equal(f.registry.calls, 5, "B prepares while A serves");
        const servingDuringB = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(servingDuringB, "A keeps serving while B prepares");
        f.release();
        await waitFor(() => f.registry.settled === 8);
        await tick();
        const swapB = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(swapB, "B swaps in");
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0, "NO ctx.compact() on soft settle");
        assert.equal(f.appendedEntries.length, 2, "B persisted");
        const checkpointB = f.appendedEntries[1]?.data as PersistedShadowCheckpoint;
        assert.notEqual(checkpointB.checkpointId, checkpointA.checkpointId);

        // Reload: a new extension instance restores the latest valid checkpoint.
        const g = f.restart();
        try {
          await g.emit("session_start");
          const first = (await g.emit("context", { messages: g.contextMessages() })) as {
            messages: Array<Record<string, unknown>>;
          };
          assert.equal(first?.messages[0]?.role, "compactionSummary");
          assert.match(first.messages[0]?.summary as string, /Prepared continuation checkpoint/);
          assert.equal(g.compactCalls.length, 0);
          assert.equal(g.appendedEntries.length, 2, "restore appends nothing");
          return { checkpointBId: checkpointB.checkpointId };
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });

    const published = ofType(events, "checkpoint_published");
    assert.equal(published.length, 2);
    assert.equal(published[0]?.replaced, false);
    assert.equal(published[1]?.replaced, true);
    const persisted = ofType(events, "checkpoint_persisted").filter((e) => e.action !== "failed");
    assert.equal(persisted.length, 2);
    const restored = ofType(events, "checkpoint_restored");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.checkpointId, result.checkpointBId, "reload restores B, not A");
  });

  it("restored checkpoint is B, not A", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.appendCustom(checkpointData({ checkpointId: "A", summary: "SUMMARY-A" }));
      f.appendCustom(checkpointData({ checkpointId: "B", summary: "SUMMARY-B" }));
      const g = f.restart();
      try {
        await g.emit("session_start");
        const outcome = (await g.emit("context", { messages: g.contextMessages() })) as {
          messages: Array<Record<string, unknown>>;
        };
        assert.match(outcome.messages[0]?.summary as string, /SUMMARY-B/);
      } finally {
        await g.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  });

  it("a stale firstKeptEntryId is ignored", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture();
      try {
        f.appendCustom(checkpointData({ firstKeptEntryId: "missing" }));
        const g = f.restart();
        try {
          await g.emit("session_start");
          assert.equal(await g.emit("context", { messages: g.contextMessages() }), undefined);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });
    const rejected = ofType(events, "checkpoint_restore_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason, "missing-first-kept");
    assert.equal(ofType(events, "checkpoint_restored").length, 0);
  });

  it("a checkpoint from a different native compaction is ignored", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture();
      try {
        f.appendCustom(checkpointData());
        f.appendCompaction();
        const g = f.restart();
        try {
          await g.emit("session_start");
          assert.equal(await g.emit("context", { messages: g.contextMessages() }), undefined);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });
    const rejected = ofType(events, "checkpoint_restore_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason, "compaction-mismatch");
  });

  it("a checkpoint from another session is ignored", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture();
      try {
        f.appendCustom(checkpointData({ sessionId: "other-session" }));
        const g = f.restart();
        try {
          await g.emit("session_start");
          assert.equal(await g.emit("context", { messages: g.contextMessages() }), undefined);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    });
    const rejected = ofType(events, "checkpoint_restore_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason, "session-mismatch");
  });

  it("observe mode restores nothing", async () => {
    const previous = process.env[MODE_ENV_VAR];
    process.env[MODE_ENV_VAR] = "observe";
    try {
      const f = await fixture();
      try {
        f.appendCustom(checkpointData());
        const g = f.restart();
        try {
          await g.emit("session_start");
          assert.equal(await g.emit("context", { messages: g.contextMessages() }), undefined);
        } finally {
          await g.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    } finally {
      if (previous === undefined) delete process.env[MODE_ENV_VAR];
      else process.env[MODE_ENV_VAR] = previous;
    }
  });
});

describe("checkpoint self-repair (summary omission is not evidence loss)", () => {
  const MARKER = "IMPORTANT_CONSTRAINT_X";
  let sequence = 0;

  function userMessage(text: string): SessionEntry {
    sequence += 1;
    return {
      id: `self-repair-${sequence}`,
      parentId: sequence > 1 ? `self-repair-${sequence - 1}` : null,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "message",
      message: { role: "user", content: text, timestamp: sequence },
    } as unknown as SessionEntry;
  }

  function persistedCheckpointEntry(
    id: string,
    summary: string,
    firstKeptEntryId: string,
    leafId: string,
  ): SessionEntry {
    const data: PersistedShadowCheckpoint = {
      version: 1,
      checkpointId: id,
      sessionId: "session-1",
      summary,
      firstKeptEntryId,
      leafId,
      latestCompactionId: null,
      contextTokensBefore: 600,
      usage: USAGE,
      details: { readFiles: [], modifiedFiles: [] },
      createdAt: 1_700_000_000_000,
    };
    assert.equal(isPersistedShadowCheckpoint(data), true);
    return {
      id: `custom-${id}`,
      parentId: leafId,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "custom",
      customType: CHECKPOINT_CUSTOM_TYPE,
      data,
    } as unknown as SessionEntry;
  }

  it("checkpoint B recovers a constraint that checkpoint A's summary omitted", () => {
    sequence = 0;
    const constraint = userMessage(`${MARKER}: deploy only after the canary job goes green`);
    const earlyBranch: SessionEntry[] = [
      constraint,
      userMessage(`background detail ${"x".repeat(500)}`),
      userMessage(`more background ${"y".repeat(500)}`),
    ];

    // Checkpoint A covers the early history, but its summary deliberately
    // omits the constraint — the omission the self-repair story must survive.
    const summaryA = "Continuation summary that forgets the deployment constraint.";
    assert.doesNotMatch(summaryA, new RegExp(MARKER));
    const persistedA = persistedCheckpointEntry(
      "A",
      summaryA,
      earlyBranch[0]!.id,
      earlyBranch.at(-1)!.id,
    );

    // More history accrues after A persists; B reads the raw branch itself.
    const later: SessionEntry[] = [
      userMessage(`follow-up work ${"a".repeat(500)}`),
      userMessage(`latest question ${"b".repeat(500)}`),
    ];
    const branchB: SessionEntry[] = [...earlyBranch, persistedA, ...later];
    const indexB = new SessionHistoryIndex({
      branch: branchB,
      cwd: "/work/project",
      previousCheckpointSummary: summaryA,
    });

    // The persisted checkpoint entry itself serves no text: recovery must
    // come from raw history, never from re-reading the stale summary.
    const served = indexB.readTurnRange(1, 10);
    const carrier = served.turns.flatMap((turn) => turn.entries).find((item) => item.entryId === persistedA.id);
    assert.equal(carrier?.text, "");
    assert.doesNotMatch(indexB.previousCheckpoint()?.summary ?? "", new RegExp(MARKER));

    // Both discovery paths recover the constraint from raw history despite
    // A's omission: keyword search and direct turn reads.
    const hits = indexB.searchSessionHistory(MARKER);
    assert.ok(hits.some((hit) => hit.entryId === constraint.id), "search recovers the constraint");
    const recovered = served.turns
      .flatMap((turn) => turn.entries)
      .filter((item) => item.text.includes(MARKER));
    assert.ok(recovered.length > 0, "turn reads recover the constraint from raw history");
    assert.ok(
      recovered.every((item) => item.entryId === constraint.id),
      "the constraint arrives with its stable evidence id, not the carrier's",
    );
  });

  it("checkpoint C recovers a fact across a native compaction via raw history and the Shadow chain", () => {
    sequence = 0;
    const constraint = userMessage(`${MARKER}: deploy only after the canary job goes green`);
    const earlyBranch: SessionEntry[] = [
      constraint,
      userMessage(`background detail ${"x".repeat(500)}`),
      userMessage(`more background ${"y".repeat(500)}`),
    ];

    const summaryA = "Continuation summary that forgets the deployment constraint.";
    const persistedA = persistedCheckpointEntry(
      "A",
      summaryA,
      earlyBranch[0]!.id,
      earlyBranch.at(-1)!.id,
    );

    // A native compaction lands (emergency hatch or failure fallback). The branch
    // is append-only, so raw history and the persisted checkpoint survive;
    // only Pi's context boundary moves to keptAfter.
    const keptAfter = userMessage(`post-compaction work ${"c".repeat(500)}`);
    sequence += 1;
    const native = {
      id: `self-repair-${sequence}`,
      parentId: keptAfter.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "compaction",
      summary: "Native summary covering the early work.",
      firstKeptEntryId: keptAfter.id,
      tokensBefore: 150_000,
    } as unknown as SessionEntry;
    const later: SessionEntry[] = [
      userMessage(`follow-up work ${"a".repeat(500)}`),
      userMessage(`latest question ${"b".repeat(500)}`),
    ];
    const branchC: SessionEntry[] = [...earlyBranch, persistedA, keptAfter, native, ...later];

    // The reader has no compaction boundary: pre-compaction raw history stays
    // directly readable, so C recovers the constraint with plain reads.
    const indexC = new SessionHistoryIndex({ branch: branchC, cwd: "/work/project" });
    assert.ok(
      indexC.readTurnRange(1, 10).turns.flatMap((turn) => turn.entries).some((item) => item.text.includes(MARKER)),
      "C recovers the constraint from pre-compaction raw history",
    );
    // The Shadow chain still carries A as orientation even though A is stale
    // for restore/swap: restore currency and reader context are deliberately
    // different bars.
    assert.deepEqual(collectShadowSummaries(branchC, "session-1"), [summaryA]);
    const { skippedStale } = findLatestRestorableCheckpoint(branchC, "session-1");
    assert.ok(
      skippedStale.some((skipped) => skipped.checkpointId === "A" && skipped.reason === "compaction-mismatch"),
      "A is stale for restore/swap but remains usable as reader context",
    );
  });


  it("collectShadowSummaries keeps the newest session-matching summaries within its limit", () => {
    sequence = 0;
    const a = userMessage("a");
    const b = userMessage("b");
    const c = userMessage("c");
    const ckptA = persistedCheckpointEntry("A", "summary A", a.id, c.id);
    const ckptB = persistedCheckpointEntry("B", "summary B", b.id, c.id);
    const ckptC = persistedCheckpointEntry("C", "summary C", c.id, c.id);
    const other = persistedCheckpointEntry("X", "other session summary", c.id, c.id);
    (other as unknown as { data: PersistedShadowCheckpoint }).data.sessionId = "session-2";
    const corrupt = {
      id: "custom-corrupt",
      parentId: c.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "custom",
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: { version: 999 },
    } as unknown as SessionEntry;
    const staleCut = persistedCheckpointEntry("S", "diverged summary", "no-such-entry", c.id);
    const branch = [a, b, c, ckptA, ckptB, ckptC, other, corrupt, staleCut];

    assert.equal(SHADOW_CHAIN_LIMIT, 2);
    assert.deepEqual(collectShadowSummaries(branch, "session-1"), ["summary B", "summary C"]);
    assert.deepEqual(collectShadowSummaries(branch, "session-1", 1), ["summary C"]);
    assert.deepEqual(collectShadowSummaries(branch, "session-1", 0), []);
    assert.deepEqual(collectShadowSummaries(branch, "session-2"), ["other session summary"]);
    assert.deepEqual(collectShadowSummaries([], "session-1"), []);
  });
});

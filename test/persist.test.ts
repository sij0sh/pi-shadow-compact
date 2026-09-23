import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { MODE_ENV_VAR } from "../src/config.js";
import { normalizeSnapshot } from "../src/normalize.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  collectShadowSummaries,
  checkpointStalenessReason,
  findLatestPersistedCheckpoint,
  findLatestRestorableCheckpoint,
  isPersistedShadowCheckpoint,
  SHADOW_CHAIN_LIMIT,
  toPreparedResult,
  type PersistedShadowCheckpoint,
} from "../src/persist.js";
import { prepareSnapshot } from "../src/prepare.js";
import { combineUsage } from "../src/summary.js";
import { TRACE_FILE_ENV_VAR } from "../src/trace.js";
import {
  fixture,
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

function checkpointData(overrides: Partial<PersistedShadowCheckpoint> = {}): PersistedShadowCheckpoint {
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
      const f = await fixture();
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
      const f = await fixture();
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
});

describe("soft durability without compaction", () => {
  it("persists once at settle with the full checkpoint payload; raw evidence stays intact", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture();
      try {
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled === 2);
        await tick();
        await f.emit("agent_settled");

        assert.equal(f.compactCalls.length, 0, "no ctx.compact() on ordinary soft settle");
        assert.equal(f.appendedEntries.length, 1);
        const [persisted] = f.appendedEntries;
        assert.equal(persisted?.customType, CHECKPOINT_CUSTOM_TYPE);
        const data = persisted?.data as PersistedShadowCheckpoint;
        assert.equal(data.version, 1);
        assert.ok(typeof data.checkpointId === "string" && data.checkpointId.length > 0);
        assert.equal(data.sessionId, "session-1");
        assert.match(data.summary, /Prepared continuation checkpoint/);
        assert.equal(data.firstKeptEntryId, "e4");
        assert.equal(data.leafId, "e4");
        assert.equal(data.latestCompactionId, null);
        assert.equal(data.contextTokensBefore, 600);
        assert.deepEqual(data.usage, combineUsage(USAGE, USAGE));
        assert.deepEqual(data.details, {
          readFiles: ["src/read.ts"],
          modifiedFiles: ["src/edited.ts"],
        });
        assert.ok(typeof data.createdAt === "number");

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

  it("the hard hatch still runs one native compaction and persists nothing", async () => {
    const f = await fixture();
    try {
      f.setPercent(80);
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
      const f = await fixture();
      try {
        // USER TURN 1: cross 60% -> prepare A -> publish -> swap -> settle -> persist A.
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled === 2);
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
        assert.equal(f.registry.calls, 2, "below-soft re-arms without preparing");
        f.setPercent(65);
        f.gate();
        await f.emit("turn_end");
        assert.equal(f.registry.calls, 3, "B prepares while A serves");
        const servingDuringB = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(servingDuringB, "A keeps serving while B prepares");
        f.release();
        await waitFor(() => f.registry.settled === 4);
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
    const f = await fixture();
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
    const snapshotA = prepareSnapshot(earlyBranch, 10);
    assert.ok(snapshotA, "A has evidence to summarize");
    assert.ok(
      snapshotA.sourceEntries.some((entry) => entry.id === constraint.id),
      "A's range includes the constraint entry",
    );
    const summaryA = "Continuation summary that forgets the deployment constraint.";
    assert.doesNotMatch(summaryA, new RegExp(MARKER));
    const persistedA = persistedCheckpointEntry(
      "A",
      summaryA,
      snapshotA.firstKeptEntryId,
      earlyBranch.at(-1)!.id,
    );

    // More history accrues after A persists; B prepares from the raw branch.
    const later: SessionEntry[] = [
      userMessage(`follow-up work ${"a".repeat(500)}`),
      userMessage(`latest question ${"b".repeat(500)}`),
    ];
    const branchB: SessionEntry[] = [...earlyBranch, persistedA, ...later];
    const snapshotB = prepareSnapshot(branchB, 10);
    assert.ok(snapshotB, "B has evidence to summarize");

    // Intercept B's normalized evidence packet: the persisted checkpoint is
    // invisible to the normalizer, so recovery must come from raw history.
    const packetB = normalizeSnapshot({
      cwd: "/work/project",
      previousSummary: summaryA,
      entries: [...snapshotB.sourceEntries, ...snapshotB.turnPrefixEntries],
    });
    assert.ok(
      packetB.evidence.every((item) => item.sourceEntryId !== persistedA.id),
      "the persisted checkpoint contributes no evidence of its own",
    );
    const recovered = packetB.evidence.filter(
      (item) => item.kind !== "previous_checkpoint" && item.text.includes(MARKER),
    );
    assert.ok(
      recovered.length > 0,
      "B's packet recovers the constraint from raw history despite A's omission",
    );
    assert.ok(
      packetB.evidence
        .filter((item) => item.kind === "previous_checkpoint")
        .every((item) => !item.text.includes(MARKER)),
      "the omission is real: no previous-checkpoint carrier mentions the constraint",
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

    const snapshotA = prepareSnapshot(earlyBranch, 10, { sessionId: "session-1" });
    assert.ok(snapshotA, "A has evidence to summarize");
    const summaryA = "Continuation summary that forgets the deployment constraint.";
    const persistedA = persistedCheckpointEntry(
      "A",
      summaryA,
      snapshotA.firstKeptEntryId,
      earlyBranch.at(-1)!.id,
    );

    // A native compaction lands (hard hatch or failure fallback). The branch
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

    const snapshotC = prepareSnapshot(branchC, 10, { sessionId: "session-1" });
    assert.ok(snapshotC, "C has evidence to summarize");
    // Evidence reaches past the native boundary (cut policy unchanged).
    assert.ok(
      snapshotC.sourceEntries.some((entry) => entry.id === constraint.id),
      "C's evidence still includes the pre-compaction constraint entry",
    );
    assert.equal(snapshotC.previousSummary, "Native summary covering the early work.");
    // The Shadow chain carries A as evidence even though A is stale for swap:
    // restore currency and summarizer context are deliberately different bars.
    assert.deepEqual(snapshotC.shadowSummaries, [summaryA]);
    const { skippedStale } = findLatestRestorableCheckpoint(branchC, "session-1");
    assert.ok(
      skippedStale.some((skipped) => skipped.checkpointId === "A" && skipped.reason === "compaction-mismatch"),
      "A is stale for restore/swap but remains usable as summarizer context",
    );

    const packetC = normalizeSnapshot({
      cwd: "/work/project",
      previousSummary: snapshotC.previousSummary,
      shadowSummaries: snapshotC.shadowSummaries,
      entries: [...snapshotC.sourceEntries, ...snapshotC.turnPrefixEntries],
    });
    const recovered = packetC.evidence.filter(
      (item) => item.kind !== "previous_checkpoint" && item.text.includes(MARKER),
    );
    assert.ok(
      recovered.length > 0,
      "C's packet recovers the constraint from pre-compaction raw history",
    );
    assert.deepEqual(
      packetC.evidence
        .filter((item) => item.kind === "previous_checkpoint")
        .map((item) => item.text),
      ["Native summary covering the early work.", summaryA],
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

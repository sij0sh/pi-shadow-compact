import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fixture,
  waitFor,
  tick,
  NONCE_PATTERN,
  USAGE,
  userEntry,
  compactionEntry,
  type Fixture,
} from "./helpers/index-fixture.js";


it("uses the default summary token cap and no reasoning without overrides", async () => {
  const f = await fixture();
  try {
    await startPreparation(f);
    const options = f.registry.optionsList[0];
    assert.ok(options);
    assert.equal(options.maxTokens, 4096);
    assert.equal((options as { reasoning?: unknown }).reasoning, undefined);
  } finally {
    await f.cleanup();
  }
});

it("honors summaryMaxTokens and thinkingLevel overrides", async () => {
  const f = await fixture({
    softCompactThresholdPercent: 60,
    summarizerModel: { provider: "", id: "" },
    summaryMaxTokens: 32_768,
    thinkingLevel: "high",
  });
  try {
    await startPreparation(f);
    const options = f.registry.optionsList[0];
    assert.ok(options);
    assert.equal(options.maxTokens, 32_768);
    assert.equal((options as { reasoning?: unknown }).reasoning, "high");
  } finally {
    await f.cleanup();
  }
});

it("summarizerContextTokens overrides the packet budget independently of models.json", async () => {
  // Default budget (~272K) keeps all fixture evidence; a tiny override keeps only the newest.
  const f = await fixture({
    softCompactThresholdPercent: 60,
    summarizerModel: { provider: "", id: "" },
    summarizerContextTokens: 1_000,
  });
  try {
    await startPreparation(f);
    const prompt = f.registry.prompts[0]!;
    assert.match(prompt, /Now editing the file/);
    assert.doesNotMatch(prompt, /First user message describing the overall goal/);
  } finally {
    await f.cleanup();
  }
});

/** Runs turn_end at the 60% threshold and waits for the background summary to finish. */
async function startPreparation(f: Fixture): Promise<void> {
  await f.emit("turn_end");
  await waitFor(() => f.registry.settled >= 1);
}

function commitNonce(f: Fixture): string {
  const commit = f.compactCalls.at(-1);
  assert.match(commit?.customInstructions ?? "", NONCE_PATTERN);
  return commit!.customInstructions!;
}

describe("shadowCompact extension orchestration", () => {
  it("does nothing on turn_end below the threshold or without usage data", async () => {
    const f = await fixture();
    try {
      f.setPercent(undefined);
      await f.emit("turn_end");
      f.setPercent(59);
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.equal(f.compactCalls.length, 0);
      assert.deepEqual(f.notifications, []);
    } finally {
      await f.cleanup();
    }
  });

  it("starts background preparation at the threshold and resolves turn_end before the model call completes", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      assert.equal(f.registry.settled, 0);
      assert.ok(f.registry.prompts[0]?.includes("untrusted transcript data"));
      f.release();
      await waitFor(() => f.registry.settled === 1);
      await f.emit("agent_settled");
      assert.match(commitNonce(f), NONCE_PATTERN);
      assert.equal(f.registry.models[0], f.registry.summaryModel);
    } finally {
      await f.cleanup();
    }
  });

  it("ignores duplicate turn_end while a preparation is already running", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      assert.equal(f.compactCalls.length, 0);
      f.release();
      await waitFor(() => f.registry.settled === 1);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("commits a ready result with a nonce, serves the matching before_compact from cache, and resets onComplete", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      await f.emit("agent_settled");
      const commit = f.compactCalls[0];
      assert.ok(commit);
      const nonce = commitNonce(f);
      assert.equal(typeof commit?.onComplete, "function");
      assert.equal(typeof commit?.onError, "function");

      const outcome = await f.emit(
        "session_before_compact",
        f.compactEvent({ customInstructions: nonce, firstKeptEntryId: "e3" }),
      );
      assert.equal(f.registry.settled, 1);
      assert.ok(outcome?.compaction);
      assert.match(outcome.compaction.summary, /Prepared continuation checkpoint/);
      assert.equal(outcome.compaction.firstKeptEntryId, "e4");
      assert.equal(outcome.compaction.tokensBefore, 777);
      assert.deepEqual(outcome.compaction.usage, USAGE);
      assert.deepEqual(outcome.compaction.details, {
        readFiles: ["src/read.ts"],
        modifiedFiles: ["src/edited.ts"],
      });

      commit.onComplete?.(outcome.compaction);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      await f.emit("turn_end");
      await waitFor(() => f.registry.calls === 2);
    } finally {
      await f.cleanup();
    }
  });

  it("discards a ready result whose leaf is no longer on the branch", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      const [e1, e2, e3] = f.branch;
      f.setBranch([e1!, e2!, e3!, userEntry("e5", "e3", `Divergent continuation: ${"more ".repeat(30)}`)]);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.deepEqual(f.notifications, []);
    } finally {
      await f.cleanup();
    }
  });

  it("discards a ready result when a newer compaction landed on the branch", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      f.appendCompaction();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("reuses the cache for threshold compaction with a matching boundary and undefined on mismatch", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      const match = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e4" }),
      );
      assert.ok(match?.compaction);
      assert.match(match.compaction.summary, /Prepared continuation checkpoint/);
      assert.equal(f.registry.settled, 1);
      assert.equal(f.compactCalls.length, 0);

      const mismatch = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e1" }),
      );
      assert.equal(mismatch, undefined);
      assert.equal(f.registry.settled, 1);

      const again = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e4" }),
      );
      assert.ok(again?.compaction);
      assert.equal(f.registry.settled, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("always returns undefined for manual compaction and aborts an in-flight preparation", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      const manualWhileReady = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "manual" }),
      );
      assert.equal(manualWhileReady, undefined);
      assert.equal(f.compactCalls.length, 0);

      // The manual pass reset the ready result, so a fresh preparation can start.
      f.gate();
      await f.emit("turn_end");
      const manualWhilePreparing = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "manual" }),
      );
      assert.equal(manualWhilePreparing, undefined);
      assert.ok(f.registry.signals[1]?.aborted);
      f.release();
      await waitFor(() => f.registry.settled === 2);
      await tick();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("falls back to plain native compaction after a summary model error", async () => {
    const f = await fixture();
    try {
      f.registry.mode = "error";
      await f.emit("turn_end");
      // A stopReason error is not retried; only checkpoint validation failures are.
      await waitFor(() => f.registry.settled >= 1);
      await tick();
      assert.equal(f.registry.calls, 1);
      assert.deepEqual(f.notifications, ["shadow-compact: Summary model stopped with error"]);
      assert.equal(f.compactCalls.length, 0);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});
    } finally {
      await f.cleanup();
    }
  });

  it("falls back to one plain native compaction when the commit fails", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      await f.emit("agent_settled");
      const commit = f.compactCalls[0];
      commit?.onError?.(new Error("compaction failed"));
      assert.equal(f.compactCalls.length, 2);
      assert.deepEqual(f.compactCalls[1], {});
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 2);
    } finally {
      await f.cleanup();
    }
  });

  it("resets on session_compact only when it originated from this extension", async () => {
    const compactedEvent = (fromExtension: boolean) => ({
      type: "session_compact",
      compactionEntry: compactionEntry("c1", "e4"),
      fromExtension,
      reason: "threshold",
      willRetry: false,
    });

    const reset = await fixture();
    try {
      await startPreparation(reset);
      await reset.emit("session_compact", compactedEvent(true));
      await reset.emit("agent_settled");
      assert.equal(reset.compactCalls.length, 0);
    } finally {
      await reset.cleanup();
    }

    const kept = await fixture();
    try {
      await startPreparation(kept);
      await kept.emit("session_compact", compactedEvent(false));
      await kept.emit("agent_settled");
      assert.match(kept.compactCalls[0]?.customInstructions ?? "", NONCE_PATTERN);
    } finally {
      await kept.cleanup();
    }

    const stale = await fixture();
    try {
      stale.gate();
      await stale.emit("turn_end");
      stale.appendCompaction();
      await stale.emit("session_compact", compactedEvent(false));
      stale.release();
      await waitFor(() => stale.registry.settled === 1);
      await tick();
      await stale.emit("agent_settled");
      assert.equal(stale.compactCalls.length, 0);
      assert.deepEqual(stale.notifications, []);
    } finally {
      await stale.cleanup();
    }
  });
});

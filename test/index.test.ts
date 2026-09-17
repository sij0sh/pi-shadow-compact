import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fixture,
  waitFor,
  tick,
  USAGE,
  userEntry,
  compactionEntry,
  type Fixture,
} from "./helpers/index-fixture.js";
import { CHECKPOINT_CUSTOM_TYPE } from "../src/persist.js";
import { combineUsage } from "../src/summary.js";

const READY_MESSAGE = "shadow-compact: summary ready - swaps in at the next turn";
const DEFERRED_MESSAGE =
  "shadow-compact: summary still preparing - swap deferred until the agent is idle";


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

/** Runs turn_end at the 60% threshold and waits for draft + verification to finish. */
async function startPreparation(f: Fixture): Promise<void> {
  await f.emit("turn_end");
  await waitFor(() => f.registry.settled >= 2);
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
      await waitFor(() => f.registry.settled === 2);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);
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
      await waitFor(() => f.registry.settled === 2);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("persists a ready result as extension state and serves the matching before_compact from cache", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0, "the soft path never compacts");
      assert.equal(f.appendedEntries.length, 1);
      const persisted = f.appendedEntries[0];
      assert.equal(persisted?.customType, CHECKPOINT_CUSTOM_TYPE);

      // A nonce-style custom instruction is no longer a commit handshake.
      const nonceOutcome = await f.emit(
        "session_before_compact",
        f.compactEvent({ customInstructions: "[shadow-compact:commit:dead]", firstKeptEntryId: "e3" }),
      );
      assert.equal(nonceOutcome, undefined);

      const outcome = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e4" }),
      );
      assert.equal(f.registry.settled, 2);
      assert.ok(outcome?.compaction);
      assert.match(outcome.compaction.summary, /Prepared continuation checkpoint/);
      assert.equal(outcome.compaction.firstKeptEntryId, "e4");
      assert.equal(outcome.compaction.tokensBefore, 777);
      assert.deepEqual(outcome.compaction.usage, combineUsage(USAGE, USAGE));
      assert.deepEqual(outcome.compaction.details, {
        readFiles: ["src/read.ts"],
        modifiedFiles: ["src/edited.ts"],
      });

      // The checkpoint keeps serving after it lands: settle again, persist once.
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);
      assert.ok(await f.emit("context", { messages: f.contextMessages() }));
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
      assert.equal(f.appendedEntries.length, 0);
      // The discard itself stays silent; the one toast is the ready announcement.
      assert.deepEqual(f.notifications, [READY_MESSAGE]);
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
      assert.equal(f.appendedEntries.length, 0);

      // A stale result never swaps into the request context either.
      const swapped = await f.emit("context", { messages: f.contextMessages() });
      assert.equal(swapped, undefined);
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
      assert.equal(f.registry.settled, 2);
      assert.equal(f.compactCalls.length, 0);

      const mismatch = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e1" }),
      );
      assert.equal(mismatch, undefined);
      assert.equal(f.registry.settled, 2);

      const again = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold", firstKeptEntryId: "e4" }),
      );
      assert.ok(again?.compaction);
      assert.equal(f.registry.settled, 2);
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
      assert.ok(f.registry.signals.at(-1)?.aborted);
      f.release();
      await waitFor(() => f.registry.settled === 2);
      await tick();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps a newer preparation alive when a superseded summary completes", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);

      // Manual compaction supersedes prepare #1 while its model call is in flight.
      await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      assert.ok(f.registry.signals[0]?.aborted);

      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 2);
      assert.ok(!f.registry.signals[1]?.aborted);

      // The stale completion resolves past its abort and must not touch prepare #2.
      // Draft and verifier settle in one drain, so intermediate counts are
      // waited with >= : only the terminal counts are exact.
      f.release();
      await waitFor(() => f.registry.settled >= 2);
      await tick();
      assert.ok(!f.registry.signals[1]?.aborted);
      assert.equal(f.compactCalls.length, 0);
      assert.deepEqual(f.notifications, []);

      f.release();
      await waitFor(() => f.registry.settled >= 4);
      await tick();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("schedules the one-shot native fallback when a completed summary is invalid while current", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      f.appendCompaction();
      f.release();
      // Draft completes, then the verifier completes; the branch moved on, so
      // the verified candidate is discarded as stale.
      await waitFor(() => f.registry.settled === 2);
      await tick();
      assert.equal(f.compactCalls.length, 0);
      assert.deepEqual(f.notifications, []);

      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});

      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("retries config loading after a failure and announces recovery", async () => {
    const f = await fixture();
    try {
      const configPath = join(f.agentDir, "shadow-compact.json");
      await writeFile(configPath, "{ not json");
      f.setPercent(61);
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.equal(f.notifications.length, 1);
      assert.match(f.notifications[0]!, /not valid JSON/);

      // The retry stays deduped to one toast while the file stays broken.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.equal(f.notifications.length, 1);

      // A fixed file takes effect on the next turn without session_start.
      await writeFile(
        configPath,
        JSON.stringify({
          softCompactThresholdPercent: 61,
          summarizerModel: { provider: "", id: "" },
        }),
      );
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled >= 2);
      await tick();
      assert.equal(f.registry.calls, 2);
      // Config error toast, recovery toast, then the ready announcement.
      assert.deepEqual(f.notifications, [
        `shadow-compact: ${join(f.agentDir, "shadow-compact.json")} is not valid JSON`,
        "shadow-compact: config recovered",
        READY_MESSAGE,
      ]);
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
      // A queued fallback owns the next idle point: no new preparation on top of it.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 1);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});
    } finally {
      await f.cleanup();
    }
  });

  it("publishes the verified checkpoint text, not the draft", async () => {
    const f = await fixture();
    try {
      f.registry.mode = "verifier-rewrite";
      await startPreparation(f);
      await tick();

      const swapped = (await f.emit("context", { messages: f.contextMessages() })) as {
        messages: Array<{ summary?: unknown }>;
      };
      assert.match(String(swapped.messages[0]?.summary), /Verified continuation checkpoint/);
      assert.doesNotMatch(String(swapped.messages[0]?.summary), /Prepared continuation checkpoint/);

      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 1);
      const data = f.appendedEntries[0]?.data as { summary: string };
      assert.match(data.summary, /Verified continuation checkpoint/);
    } finally {
      await f.cleanup();
    }
  });

  it("fails closed with one native fallback when verification errors and nothing serves", async () => {
    const f = await fixture();
    try {
      f.registry.mode = "verifier-error";
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled >= 2);
      await tick();
      assert.equal(f.registry.calls, 2);
      assert.deepEqual(f.notifications, ["shadow-compact: Verification model stopped with error"]);
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 0);
      // A queued fallback owns the next idle point: no new preparation on top of it.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 2);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});
      assert.equal(f.appendedEntries.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("a failed verification keeps the serving checkpoint and schedules no fallback", async () => {
    const f = await fixture();
    try {
      await startPreparation(f);
      await tick();
      assert.ok(await f.emit("context", { messages: f.contextMessages() }), "A serves");

      // Below soft re-arms after the observed swap + shrink; B then fails closed.
      f.setPercent(30);
      await f.emit("turn_end");
      f.setPercent(65);
      f.registry.mode = "verifier-error";
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled >= 4);
      await tick();
      f.registry.mode = "ok";
      assert.deepEqual(f.notifications.at(-1), "shadow-compact: Verification model stopped with error");

      // A keeps serving; no native fallback is queued for a failed replacement.
      assert.ok(
        await f.emit("context", { messages: f.contextMessages() }),
        "A continues serving after B fails verification",
      );
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);

      // The failure must not manufacture a threshold crossing: still above
      // soft with no new swap + shrink, so the next crossing is suppressed.
      f.setPercent(66);
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 4, "no immediate retry after failed verification");
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
      assert.equal(reset.appendedEntries.length, 0);
    } finally {
      await reset.cleanup();
    }

    const kept = await fixture();
    try {
      await startPreparation(kept);
      await kept.emit("session_compact", compactedEvent(false));
      await kept.emit("agent_settled");
      // A foreign compaction the branch never shows leaves the checkpoint
      // current, so the idle settle persists it without compacting.
      assert.equal(kept.compactCalls.length, 0);
      assert.equal(kept.appendedEntries.length, 1);
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
      // Draft plus verifier complete before the stale candidate is discarded.
      await waitFor(() => stale.registry.settled === 2);
      await tick();
      await stale.emit("agent_settled");
      // The stale result schedules the documented one-shot native fallback.
      assert.deepEqual(stale.compactCalls[0], {});
      assert.deepEqual(stale.notifications, []);
    } finally {
      await stale.cleanup();
    }
  });

});

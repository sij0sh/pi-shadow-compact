import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fixture,
  waitFor,
  tick,
  NONCE_PATTERN,
  userEntry,
  compactionEntry,
} from "./helpers/index-fixture.js";

const READY_MESSAGE = "shadow-compact: summary ready - will swap in at the next turn boundary";
const DEFERRED_MESSAGE =
  "shadow-compact: summary still preparing - swap deferred to the next turn boundary";

/** Runs turn_end at the 60% threshold and waits for the background summary to finish. */
async function startPreparation(f: ReturnType<typeof fixture> extends Promise<infer T> ? T : never): Promise<void> {
  await f.emit("turn_end");
  await waitFor(() => f.registry.settled >= 1);
}

describe("mid-run swap, hard hatch, and terminal empty-snapshot failure", () => {
  it("commits a ready summary at the next turn boundary without waiting for agent_settled", async () => {
    const f = await fixture();
    try {
      // Publish mid-run: gate the summary, then let it finish while the run continues.
      f.gate();
      await f.emit("turn_end");
      f.release();
      await waitFor(() => f.registry.settled === 1);
      await tick();
      assert.deepEqual(f.notifications, [READY_MESSAGE]);

      await f.emit("turn_end");
      assert.equal(f.compactCalls.length, 1, "committed at the turn boundary");
      assert.match(f.compactCalls[0]?.customInstructions ?? "", NONCE_PATTERN);
      const nonce = f.compactCalls[0]!.customInstructions!;

      // The nonce commit is served from cache; onComplete re-arms for later turns.
      const outcome = await f.emit("session_before_compact", f.compactEvent({ customInstructions: nonce }));
      assert.ok(outcome?.compaction);
      f.compactCalls[0]!.onComplete?.(outcome.compaction);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("announces the deferral when the summary misses the settle, then commits at the next boundary", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.notifications, [DEFERRED_MESSAGE]);
      assert.equal(f.compactCalls.length, 0);

      // One announce per settle, not per turn.
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.notifications, [DEFERRED_MESSAGE, DEFERRED_MESSAGE]);

      f.release();
      await waitFor(() => f.registry.settled === 1);
      await tick();
      await f.emit("turn_end");
      assert.match(f.compactCalls[0]?.customInstructions ?? "", NONCE_PATTERN);
    } finally {
      await f.cleanup();
    }
  });

  it("runs one native compaction immediately once usage passes the hard threshold", async () => {
    const f = await fixture();
    try {
      f.gate();
      await f.emit("turn_end");
      f.setPercent(80);
      await f.emit("turn_end");
      assert.deepEqual(f.compactCalls, [{}]);
      assert.ok(f.registry.signals[0]?.aborted, "in-flight preparation aborted");

      // No duplicate while the native compaction is in flight.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.compactCalls.length, 1);

      // The aborted completion stays inert; the fallback is not scheduled twice.
      f.release();
      await waitFor(() => f.registry.settled === 1);
      await tick();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("prefers a ready summary over the hard-threshold hatch and stays below it at 79%", async () => {
    const ready = await fixture();
    try {
      await startPreparation(ready);
      ready.setPercent(85);
      await ready.emit("turn_end");
      assert.match(ready.compactCalls[0]?.customInstructions ?? "", NONCE_PATTERN);
      assert.equal(ready.compactCalls.length, 1);
    } finally {
      await ready.cleanup();
    }

    const below = await fixture();
    try {
      below.setPercent(79);
      await below.emit("turn_end");
      await waitFor(() => below.registry.settled === 1);
      assert.equal(below.compactCalls.length, 0, "79% only triggers the soft prepare");
    } finally {
      await below.cleanup();
    }
  });

  it("applies the hard hatch with the default threshold even when config loading fails", async () => {
    const f = await fixture();
    try {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(f.agentDir, "shadow-compact.json"), "{ not json");
      f.setPercent(80);
      await f.emit("turn_end");
      assert.deepEqual(f.compactCalls, [{}]);
      assert.equal(f.registry.calls, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("re-arms the hatch after the native compaction lands", async () => {
    const f = await fixture();
    try {
      f.setPercent(80);
      await f.emit("turn_end");
      assert.equal(f.compactCalls.length, 1);

      await f.emit("session_compact", {
        type: "session_compact",
        compactionEntry: compactionEntry("c1", "e4"),
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      });
      await f.emit("turn_end");
      assert.equal(f.compactCalls.length, 2, "hatch can fire again after the swap landed");
    } finally {
      await f.cleanup();
    }
  });

  it("fails terminally when there is nothing to summarize and re-arms on later turns", async () => {
    const f = await fixture();
    try {
      // Branch below keepRecentTokens (30): the summarizable range is empty.
      f.setBranch([userEntry("e1", null, "hi")]);
      f.setPercent(60);
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.deepEqual(f.notifications, []);

      // Terminal, not latched: the documented one-shot native fallback fires.
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});

      // Once the branch grows past the keep boundary, a fresh prepare succeeds.
      f.setBranch([userEntry("e1", null, "hi"), userEntry("e2", "e1", "x".repeat(4000))]);
      await f.emit("turn_end");
      await waitFor(() => f.registry.calls === 1);
      await f.emit("agent_settled");
      const nonce = f.compactCalls[1]?.customInstructions ?? "";
      assert.match(nonce, NONCE_PATTERN);
      assert.equal(f.compactCalls.length, 2);
    } finally {
      await f.cleanup();
    }
  });
});

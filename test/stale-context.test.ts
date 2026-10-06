import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureWithHistory as fixture, waitFor, tick } from "./helpers/index-fixture.js";

/**
 * A background summary routinely outlives its session (replacement or reload
 * while it runs). Pi then throws on every use of the captured ctx; an escaped
 * throw is an unhandled rejection that takes down the agent process. The soft
 * durability path appends extension state synchronously at idle with no
 * callback that must survive a session replacement, and a failed append (an
 * idle point racing teardown) keeps the checkpoint serving for a later retry.
 * These tests pin the stand-down behavior.
 */
const SWAP_CONFIG = {
  prepareThresholdPercent: 60,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
};

describe("stale context after session replacement", () => {
  it("a summary completion on a dead session releases quietly instead of crashing", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);

      // The session dies while the summary runs.
      f.setStale();
      f.release();
      await waitFor(() => f.registry.settled >= 1);
      await tick();
      await tick();

      // No commit, no toast, no crash: the attempt just releases.
      assert.equal(f.compactCalls.length, 0);
      assert.deepEqual(f.notifications, []);
    } finally {
      await f.cleanup();
    }
  });

  it("a failed append at settle keeps serving and retries at the next settle", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled === 4);
      await tick();

      // The idle point races teardown: the append throws, nothing crashes.
      f.failNextAppend();
      await assert.doesNotReject(f.emit("agent_settled"));
      assert.equal(f.appendedEntries.length, 0);
      assert.equal(f.compactCalls.length, 0);

      // The checkpoint keeps serving and the next settle retries the persist.
      assert.ok(await f.emit("context", { messages: f.contextMessages() }));
      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 1);
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });
});

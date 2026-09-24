import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactionEntry,
  fixture,
  userEntry,
  waitFor,
  type Fixture,
} from "./helpers/index-fixture.js";

const READY_MESSAGE = "shadow-compact: summary ready - swaps in at the next turn";
const DEFERRED_MESSAGE =
  "shadow-compact: summary still preparing - swap deferred until the agent is idle";

const SWAP_CONFIG = {
  prepareThresholdPercent: 60,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
};

async function startPreparation(fixture: Fixture): Promise<void> {
  await fixture.emit("turn_end");
  await waitFor(() => fixture.notifications.includes(READY_MESSAGE));
}

describe("idle swap, emergency hatch, and terminal empty-snapshot failure", () => {
  it("swaps a ready summary into the next turn without aborting the run", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);

      const swapped = (await f.emit("context", { messages: f.contextMessages() })) as {
        messages: Array<{ summary?: string }>;
      };
      assert.equal(swapped.messages.length, 2);
      assert.ok(String(swapped.messages[0]?.summary).includes("Prepared continuation checkpoint"));
      assert.deepEqual(f.compactCalls, []);
      assert.equal(f.registry.settled, 4);
    } finally {
      await f.cleanup();
    }
  });

  it("announces the deferral when the summary misses the settle, then persists once ready and idle", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      await waitFor(() => f.registry.calls === 1);
      // The agent drained before the summary arrived: no persist yet, no
      // native compaction queued, just the deferral note.
      await f.emit("agent_settled");
      assert.deepEqual(f.notifications, [DEFERRED_MESSAGE]);
      assert.deepEqual(f.compactCalls, []);
      assert.equal(f.appendedEntries.length, 0);

      f.release();
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.equal(f.appendedEntries.length, 1);
      assert.equal((f.appendedEntries[0]?.data as { version: number }).version, 3);
    } finally {
      await f.cleanup();
    }
  });

  it("never aborts a preparation at the swap threshold", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      await waitFor(() => f.registry.calls === 1);
      // Usage climbs past the swap threshold while the replacement is still
      // being built: the preparation is the path to a smaller working set,
      // so it keeps running and no native fallback is queued.
      f.setPercent(85);
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      f.release();
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.deepEqual(f.compactCalls, []);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);
    } finally {
      await f.cleanup();
    }
  });

  it("queues one native compaction once usage passes the emergency threshold", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      f.setPercent(92);
      await f.emit("turn_end");
      // Still mid-run: the fallback waits for the idle point.
      assert.deepEqual(f.compactCalls, []);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
      // ctx.compact() is a manual compaction, so the ready checkpoint resets
      // when the native compaction lands.
      await f.emit("session_compact", { type: "session_compact", fromExtension: true });
      const swapped = await f.emit("context", { messages: f.contextMessages() });
      assert.equal(swapped, undefined);
    } finally {
      await f.cleanup();
    }
  });

  it("fires the emergency hatch even while a published checkpoint keeps serving, and stays below it at 91%", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      const swapped = (await f.emit("context", { messages: f.contextMessages() })) as {
        messages: unknown[];
      };
      assert.equal(swapped.messages.length, 2);

      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);

      await f.emit("session_compact", { type: "session_compact", fromExtension: true });
      assert.deepEqual(f.compactCalls, [{}]);
      f.setPercent(91);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
    } finally {
      await f.cleanup();
    }
  });

  it("applies the emergency hatch with the default threshold even when config loading fails", async () => {
    const f = await fixture();
    try {
      const configPath = `${f.agentDir}/shadow-compact.json`;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(configPath, "{ not json");
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
    } finally {
      await f.cleanup();
    }
  });

  it("re-arms the hatch after the native compaction lands", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
      // The marker clears when the native compaction is observed, so a later
      // spike can compact again.
      await f.emit("session_compact", { type: "session_compact", fromExtension: true });
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}, {}]);
    } finally {
      await f.cleanup();
    }
  });

  it("suppresses empty-snapshot preparations without native fallback while the emergency hatch stays live", async () => {
    const f = await fixture();
    try {
      // A single greeting turn cannot produce a checkpoint that drops
      // anything: suppress without queuing a native fallback.
      f.setBranch([userEntry("e1", null, "hi")]);
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled >= 0);
      assert.equal(f.registry.calls, 0);
      // A queued native fallback owns the next idle point; with suppression
      // instead, the settle stays a no-op.
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);

      // Growth alone does not re-arm since the context did not move.
      f.setBranch([
        userEntry("e1", null, "hi"),
        userEntry("e2", "e1", "a longer second turn that still fits the whole tail"),
      ]);
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 0);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);

      // The emergency hatch above stays independent of the suppression: a
      // usage spike still compacts natively at idle.
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
    } finally {
      await f.cleanup();
    }
  });

  it("fails closed to full context when a native compaction lands mid-run", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      // A native compaction from another path lands: the serving checkpoint
      // is stale, so the swap fails closed to full context.
      f.setBranch([...f.branch, compactionEntry("c1", "e4")]);
      const swapped = await f.emit("context", { messages: f.contextMessages() });
      assert.equal(swapped, undefined);
    } finally {
      await f.cleanup();
    }
  });
});

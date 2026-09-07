import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  ShadowCompactStateController,
  type PreparingInfo,
  type PreparedResult,
} from "../src/state.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let resultSeq = 0;

function prepared(): PreparedResult {
  resultSeq++;
  return {
    checkpointId: `checkpoint-${resultSeq}`,
    sessionId: `session-${resultSeq}`,
    leafId: `leaf-${resultSeq}`,
    latestCompactionId: null,
    firstKeptEntryId: `kept-${resultSeq}`,
    summary: `summary-${resultSeq}`,
    usage,
    details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
  };
}

function prepare(controller: ShadowCompactStateController): PreparingInfo {
  const preparing = controller.startPreparing();
  assert.ok(preparing);
  return preparing;
}

describe("ShadowCompactStateController", () => {
  it("starts idle, armed, with nothing serving", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.phase, "idle");
    assert.equal(controller.generation, 0);
    assert.equal(controller.published, undefined);
    assert.equal(controller.preparing, undefined);
    assert.equal(controller.persistedCheckpointId, undefined);
    assert.equal(controller.pendingNativeFallback, false);
    assert.equal(controller.refreshArmed, true);
    assert.equal(controller.emptySuppressedAtTokens, undefined);
  });

  it("starts a preparation and disarms the refresh gate", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    assert.equal(preparing.generation, 1);
    assert.equal(preparing.controller.signal.aborted, false);
    assert.equal(controller.phase, "preparing");
    assert.equal(controller.refreshArmed, false);
    assert.equal(controller.startPreparing(), undefined);
  });

  it("publishes while serving: the replacement takes over and the swap flag resets", () => {
    const controller = new ShadowCompactStateController();
    const first = prepare(controller);
    const resultA = prepared();
    assert.equal(controller.publish(first.generation, resultA), true);
    assert.equal(controller.phase, "ready");
    assert.equal(controller.published, resultA);
    assert.equal(controller.publishedSwapped, false);

    // A published checkpoint keeps serving while its replacement prepares.
    const second = controller.startPreparing();
    assert.ok(second);
    assert.equal(controller.phase, "ready-preparing");

    assert.ok(controller.markSwapped());
    assert.equal(controller.markSwapped(), false);

    const resultB = prepared();
    assert.equal(controller.publish(second.generation, resultB), true);
    assert.equal(controller.phase, "ready");
    assert.equal(controller.published, resultB);
    assert.equal(controller.publishedSwapped, false);
  });

  it("publish only for matching generation and un-aborted controller", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    const result = prepared();

    assert.equal(controller.publish(preparing.generation + 1, result), false);
    assert.equal(controller.phase, "preparing");

    assert.equal(controller.publish(preparing.generation, result), true);
    assert.equal(controller.published, result);

    controller.reset();
    const second = prepare(controller);
    second.controller.abort();
    assert.equal(controller.publish(second.generation, prepared()), false);
    assert.equal(controller.phase, "preparing");
  });

  it("a failed replacement keeps the serving checkpoint and keeps the gate shut", () => {
    const controller = new ShadowCompactStateController();
    const first = prepare(controller);
    assert.equal(controller.publish(first.generation, prepared()), true);
    assert.ok(controller.markSwapped());

    const second = prepare(controller);
    assert.ok(second.generation !== first.generation, "every attempt has a unique generation");
    assert.equal(controller.fail(second.generation), true);
    // A stays published and serving; the failure must not manufacture a
    // threshold crossing, so only an observed swap + shrink re-arms.
    assert.ok(controller.published);
    assert.equal(controller.publishedSwapped, true);
    assert.equal(controller.pendingNativeFallback, false);
    assert.equal(controller.refreshArmed, false);
    assert.equal(controller.phase, "ready");
  });

  it("skipPreparation drops an empty snapshot without fallback and keeps the gate shut", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);

    assert.equal(controller.skipPreparation(preparing.generation + 100), false);
    assert.equal(controller.phase, "preparing");

    assert.equal(controller.skipPreparation(preparing.generation), true);
    assert.equal(controller.preparing, undefined);
    assert.equal(controller.published, undefined);
    assert.equal(controller.pendingNativeFallback, false);
    assert.equal(controller.refreshArmed, false);
    assert.equal(controller.phase, "idle");

    // A stale skip for the same generation no-ops once the phase cleared.
    assert.equal(controller.skipPreparation(preparing.generation), false);
  });

  it("skipPreparation records the suppression size; growth re-arms past max(1000, tail*0.25)", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    assert.equal(controller.skipPreparation(preparing.generation, 10_000), true);
    assert.equal(controller.emptySuppressedAtTokens, 10_000);

    // Tail budget 5440 (luna 2%): threshold is 10000 + max(1000, 1360) = 11360.
    assert.equal(controller.rearmAfterGrowth(11_359, 5440), false);
    assert.equal(controller.refreshArmed, false);
    assert.equal(controller.rearmAfterGrowth(11_360, 5440), true);
    assert.equal(controller.refreshArmed, true);
    assert.equal(controller.emptySuppressedAtTokens, undefined);
  });

  it("rearmAfterGrowth floors the growth step at 1000 tokens", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    assert.equal(controller.skipPreparation(preparing.generation, 600), true);
    // Tiny tail budget (30): threshold is 600 + max(1000, 7.5) = 1600.
    assert.equal(controller.rearmAfterGrowth(1599, 30), false);
    assert.equal(controller.rearmAfterGrowth(1600, 30), true);
    assert.equal(controller.refreshArmed, true);
  });

  it("rearmAfterGrowth never fires without a recorded suppression", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.rearmAfterGrowth(1_000_000, 5440), false);
    assert.equal(controller.refreshArmed, true);
  });

  it("a new attempt, publish, rearm, discard, or reset clears the suppression", () => {
    const controller = new ShadowCompactStateController();
    const first = prepare(controller);
    assert.equal(controller.skipPreparation(first.generation, 5000), true);

    const second = prepare(controller);
    assert.ok(second);
    assert.equal(controller.emptySuppressedAtTokens, undefined);

    assert.equal(controller.publish(second.generation, prepared()), true);
    assert.equal(controller.emptySuppressedAtTokens, undefined);

    const third = prepare(controller);
    assert.ok(third);
    assert.equal(controller.skipPreparation(third.generation, 7000), true);
    assert.ok(controller.markSwapped());
    assert.ok(controller.rearm());
    assert.equal(controller.emptySuppressedAtTokens, undefined);

    const fourth = prepare(controller);
    assert.ok(fourth);
    assert.equal(controller.skipPreparation(fourth.generation, 8000), true);
    assert.ok(controller.discardPublished());
    assert.equal(controller.emptySuppressedAtTokens, undefined);

    const fifth = prepare(controller);
    assert.ok(fifth);
    assert.equal(controller.skipPreparation(fifth.generation, 9000), true);
    controller.reset();
    assert.equal(controller.emptySuppressedAtTokens, undefined);
  });

  it("a failed replacement for an unswapped checkpoint keeps the gate shut", () => {
    const controller = new ShadowCompactStateController();
    const first = prepare(controller);
    assert.equal(controller.publish(first.generation, prepared()), true);

    const second = prepare(controller);
    assert.equal(controller.fail(second.generation), true);
    assert.ok(controller.published);
    assert.equal(controller.refreshArmed, false);
  });

  it("failing with nothing serving queues the native fallback and re-arms", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);

    assert.equal(controller.fail(preparing.generation + 1), false);
    assert.equal(controller.phase, "preparing");

    assert.equal(controller.fail(preparing.generation), true);
    assert.equal(controller.published, undefined);
    assert.equal(controller.pendingNativeFallback, true);
    assert.equal(controller.refreshArmed, true);
    assert.equal(controller.phase, "idle");

    assert.equal(controller.fail(preparing.generation), false);
  });

  it("requestNativeFallback aborts preparation, keeps the serving checkpoint, queues once", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);

    assert.equal(controller.requestNativeFallback(), true);
    assert.equal(preparing.controller.signal.aborted, true);
    assert.equal(controller.pendingNativeFallback, true);
    assert.equal(controller.requestNativeFallback(), false);
  });

  it("clearPendingNativeFallback only once and never mid-flight", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.clearPendingNativeFallback(), false);

    const preparing = prepare(controller);
    assert.equal(controller.fail(preparing.generation), true);
    assert.equal(controller.clearPendingNativeFallback(), true);
    assert.equal(controller.pendingNativeFallback, false);
    assert.equal(controller.clearPendingNativeFallback(), false);

    // Not while preparing.
    prepare(controller);
    assert.equal(controller.clearPendingNativeFallback(), false);
  });

  it("markPersisted records the durable checkpoint without disturbing service", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    const result = prepared();
    assert.equal(controller.publish(preparing.generation, result), true);
    assert.equal(controller.persistedCheckpointId, undefined);

    controller.markPersisted(result.checkpointId);
    assert.equal(controller.persistedCheckpointId, result.checkpointId);
    // The checkpoint keeps serving after it lands: no stand-down state.
    assert.equal(controller.published, result);
    assert.equal(controller.phase, "ready");

    // Replacing the checkpoint leaves the old persist marker behind until the
    // replacement lands — the idle path compares ids to persist exactly once.
    const next = prepare(controller);
    assert.ok(next);
    const replacement = prepared();
    assert.equal(controller.publish(next.generation, replacement), true);
    assert.equal(controller.persistedCheckpointId, result.checkpointId);
    controller.markPersisted(replacement.checkpointId);
    assert.equal(controller.persistedCheckpointId, replacement.checkpointId);
  });

  it("restorePublished serves a validated checkpoint as already durable", () => {
    const controller = new ShadowCompactStateController();
    const result = prepared();
    controller.restorePublished(result);
    assert.equal(controller.published, result);
    assert.equal(controller.publishedSwapped, false);
    assert.equal(controller.persistedCheckpointId, result.checkpointId);
    assert.equal(controller.refreshArmed, false);
    assert.equal(controller.phase, "ready");
  });

  it("discardPublished drops a stale checkpoint and re-arms for a fresh retry", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.discardPublished(), false);
    const preparing = prepare(controller);
    assert.equal(controller.publish(preparing.generation, prepared()), true);
    assert.ok(controller.discardPublished());
    assert.equal(controller.published, undefined);
    assert.equal(controller.refreshArmed, true);
    assert.equal(controller.phase, "idle");
  });

  it("reset aborts preparing, clears everything, bumps generation, and re-arms", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    assert.equal(preparing.generation, 1);
    controller.reset();

    assert.equal(preparing.controller.signal.aborted, true);
    assert.equal(controller.phase, "idle");
    assert.equal(controller.generation, 2);
    assert.equal(controller.pendingNativeFallback, false);
    assert.equal(controller.refreshArmed, true);
    assert.equal(controller.publish(preparing.generation, prepared()), false);
    assert.equal(controller.fail(preparing.generation), false);

    const next = prepare(controller);
    assert.equal(next.generation, 3);
    const published = prepared();
    assert.equal(controller.publish(next.generation, published), true);
    controller.markPersisted(published.checkpointId);
    controller.reset();
    assert.equal(controller.generation, 4);
    assert.equal(controller.persistedCheckpointId, undefined);
    assert.equal(controller.emptySuppressedAtTokens, undefined);
  });
});

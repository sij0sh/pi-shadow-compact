import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  ShadowCompactStateController,
  type PreparingState,
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
    sessionId: `session-${resultSeq}`,
    leafId: `leaf-${resultSeq}`,
    latestCompactionId: null,
    firstKeptEntryId: `kept-${resultSeq}`,
    summary: `summary-${resultSeq}`,
    usage,
    details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
  };
}

function prepare(controller: ShadowCompactStateController): PreparingState {
  const preparing = controller.startPreparing();
  assert.ok(preparing);
  return preparing;
}

describe("ShadowCompactStateController", () => {
  it("startPreparing only from idle", () => {
    const controller = new ShadowCompactStateController();
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: 0,
      pendingNativeFallback: false,
    });

    const preparing = prepare(controller);
    assert.equal(preparing.generation, 0);
    assert.equal(preparing.controller.signal.aborted, false);
    assert.equal(controller.startPreparing(), undefined);

    // Not from preparing once published.
    const result = prepared();
    assert.equal(controller.publish(preparing.generation, result), true);
    assert.equal(controller.startPreparing(), undefined);

    // Not from committing.
    assert.ok(controller.beginCommit("nonce"));
    assert.equal(controller.startPreparing(), undefined);

    controller.reset();
    const next = prepare(controller);
    assert.equal(next.generation, 1);
  });

  it("publish only for matching generation and un-aborted controller", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    const result = prepared();

    assert.equal(controller.publish(preparing.generation + 1, result), false);
    const rejected = controller.current;
    assert.equal(rejected.phase, "preparing");

    assert.equal(controller.publish(preparing.generation, result), true);
    const ready = controller.current;
    assert.equal(ready.phase, "ready");
    if (ready.phase === "ready") {
      assert.equal(ready.result, result);
    }

    controller.reset();
    const second = prepare(controller);
    second.controller.abort();
    assert.equal(controller.publish(second.generation, prepared()), false);
    const aborted = controller.current;
    assert.equal(aborted.phase, "preparing");
  });

  it("fail with matching generation sets pendingNativeFallback", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);

    assert.equal(controller.fail(preparing.generation + 1), false);
    const stillPreparing = controller.current;
    assert.equal(stillPreparing.phase, "preparing");

    assert.equal(controller.fail(preparing.generation), true);
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: preparing.generation,
      pendingNativeFallback: true,
    });

    assert.equal(controller.fail(preparing.generation), false);
    assert.equal(controller.fail(0), false);
  });

  it("clearPendingNativeFallback only once from idle", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.clearPendingNativeFallback(), false);

    const preparing = prepare(controller);
    assert.equal(controller.fail(preparing.generation), true);
    assert.equal(controller.clearPendingNativeFallback(), true);
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: preparing.generation,
      pendingNativeFallback: false,
    });
    assert.equal(controller.clearPendingNativeFallback(), false);

    // Not while preparing.
    prepare(controller);
    assert.equal(controller.clearPendingNativeFallback(), false);
  });

  it("beginCommit only from ready and carries result and nonce", () => {
    const controller = new ShadowCompactStateController();
    assert.equal(controller.beginCommit("nonce-early"), undefined);

    const preparing = prepare(controller);
    assert.equal(controller.beginCommit("nonce-preparing"), undefined);

    const result = prepared();
    assert.equal(controller.publish(preparing.generation, result), true);

    const committing = controller.beginCommit("nonce-1");
    assert.ok(committing);
    assert.equal(committing.phase, "committing");
    assert.equal(committing.generation, preparing.generation);
    assert.equal(committing.nonce, "nonce-1");
    assert.equal(committing.result, result);

    assert.equal(controller.beginCommit("nonce-2"), undefined);
  });

  it("reset aborts preparing controller and stale publishes fail", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    controller.reset();

    assert.equal(preparing.controller.signal.aborted, true);
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: 1,
      pendingNativeFallback: false,
    });
    assert.equal(controller.publish(preparing.generation, prepared()), false);
    assert.equal(controller.fail(preparing.generation), false);

    const next = prepare(controller);
    assert.equal(next.generation, 1);
    assert.equal(controller.publish(next.generation, prepared()), true);
    controller.reset();
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: 2,
      pendingNativeFallback: false,
    });
  });

  it("reset from idle is idempotent", () => {
    const controller = new ShadowCompactStateController();
    controller.reset();
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: 1,
      pendingNativeFallback: false,
    });
    controller.reset();
    assert.deepEqual(controller.current, {
      phase: "idle",
      generation: 2,
      pendingNativeFallback: false,
    });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  ShadowCompactStateController,
  isAdoptMarker,
  isProbeMarker,
  type PreparedSummary,
} from "../src/state.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function prepared(summary = "checkpoint"): PreparedSummary {
  return {
    snapshot: {
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      leafId: "leaf-1",
      firstKeptEntryId: "kept-1",
    },
    summary,
    usage,
    details: {
      readFiles: ["src/input.ts"],
      modifiedFiles: ["src/output.ts"],
      provenance: {
        digest: "sha256:packet",
        evidenceCount: 4,
        truncated: false,
        usedPreviousCheckpointFallback: false,
        evidenceRefs: ["ev-1"],
      },
    },
  };
}

function prepare(controller: ShadowCompactStateController) {
  const probe = controller.beginProbe();
  assert.ok(probe);
  const preparing = controller.beginPreparation(probe.marker);
  assert.ok(preparing);
  return preparing;
}

describe("ShadowCompactStateController", () => {
  it("moves through probe, preparation, and ready with typed payloads", () => {
    const controller = new ShadowCompactStateController();
    assert.deepEqual(controller.current, { phase: "idle", epoch: 0 });

    const probe = controller.beginProbe();
    assert.ok(probe);
    assert.ok(isProbeMarker(probe.marker));
    assert.equal(controller.beginProbe(), undefined);
    assert.equal(controller.beginPreparation("wrong"), undefined);

    const preparing = controller.beginPreparation(probe.marker);
    assert.ok(preparing);
    assert.equal(preparing.epoch, 1);
    assert.equal(preparing.controller.signal.aborted, false);
    assert.equal(controller.matchesProbe(probe.marker), true);

    const result = prepared();
    assert.equal(controller.publish(preparing.epoch, result), true);
    assert.equal(controller.current.phase, "ready");
    if (controller.current.phase === "ready") {
      assert.equal(controller.current.prepared, result);
      assert.equal(controller.current.prepared.snapshot.sessionFile, "/tmp/session.jsonl");
      assert.equal(controller.current.prepared.details.provenance.digest, "sha256:packet");
    }
  });

  it("rejects stale workers after reset and keeps epochs monotonic", () => {
    const controller = new ShadowCompactStateController();
    const first = prepare(controller);
    controller.reset();

    assert.equal(first.controller.signal.aborted, true);
    assert.equal(controller.current.phase, "idle");
    assert.equal(controller.current.epoch, 2);
    assert.equal(controller.isCurrent(first.epoch), false);
    assert.equal(controller.publish(first.epoch, prepared("stale")), false);
    assert.equal(controller.failPreparation(first.epoch), false);

    const second = prepare(controller);
    assert.equal(second.epoch, 3);
    assert.equal(controller.isCurrent(second.epoch), true);
    assert.equal(controller.failPreparation(second.epoch), true);
    assert.equal(second.controller.signal.aborted, true);
    assert.equal(controller.current.epoch, 4);
  });

  it("shares one adoption promise and gives attempts unique markers", async () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    const result = prepared();
    assert.equal(controller.publish(preparing.epoch, result), true);

    let starts = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = controller.beginAdoption(async (marker) => {
      starts++;
      assert.ok(isAdoptMarker(marker));
      await blocked;
    });
    assert.ok(first);
    const second = controller.beginAdoption(async () => { starts++; });
    assert.equal(second, first);
    assert.equal(starts, 0);

    assert.equal(controller.current.phase, "adopting");
    if (controller.current.phase === "adopting") {
      assert.equal(controller.current.prepared, result);
      assert.equal(controller.current.promise, first);
      assert.equal(controller.matchesAdoption(controller.current.marker), true);
      assert.equal(controller.matchesAdoption("wrong"), false);
    }

    await Promise.resolve();
    assert.equal(starts, 1);
    release();
    await first;

    const firstMarker = controller.current.phase === "adopting" ? controller.current.marker : "";
    controller.reset();
    const nextPreparation = prepare(controller);
    controller.publish(nextPreparation.epoch, prepared("next"));
    const next = controller.beginAdoption(async () => {});
    assert.ok(next);
    if (controller.current.phase === "adopting") {
      assert.notEqual(controller.current.marker, firstMarker);
    }
    await next;
  });

  it("aborts only background work and disposal is terminal", () => {
    const controller = new ShadowCompactStateController();
    const preparing = prepare(controller);
    controller.dispose();

    assert.equal(preparing.controller.signal.aborted, true);
    assert.equal(controller.current.phase, "disposed");
    assert.equal(controller.current.epoch, 2);
    assert.equal(controller.isCurrent(2), false);
    assert.equal(controller.beginProbe(), undefined);

    controller.reset();
    controller.dispose();
    assert.deepEqual(controller.current, { phase: "disposed", epoch: 2 });
  });

  it("recognizes only complete prefixed markers", () => {
    assert.equal(isProbeMarker("[shadow-compact:probe:x]"), true);
    assert.equal(isProbeMarker("[shadow-compact:probe:x"), false);
    assert.equal(isProbeMarker("[shadow-compact:adopt:x]"), false);
    assert.equal(isAdoptMarker("[shadow-compact:adopt:x]"), true);
    assert.equal(isAdoptMarker(undefined), false);
  });
});

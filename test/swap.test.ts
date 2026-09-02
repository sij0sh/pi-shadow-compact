import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextSwapDropCount } from "../src/swap.js";
import { userEntry } from "./helpers/index-fixture.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function compaction(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TIMESTAMP,
    summary: "native summary",
    firstKeptEntryId,
    tokensBefore: 1234,
  } as unknown as SessionEntry;
}

describe("contextSwapDropCount", () => {
  it("counts every context message before the prepared cut without a prior compaction", () => {
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      userEntry("e3", "e2", "three"),
      userEntry("e4", "e3", "four"),
    ];
    assert.equal(contextSwapDropCount(branch, "e4", null), 3);
    assert.equal(contextSwapDropCount(branch, "e1", null), 0);
  });

  it("counts the previous compaction entry as the old summary message", () => {
    // Context after c1: [c1 summary, e1, e2, e3, e4].
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      compaction("c1", "e1", "e1"),
      userEntry("e3", "e2", "three"),
      userEntry("e4", "e3", "four"),
    ];
    // A cut at e3 drops the summary plus e1 and e2; only e3 and e4 stay.
    assert.equal(contextSwapDropCount(branch, "e3", "c1"), 3);
    // A cut at e4 keeps only e4; the summary replaces everything else.
    assert.equal(contextSwapDropCount(branch, "e4", "c1"), 4);
  });

  it("drops the stale tail from the previous kept boundary to the new cut", () => {
    // Context after c1: [c1 summary, e3, e4, e5, e6].
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      userEntry("e3", "e2", "three"),
      userEntry("e4", "e3", "four"),
      compaction("c1", "e4", "e3"),
      userEntry("e5", "e4", "five"),
      userEntry("e6", "e5", "six"),
    ];
    // A cut at e6 drops the summary plus e3, e4, and e5.
    assert.equal(contextSwapDropCount(branch, "e6", "c1"), 4);
    // A cut between the previous kept boundary and the compaction entry drops
    // the summary plus the stale entries in between.
    assert.equal(contextSwapDropCount(branch, "e4", "c1"), 2);
    // A cut at the previous kept boundary only replaces the summary.
    assert.equal(contextSwapDropCount(branch, "e3", "c1"), 1);
  });

  it("returns undefined for cuts off the branch or before the previous boundary", () => {
    const branch = [userEntry("e1", null, "one"), userEntry("e2", "e1", "two")];
    assert.equal(contextSwapDropCount(branch, "missing", null), undefined);

    const withCompaction = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      compaction("c1", "e2", "gone"),
      userEntry("e3", "e2", "three"),
    ];
    // Fallback when the previous kept entry is gone: only the summary is replaced.
    assert.equal(contextSwapDropCount(withCompaction, "e3", "c1"), 1);
    // A cut before the previous boundary cannot swap.
    assert.equal(contextSwapDropCount(withCompaction, "e2", "c1"), undefined);
  });
});

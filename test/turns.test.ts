import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { segmentTurns } from "../src/turns.js";
import { userEntry } from "./helpers/index-fixture.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 },
  } as unknown as SessionEntry;
}

describe("segmentTurns", () => {
  it("anchors a turn at each user message", () => {
    const branch = [
      userEntry("e1", null, "first task"),
      assistantEntry("e2", "e1", "working on it now"),
      userEntry("e3", "e2", "second task"),
    ];
    const turns = segmentTurns(branch);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0]!.entryIds, ["e1", "e2"]);
    assert.deepEqual(turns[1]!.entryIds, ["e3"]);
    assert.equal(turns[0]!.id, "turn-1");
  });

  it("joins leading non-user entries into the first turn", () => {
    const branch = [assistantEntry("e1", null, "hello"), userEntry("e2", "e1", "go")];
    const turns = segmentTurns(branch);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.entryIds, ["e1", "e2"]);
  });

  it("treats a branch with no user message as one turn", () => {
    const branch = [assistantEntry("e1", null, "hello")];
    assert.equal(segmentTurns(branch).length, 1);
    assert.deepEqual(segmentTurns([]), []);
  });
});

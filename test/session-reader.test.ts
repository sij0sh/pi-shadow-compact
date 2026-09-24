import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PREVIOUS_CHECKPOINT_EVIDENCE_ID, SessionHistoryIndex } from "../src/session-reader.js";
import { userEntry } from "./helpers/index-fixture.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const CWD = "/repo";

function toolResultEntry(
  id: string,
  parentId: string | null,
  callId: string,
  toolName: string,
  output: string,
  isError: boolean,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text: output }],
      isError,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function branchFixture(): SessionEntry[] {
  return [
    userEntry("e1", null, "Set up the project scaffolding now"),
    userEntry("e2", "e1", "No, use pnpm instead of npm"),
    userEntry("e3", "e2", "Why is the build failing here?"),
    toolResultEntry("e4", "e3", "c1", "bash", "boom", true),
  ];
}

describe("SessionHistoryIndex", () => {
  it("flags corrections, errors, and questions in the manifest", () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: CWD });
    const manifest = index.manifest();
    assert.equal(manifest.turnCount, 3);
    assert.equal(manifest.lastEntryId, "e4");
    const byId = new Map(manifest.turns.map((turn) => [turn.turnId, turn]));
    assert.equal(byId.get("turn-2")!.hasUserCorrection, true);
    assert.equal(byId.get("turn-3")!.hasError, true);
    assert.equal(byId.get("turn-3")!.hasQuestion, true);
    assert.deepEqual(manifest.requiredTurnIds, ["turn-1", "turn-2", "turn-3"]);
  });

  it("requires only post-coverage turns once a previous checkpoint exists", () => {
    const index = new SessionHistoryIndex({
      branch: branchFixture(),
      cwd: CWD,
      previousCoverageEndEntryId: "e2",
      previousCheckpointSummary: "old summary",
    });
    assert.deepEqual(index.requiredTurnIds(), ["turn-1", "turn-2", "turn-3"]);
    const clean = new SessionHistoryIndex({
      branch: [userEntry("e1", null, "first task here please"), userEntry("e2", "e1", "second task here please")],
      cwd: CWD,
      previousCoverageEndEntryId: "e1",
      previousCheckpointSummary: "old summary",
    });
    assert.deepEqual(clean.requiredTurnIds(), ["turn-1", "turn-2"]);
    assert.equal(clean.previousCheckpoint()?.evidenceId, PREVIOUS_CHECKPOINT_EVIDENCE_ID);
  });

  it("pages entries and turns with stable evidence ids and tracks inspection", () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: CWD });
    assert.deepEqual(index.missingRequiredTurnIds(), ["turn-1", "turn-2", "turn-3"]);
    const page = index.readEntries(1, 2);
    assert.equal(page.entries[0]!.evidenceId, "E0002");
    assert.equal(page.entries[0]!.entryId, "e2");
    const range = index.readTurnRange(1, 10);
    assert.equal(range.totalTurns, 3);
    assert.equal(range.turns.length, 3);
    assert.deepEqual(index.missingRequiredTurnIds(), []);
    assert.equal(index.inspectedEntryIds.size, 4);
  });

  it("reads single turns and searches without marking inspection", () => {
    const index = new SessionHistoryIndex({ branch: branchFixture(), cwd: CWD });
    const turn = index.readTurn("turn-2");
    assert.equal(turn.startEntryId, "e2");
    assert.throws(() => index.readTurn("turn-99"), /Unknown turn/);
    const fresh = new SessionHistoryIndex({ branch: branchFixture(), cwd: CWD });
    const hits = fresh.searchSessionHistory("pnpm");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.turnId, "turn-2");
    assert.equal(fresh.inspectedEntryIds.size, 0);
    assert.deepEqual(fresh.searchSessionHistory("   "), []);
  });

  it("sanitizes served text", () => {
    const index = new SessionHistoryIndex({
      branch: [userEntry("e1", null, "token=sk-abcdefghijklmnop1234 please rotate it now")],
      cwd: CWD,
    });
    const page = index.readEntries(0, 10);
    assert.ok(!page.entries[0]!.text.includes("sk-abcdefghijklmnop1234"));
  });

  it("tolerates malformed entries without throwing", () => {
    const branch = [
      userEntry("e1", null, "real task with enough words here"),
      {
        type: "message",
        id: "bad1",
        parentId: "e1",
        timestamp: "not-a-date",
        message: null,
      },
      {
        type: "message",
        id: "bad2",
        parentId: "bad1",
        timestamp: TIMESTAMP,
        message: { role: "assistant" },
      },
      { type: "weird", id: "bad3", parentId: "bad2", timestamp: TIMESTAMP },
    ] as unknown as SessionEntry[];
    const index = new SessionHistoryIndex({ branch, cwd: CWD });
    assert.ok(index.manifest().turnCount >= 1);
    assert.ok(index.readTurnRange(1, 10).turns.length >= 1);
    assert.equal(index.searchSessionHistory("real task").length, 1);
  });

  it("never mutates the branch it reads", () => {
    const branch = branchFixture();
    const before = JSON.stringify(branch);
    const index = new SessionHistoryIndex({ branch, cwd: CWD });
    index.manifest();
    index.readEntries(0, 10);
    index.readTurnRange(1, 10);
    index.readTurn("turn-1");
    index.searchSessionHistory("the");
    index.previousCheckpoint();
    assert.equal(JSON.stringify(branch), before);
  });

  it("tracks inspection independently per index instance", () => {
    const branch = branchFixture();
    const builderIndex = new SessionHistoryIndex({ branch, cwd: CWD });
    const verifierIndex = new SessionHistoryIndex({ branch, cwd: CWD });
    builderIndex.readTurnRange(1, 10);
    assert.equal(builderIndex.inspectedEntryIds.size, 4);
    assert.equal(verifierIndex.inspectedEntryIds.size, 0);
    assert.deepEqual(verifierIndex.missingRequiredTurnIds(), ["turn-1", "turn-2", "turn-3"]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyContinuationState,
  renderCheckpoint,
  validateCheckpointObject,
  type Checkpoint,
} from "../src/summary.js";

const REFS = new Set(["E0001", "E0002"]);

function legacyJson(): string {
  return JSON.stringify({
    objective: [{ text: "Ship it", evidenceRefs: ["E0001"] }],
    constraints: [],
    completedWork: [],
    currentState: [],
    decisions: [],
    openIssues: [],
    nextActions: [],
    criticalContext: [],
    modifiedFiles: [],
    referencedFiles: [],
  });
}

describe("checkpoint schema additions", () => {
  it("accepts legacy checkpoints without the new sections", () => {
    const checkpoint = validateCheckpointObject(JSON.parse(legacyJson()), REFS);
    assert.deepEqual(checkpoint.verificationState, []);
    assert.deepEqual(checkpoint.continuationState, emptyContinuationState());
    const rendered = renderCheckpoint(checkpoint);
    assert.ok(!rendered.includes("Verification State"));
    assert.ok(!rendered.includes("## Continuation"));
  });

  it("validates verificationState entries and renders them", () => {
    const checkpoint = validateCheckpointObject(
      {
        ...JSON.parse(legacyJson()),
        verificationState: [
          { text: "npm test passed", status: "verified", evidenceRefs: ["E0002"] },
          { text: "reconnect untested", status: "unverified", evidenceRefs: ["E0001"] },
        ],
        continuationState: {
          currentGoal: "Ship it",
          currentApproach: "Fix the parser",
          immediateNextStep: "Run the suite",
        },
      },
      REFS,
    );
    assert.equal(checkpoint.verificationState.length, 2);
    const rendered = renderCheckpoint(checkpoint);
    assert.ok(rendered.includes("- [verified] npm test passed"));
    assert.ok(rendered.includes("- [unverified] reconnect untested"));
    assert.ok(rendered.includes("- Goal: Ship it"));
    assert.ok(rendered.includes("- Approach: Fix the parser"));
    assert.ok(rendered.includes("- Next: Run the suite"));
  });

  it("rejects malformed new sections", () => {
    const base = JSON.parse(legacyJson());
    assert.throws(
      () =>
        validateCheckpointObject(
          { ...base, verificationState: [{ text: "x", status: "maybe", evidenceRefs: ["E0001"] }] },
          REFS,
        ),
      /needs status verified or unverified/,
    );
    assert.throws(
      () =>
        validateCheckpointObject(
          { ...base, verificationState: [{ text: "x", status: "verified", evidenceRefs: [] }] },
          REFS,
        ),
      /needs at least one evidenceRef/,
    );
    assert.throws(
      () =>
        validateCheckpointObject(
          { ...base, continuationState: { currentGoal: "", currentApproach: "a", immediateNextStep: "b" } },
          REFS,
        ),
      /must be a non-empty string/,
    );
    assert.throws(
      () => validateCheckpointObject({ ...base, surprises: [] }, REFS),
      /Unexpected checkpoint key: surprises/,
    );
    assert.throws(
      () => validateCheckpointObject({ ...base, coverageEndEntryId: "E0001" }, REFS),
      /coverageEndEntryId.*beside checkpoint, not inside it/,
    );
  });

  it("renders sections in schema order", () => {
    const checkpoint = validateCheckpointObject(
      {
        ...JSON.parse(legacyJson()),
        nextActions: [{ text: "Do the thing", evidenceRefs: ["E0001"] }],
        completedWork: [{ text: "Did the other thing", evidenceRefs: ["E0001"] }],
      },
      REFS,
    );
    const rendered = renderCheckpoint(checkpoint);
    assert.ok(rendered.indexOf("## Completed Work") < rendered.indexOf("## Next Actions"));
  });

  it("rejects bare-string items with an actionable object shape", () => {
    const base = JSON.parse(legacyJson());
    assert.throws(
      () =>
        validateCheckpointObject(
          { ...base, completedWork: ["Did the thing"] },
          REFS,
        ),
      /Item 0 in completedWork must be an object like.*got string/,
    );
    assert.throws(
      () =>
        validateCheckpointObject(
          { ...base, completedWork: [["Did the thing"]] },
          REFS,
        ),
      /Item 0 in completedWork must be an object like.*got array/,
    );
  });

  it("still rejects an entirely empty checkpoint", () => {
    const empty: Record<string, unknown> = {
      objective: [{ text: "g", evidenceRefs: ["E0001"] }],
    };
    for (const key of [
      "constraints",
      "completedWork",
      "currentState",
      "decisions",
      "openIssues",
      "nextActions",
      "criticalContext",
      "modifiedFiles",
      "referencedFiles",
    ]) {
      empty[key] = [];
    }
    empty.objective = [];
    (empty as Record<string, unknown>).verificationState = [];
    assert.throws(() => validateCheckpointObject(empty, REFS), /entirely empty/);
    const checkpoint = validateCheckpointObject(
      { ...empty, objective: [{ text: "g", evidenceRefs: ["E0001"] }] },
      REFS,
    );
    assert.ok(checkpoint satisfies Checkpoint);
  });
});

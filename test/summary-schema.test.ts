import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import {
  collectEvidenceRefs,
  parseAuditedInventory,
  parseCheckpoint,
  parseEvidenceInventory,
  parseModelJson,
  renderCheckpoint,
  type Checkpoint,
} from "../src/summary-schema.js";
import type { NormalizedPacket } from "../src/types.js";

const packet: NormalizedPacket = {
  evidence: ["e1", "e2", "e3"].map((evidenceId) => ({
    evidenceId,
    sourceEntryId: `source-${evidenceId}`,
    kind: "assistant",
    text: evidenceId,
  })),
  digest: "digest",
  truncated: false,
  usedPreviousCheckpointFallback: false,
};

const checkpoint: Checkpoint = {
  objective: [{ text: "Ship the schema.", evidenceRefs: ["e1"] }],
  constraints: [{ text: "Use Zod.", evidenceRefs: ["e1"] }],
  completedWork: [
    {
      work: "Implemented parsing.",
      result: "JSON is validated.",
      verification: "Targeted tests pass.",
      evidenceRefs: ["e2"],
    },
  ],
  discoveries: [
    {
      discovery: "The packet has normalized IDs.",
      evidence: "The packet contains e1 through e3.",
      implication: "References can be checked locally.",
      evidenceRefs: ["e1", "e2"],
    },
  ],
  decisions: [
    {
      decision: "Render Markdown in code.",
      rationale: "Output stays deterministic.",
      evidenceRefs: ["e2"],
    },
  ],
  currentState: [{ state: "Implementation is ready.", evidenceRefs: ["e3"] }],
  rejectedApproaches: [
    {
      approach: "Trust model-written Markdown.",
      rationale: "It is not structurally reliable.",
      evidenceRefs: ["e1"],
    },
  ],
  openIssues: [{ issue: "Integration remains.", evidenceRefs: ["e3"] }],
  nextActions: [{ action: "Connect the summary agent.", evidenceRefs: ["e3"] }],
  continuityData: [{ data: "Packet digest: digest", evidenceRefs: ["e2"] }],
  modifiedFiles: [{ path: "src/summary-schema.ts", evidenceRefs: ["e2"] }],
  referencedFiles: [{ path: "src/types.ts", evidenceRefs: ["e1"] }],
};

test("parses strict grounded checkpoint JSON", () => {
  assert.deepEqual(parseCheckpoint(JSON.stringify(checkpoint), packet), checkpoint);

  const unsupported = { ...checkpoint, unsupported: true };
  assert.throws(() => parseCheckpoint(JSON.stringify(unsupported), packet), ZodError);

  const emptyText = structuredClone(checkpoint);
  emptyText.objective[0]!.text = "  ";
  assert.throws(() => parseCheckpoint(JSON.stringify(emptyText), packet), ZodError);
});

test("validates every evidence reference against normalized packet IDs", () => {
  const unknown = structuredClone(checkpoint);
  unknown.nextActions[0]!.evidenceRefs = ["missing"];

  assert.throws(
    () => parseCheckpoint(JSON.stringify(unknown), packet),
    (error: unknown) =>
      error instanceof ZodError &&
      error.issues.some(
        (issue) =>
          issue.message === "Unknown evidence reference: missing" &&
          issue.path.join(".") === "nextActions.0.evidenceRefs.0",
      ),
  );

  const ungrounded = structuredClone(checkpoint);
  ungrounded.decisions[0]!.evidenceRefs = [];
  assert.throws(() => parseCheckpoint(JSON.stringify(ungrounded), packet), ZodError);
});

test("applies grounding validation to extraction and audited inventories", () => {
  const raw = JSON.stringify(checkpoint);
  assert.deepEqual(parseEvidenceInventory(raw, packet), checkpoint);
  assert.deepEqual(parseAuditedInventory(raw, packet), checkpoint);

  const unknown = raw.replace('"e3"', '"unknown"');
  assert.throws(() => parseEvidenceInventory(unknown, packet), ZodError);
  assert.throws(() => parseAuditedInventory(unknown, packet), ZodError);
});

test("accepts raw JSON or exactly one JSON fence without prose", () => {
  assert.deepEqual(parseModelJson(' {"ok":true} '), { ok: true });
  assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseModelJson('```JSON  \r\n{"ok":true}\r\n```'), { ok: true });

  for (const raw of [
    'Here is JSON:\n```json\n{"ok":true}\n```',
    '```\n{"ok":true}\n```',
    '```json\n{"ok":true}\n```\nextra',
    '```json\n{"ok":true}\n```\n```json\n{}\n```',
    '{not json}',
  ]) {
    assert.throws(() => parseModelJson(raw));
  }
});

test("renders every section deterministically without evidence references", () => {
  const markdown = renderCheckpoint(checkpoint);
  assert.equal(renderCheckpoint(checkpoint), markdown);
  assert.ok(markdown.startsWith("# Continuation Checkpoint\n\n## Objective\n"));

  for (const heading of [
    "Objective",
    "Constraints and Preferences",
    "Completed Work",
    "Discoveries",
    "Decisions",
    "Current State",
    "Rejected Approaches",
    "Open Issues",
    "Next Actions",
    "Continuity Data",
    "Modified Files",
    "Referenced Files",
  ]) {
    assert.equal(markdown.match(new RegExp(`^## ${heading}$`, "gm"))?.length, 1);
  }

  assert.match(markdown, /- Result: JSON is validated\./);
  assert.match(markdown, /- Verification: Targeted tests pass\./);
  assert.match(markdown, /- Evidence: The packet contains e1 through e3\./);
  assert.match(markdown, /- Implication: References can be checked locally\./);
  assert.doesNotMatch(markdown, /evidenceRefs|\[e[123]\]/);
  assert.ok(markdown.endsWith("\n"));
});

test("renders all empty sections as none", () => {
  const empty = Object.fromEntries(
    Object.keys(checkpoint).map((key) => [key, []]),
  ) as unknown as Checkpoint;
  const markdown = renderCheckpoint(empty);

  assert.equal(markdown.match(/^\(none\)$/gm)?.length, 12);
  assert.equal(markdown.match(/^## /gm)?.length, 12);
});

test("returns sorted, unique, capped provenance references", () => {
  assert.deepEqual(collectEvidenceRefs(checkpoint), ["e1", "e2", "e3"]);
  assert.deepEqual(collectEvidenceRefs(checkpoint, 2), ["e1", "e2"]);
  assert.deepEqual(collectEvidenceRefs(checkpoint, 0), []);
  assert.throws(() => collectEvidenceRefs(checkpoint, -1));
});

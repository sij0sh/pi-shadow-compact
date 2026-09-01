import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fileDetails, prepareSnapshot } from "../src/prepare.js";

let sequence = 0;

function entry(value: object): SessionEntry {
  sequence++;
  return {
    id: `entry-${sequence}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...value,
  } as SessionEntry;
}

function userEntry(content: string): SessionEntry {
  return entry({
    type: "message",
    message: { role: "user", content, timestamp: sequence },
  });
}

function assistantTextEntry(text: string): SessionEntry {
  return entry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: sequence,
    },
  });
}

function assistantToolCallEntry(name: string, args: object): SessionEntry {
  return entry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${sequence}`, name, arguments: args }],
      timestamp: sequence,
    },
  });
}

function toolResultEntry(toolCallId: string, text: string): SessionEntry {
  return entry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: sequence,
    },
  });
}

function compactionEntry(summary: string, firstKeptEntryId: string): SessionEntry {
  return entry({
    type: "compaction",
    summary,
    firstKeptEntryId,
    tokensBefore: 150_000,
  });
}

test("returns undefined for an empty branch and for a branch ending in compaction", () => {
  assert.equal(prepareSnapshot([], 100), undefined);

  const kept = userEntry("kept entry");
  const compaction = compactionEntry("Checkpoint", kept.id);
  assert.equal(prepareSnapshot([kept, compaction], 100), undefined);
});

test("computes a cut without prior compaction", () => {
  sequence = 0;
  const opener = userEntry("small opener");
  const bulk = userEntry(`x`.repeat(400));
  const newest = userEntry("final question");

  const result = prepareSnapshot([opener, bulk, newest], 10);
  assert.ok(result);
  assert.deepEqual(result.sourceEntries, [opener]);
  assert.equal(result.firstKeptEntryId, bulk.id);
  assert.equal(result.latestCompactionId, null);
  assert.equal("previousSummary" in result, false);
  assert.deepEqual(result.turnPrefixEntries, []);
  assert.deepEqual(result.readFiles, []);
  assert.deepEqual(result.modifiedFiles, []);
});

test("prior compaction bounds the cut and exposes previousSummary and latestCompactionId", () => {
  sequence = 0;
  const before = userEntry("before checkpoint");
  const kept = userEntry("after checkpoint");
  const compaction = compactionEntry("Prior checkpoint", kept.id);
  const bulk = userEntry(`y`.repeat(400));
  const newest = userEntry("newest");

  const result = prepareSnapshot([before, compaction, kept, bulk, newest], 10);
  assert.ok(result);
  assert.deepEqual(result.sourceEntries, [kept]);
  assert.equal(result.firstKeptEntryId, bulk.id);
  assert.equal(result.previousSummary, "Prior checkpoint");
  assert.equal(result.latestCompactionId, compaction.id);
});

test("split turn yields turnPrefixEntries and keeps the assistant toolCall entry", () => {
  sequence = 0;
  const turnOneUser = userEntry("First turn: update the old module");
  const turnOneAssistant = assistantToolCallEntry("edit", {
    path: "/work/project/src/old.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });
  const turnTwoUser = userEntry("Second turn: refactor it now");
  const readCall = assistantToolCallEntry("read", { path: "/work/project/src/parse.ts" });
  const readResult = toolResultEntry(`call-${readCall.id.split("-")[1]}`, `x`.repeat(800));
  const editCall = assistantToolCallEntry("edit", {
    path: "/work/project/src/config.ts",
    edits: [{ oldText: "a".repeat(2000), newText: "b".repeat(2000) }],
  });
  const editResult = toolResultEntry(`call-${editCall.id.split("-")[1]}`, "Edited.");

  const result = prepareSnapshot(
    [turnOneUser, turnOneAssistant, turnTwoUser, readCall, readResult, editCall, editResult],
    300,
  );
  assert.ok(result);
  assert.deepEqual(result.sourceEntries, [turnOneUser, turnOneAssistant]);
  assert.deepEqual(result.turnPrefixEntries, [turnTwoUser, readCall, readResult]);
  assert.equal(result.firstKeptEntryId, editCall.id);
  assert.deepEqual(result.readFiles, ["/work/project/src/parse.ts"]);
  assert.deepEqual(result.modifiedFiles, ["/work/project/src/old.ts"]);
});

test("fileDetails separates read from modified paths and drops reads of modified files", () => {
  const entries: SessionEntry[][] = [
    [
      assistantToolCallEntry("read", { path: "/work/project/src/b.ts" }),
      assistantToolCallEntry("read", { path: "/work/project/src/a.ts" }),
      assistantToolCallEntry("write", { path: "/work/project/src/c.ts" }),
      assistantToolCallEntry("apply_patch", { path: "/work/project/src/d.ts" }),
      assistantToolCallEntry("edit", { path: "/work/project/src/b.ts" }),
      assistantTextEntry("no tool calls here"),
      assistantToolCallEntry("grep", { path: "/work/project/src/e.ts" }),
      assistantToolCallEntry("read", {}),
    ],
  ];

  const details = fileDetails(...entries);
  assert.deepEqual(details.readFiles, ["/work/project/src/a.ts"]);
  assert.deepEqual(details.modifiedFiles, [
    "/work/project/src/b.ts",
    "/work/project/src/c.ts",
    "/work/project/src/d.ts",
  ]);
});

test("returns undefined when there is nothing to summarize", () => {
  const single = userEntry("only entry");
  assert.equal(prepareSnapshot([single], 10), undefined);

  const first = userEntry("first");
  const second = userEntry("second");
  assert.equal(prepareSnapshot([first, second], 1_000_000), undefined);
});

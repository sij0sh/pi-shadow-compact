import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NORMALIZED_PACKET_MAX_CHARS } from "../src/constants.js";
import { normalizeSnapshot } from "../src/normalize.js";
import type { SessionSnapshot } from "../src/types.js";

const cwd = "/work/project";
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

function snapshot(sourceEntries: SessionEntry[], previousSummary?: string): SessionSnapshot {
  return {
    sessionId: "session",
    leafId: sourceEntries.at(-1)?.id ?? "leaf",
    firstKeptEntryId: sourceEntries[0]?.id ?? "leaf",
    cwd,
    branch: sourceEntries,
    sourceEntries,
    source: "branchEntries",
    ...(previousSummary === undefined ? {} : { previousSummary }),
  };
}

test("normalizes conversational and tool evidence without thinking or metadata", () => {
  sequence = 0;
  const entries = [
    entry({
      type: "message",
      message: { role: "user", content: "Inspect /work/project/src/a.ts", timestamp: 1 },
    }),
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "I will inspect it." },
          {
            type: "toolCall",
            id: "call-1",
            name: "edit",
            arguments: {
              token: "top-secret-value",
              path: "/work/project/src/a.ts",
              edits: [{ oldText: "old", newText: "new" }],
            },
          },
        ],
        timestamp: 2,
      },
    }),
    entry({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit",
        content: [{ type: "text", text: "Edited /work/project/src/a.ts password=hunter2" }],
        details: { diff: "-old\n+new" },
        isError: false,
        timestamp: 3,
      },
    }),
    entry({
      type: "message",
      message: {
        role: "bashExecution",
        command: "pwd",
        output: "/work/project\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 4,
      },
    }),
    entry({
      type: "message",
      message: {
        role: "bashExecution",
        command: "secret command",
        output: "secret output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 5,
      },
    }),
    entry({ type: "custom_message", customType: "note", content: "Remember this", display: false }),
    entry({ type: "branch_summary", fromId: "old", summary: "Tried another route" }),
    entry({ type: "compaction", summary: "must be omitted", firstKeptEntryId: "x", tokensBefore: 1 }),
    entry({ type: "custom", customType: "state", data: { secret: "must be omitted" } }),
    entry({ type: "custom_message", customType: "internal", content: "[shadow-compact:probe:abc]", display: false }),
  ];

  const packet = normalizeSnapshot(snapshot(entries));
  assert.deepEqual(packet.evidence.map((item) => item.kind), [
    "user",
    "assistant",
    "tool_call",
    "tool_result",
    "bash",
    "custom_message",
    "branch_summary",
  ]);
  assert.deepEqual(packet.evidence.map((item) => item.evidenceId), [
    "E0001", "E0002", "E0003", "E0004", "E0005", "E0006", "E0007",
  ]);

  const text = packet.evidence.map((item) => item.text).join("\n");
  assert.match(text, /\.\/src\/a\.ts/);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /diff:\n-old\n\+new/);
  assert.doesNotMatch(text, /private reasoning|hunter2|secret command|must be omitted|shadow-compact/);
  assert.equal(packet.digest, createHash("sha256").update(JSON.stringify(packet.evidence)).digest("hex"));
  assert.equal(packet.digest.length, 64);
  assert.equal(packet.truncated, false);
  assert.equal(packet.usedPreviousCheckpointFallback, false);
});

test("bounds individual output deterministically and marks truncation", () => {
  sequence = 0;
  const large = `${"start".repeat(6_000)}TAIL_SENTINEL`;
  const result = entry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: large }],
      isError: false,
      timestamp: 1,
    },
  });

  const first = normalizeSnapshot(snapshot([result]));
  const second = normalizeSnapshot(snapshot([result]));
  assert.deepEqual(first, second);
  assert.equal(first.truncated, true);
  assert.match(first.evidence[0]?.text ?? "", /truncated \d+ chars/);
  assert.match(first.evidence[0]?.text ?? "", /TAIL_SENTINEL$/);
  assert.ok((first.evidence[0]?.text.length ?? Infinity) < large.length);
});

test("keeps one contiguous newest suffix when a middle record does not fit", () => {
  sequence = 0;
  const entries = [
    entry({ type: "message", message: { role: "user", content: "old-small", timestamp: 1 } }),
    entry({ type: "message", message: { role: "user", content: `middle:${"x".repeat(3_000)}`, timestamp: 2 } }),
    entry({ type: "message", message: { role: "user", content: "new-small", timestamp: 3 } }),
  ];

  const packet = normalizeSnapshot(snapshot(entries, "Earlier checkpoint"), 1_000);
  const text = packet.evidence.map((item) => item.text).join("\n");
  assert.match(text, /Earlier checkpoint/);
  assert.match(text, /new-small/);
  assert.doesNotMatch(text, /middle:|old-small/);
});

test("caps oversized packets using the checkpoint and newest evidence", () => {
  sequence = 0;
  const entries = Array.from({ length: 8 }, (_, index) =>
    entry({
      type: "message",
      message: { role: "user", content: `message-${index}:${String(index).repeat(39_000)}`, timestamp: index },
    }),
  );

  const packet = normalizeSnapshot(snapshot(entries, "Earlier verified checkpoint"));
  assert.equal(packet.truncated, true);
  assert.equal(packet.usedPreviousCheckpointFallback, true);
  assert.equal(packet.evidence[0]?.kind, "previous_checkpoint");
  assert.match(packet.evidence.at(-1)?.text ?? "", /^message-7:/);
  assert.ok(JSON.stringify(packet.evidence).length <= NORMALIZED_PACKET_MAX_CHARS);
  assert.ok(packet.evidence.length < entries.length + 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NORMALIZED_PACKET_MAX_CHARS, normalizeSnapshot } from "../src/normalize.js";

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

test("normalizes conversation, tool, bash, custom message, and branch evidence", () => {
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
  ];

  const packet = normalizeSnapshot({ cwd, entries });
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

  assert.equal(packet.evidence[0]?.text, "Inspect ./src/a.ts");
  assert.equal(packet.evidence[1]?.text, "I will inspect it.");
  assert.equal(
    packet.evidence[2]?.text,
    `tool: edit\nargs: {"edits":[{"newText":"new","oldText":"old"}],"path":"./src/a.ts","token":"[REDACTED]"}`,
  );
  assert.equal(
    packet.evidence[3]?.text,
    "tool: edit\nstatus: ok\noutput:\nEdited ./src/a.ts password=[REDACTED]\ndiff:\n-old\n+new",
  );
  assert.equal(packet.evidence[4]?.text, "command: pwd\nexit: 0\noutput:\n.\n");
  assert.equal(packet.evidence[5]?.text, "Remember this");
  assert.equal(packet.evidence[6]?.text, "Tried another route");

  const text = packet.evidence.map((item) => item.text).join("\n");
  assert.doesNotMatch(text, /private reasoning|hunter2|secret command|must be omitted/);
});

test("redacts bearer tokens, JWTs, API keys, env-var secrets, and URL credentials", () => {
  sequence = 0;
  const content = [
    "Authorization: Bearer live-token-abc123",
    "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "key sk-abcdefghij0123456789",
    "MY_API_KEY=supersecretvalue",
    "password=hunter2",
    "login at https://admin:p4ssw0rd@example.com/api",
  ].join("\n");
  const entries = [
    entry({ type: "message", message: { role: "user", content, timestamp: 1 } }),
  ];

  const packet = normalizeSnapshot({ cwd, entries });
  const text = packet.evidence[0]?.text ?? "";
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.match(text, /\[REDACTED JWT\]/);
  assert.match(text, /key \[REDACTED\]/);
  assert.match(text, /MY_API_KEY=\[REDACTED\]/);
  assert.match(text, /password=\[REDACTED\]/);
  assert.match(text, /https:\/\/\[REDACTED\]@example\.com\/api/);
  assert.doesNotMatch(text, /live-token|eyJhbGci|sk-abcdefghij|supersecretvalue|hunter2|admin:p4ssw0rd/);
});

test("promotes previous summary to the first previous_checkpoint evidence", () => {
  sequence = 0;
  const entries = [
    entry({ type: "message", message: { role: "user", content: "current ask", timestamp: 1 } }),
  ];

  const packet = normalizeSnapshot({ cwd, previousSummary: "Earlier checkpoint", entries });
  assert.equal(packet.evidence[0]?.kind, "previous_checkpoint");
  assert.equal(packet.evidence[0]?.sourceEntryId, "checkpoint");
  assert.equal(packet.evidence[0]?.text, "Earlier checkpoint");
  assert.equal(packet.evidence[1]?.kind, "user");
  assert.deepEqual(
    packet.evidence.map((item) => item.evidenceId),
    ["E0001", "E0002"],
  );

  const without = normalizeSnapshot({ cwd, entries });
  assert.ok(without.evidence.every((item) => item.kind !== "previous_checkpoint"));
});

test("truncates oversized items deterministically with a head and tail sentinel", () => {
  sequence = 0;
  const large = `HEAD_MARKER${"x".repeat(45_000)}TAIL_SENTINEL`;
  const result = entry({
    type: "message",
    message: { role: "user", content: large, timestamp: 1 },
  });

  const first = normalizeSnapshot({ cwd, entries: [result] });
  const second = normalizeSnapshot({ cwd, entries: [result] });
  assert.deepEqual(first, second);
  const text = first.evidence[0]?.text ?? "";
  assert.ok(text.startsWith("HEAD_MARKER"));
  assert.ok(text.endsWith("TAIL_SENTINEL"));
  assert.match(text, /\n\.\.\.\[truncated \d+ chars\]\.\.\.\n/);
  assert.ok(text.length < large.length);
});

test("caps packets by dropping oldest evidence and keeping the newest", () => {
  sequence = 0;
  const entries = Array.from({ length: 8 }, (_, index) =>
    entry({
      type: "message",
      message: { role: "user", content: `message-${index}:${String(index).repeat(39_000)}`, timestamp: index },
    }),
  );

  const packet = normalizeSnapshot({ cwd, previousSummary: "Earlier verified checkpoint", entries });
  const text = packet.evidence.map((item) => item.text).join("\n");
  assert.ok(JSON.stringify({ evidence: packet.evidence }).length <= NORMALIZED_PACKET_MAX_CHARS);
  assert.equal(packet.evidence[0]?.kind, "previous_checkpoint");
  assert.equal(packet.evidence[0]?.text, "Earlier verified checkpoint");
  assert.match(packet.evidence.at(-1)?.text ?? "", /^message-7:/);
  assert.doesNotMatch(text, /message-0:/);
  assert.ok(packet.evidence.length < entries.length + 1);
});

test("keeps the previous_checkpoint when trimming evicts transcript evidence", () => {
  sequence = 0;
  const checkpoint = `prior context ${"c".repeat(39_500)}`;
  const entries = [
    entry({
      type: "message",
      message: { role: "user", content: `old:${"x".repeat(39_500)}`, timestamp: 1 },
    }),
    entry({
      type: "message",
      message: { role: "user", content: `new:${"y".repeat(39_500)}`, timestamp: 2 },
    }),
  ];

  const packet = normalizeSnapshot({ cwd, previousSummary: checkpoint, entries }, 100_000);
  assert.equal(packet.evidence[0]?.kind, "previous_checkpoint");
  assert.equal(packet.evidence[0]?.evidenceId, "E0001");
  assert.ok(packet.evidence[0]?.text.startsWith("prior context "));
  assert.ok(packet.evidence.length < entries.length + 1, "transcript evidence was trimmed");
  assert.match(packet.evidence.at(-1)?.text ?? "", /^new:/);
  assert.ok(packet.evidence.every((item) => !item.text.startsWith("old:")));
});

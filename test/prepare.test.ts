import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fileDetails, hasCompactableHistory } from "../src/prepare.js";

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

function chain(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
}

test("compactability excludes previous summaries, prompt state, and omitted history", () => {
  const user = entry({ type: "message", message: { role: "user", content: "recent detail ".repeat(10), timestamp: 0 } });
  const assistant = assistantTextEntry("hello");
  const summary = entry({ type: "compaction", summary: "previous summary ".repeat(5000), firstKeptEntryId: user.id, tokensBefore: 100000 });
  const prompt = entry({ type: "message", message: { role: "system", content: [{ type: "text", text: "large prompt ".repeat(10000) }] } });
  const metadata = entry({ type: "custom", customType: "checkpoint", data: {} });
  assert.equal(hasCompactableHistory(chain([prompt, user, assistant]), 20000), false);
  assert.equal(hasCompactableHistory(chain([user, assistant, summary, metadata]), 20000), false);
  const old = assistantTextEntry("discardable detail ".repeat(1000));
  assert.equal(hasCompactableHistory(chain([old, user, assistant]), 20), true);
  const omit = entry({ type: "context_edit", targetId: old.id, replacement: null });
  assert.equal(hasCompactableHistory(chain([old, user, assistant, omit]), 20), false);
  assert.equal(hasCompactableHistory(chain([old, user, assistant, summary]), 20), false, "already compacted leaf");
});

test("compactability keeps tool results with their preceding assistant call", () => {
  const user = entry({ type: "message", message: { role: "user", content: "task", timestamp: 0 } });
  const call = assistantToolCallEntry("read", { path: "file" });
  const result = entry({ type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result ".repeat(1000) }], isError: false, timestamp: 0 } });
  assert.equal(hasCompactableHistory(chain([user, call, result]), 30), true, "user prefix can be summarized separately");
  assert.equal(hasCompactableHistory(chain([call, result]), 30), false, "a tool result alone cannot create a disposable prefix");
});

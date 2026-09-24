import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fileDetails } from "../src/prepare.js";

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

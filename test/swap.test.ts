import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextSwapDropCount, hasOrphanedToolResult } from "../src/swap.js";
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
    systemMessage: { role: "system", content: "", timestamp: 0 },
  } as unknown as SessionEntry;
}

function systemEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "system", content: "", timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantToolCallEntry(id: string, parentId: string, callId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }],
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(id: string, parentId: string, callId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function contextEditEntry(id: string, parentId: string, targetId: string): SessionEntry {
  return {
    type: "context_edit",
    id,
    parentId,
    timestamp: TIMESTAMP,
    targetId,
    replacement: null,
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
    assert.equal(contextSwapDropCount(branch, "e4"), 3);
    assert.equal(contextSwapDropCount(branch, "e1"), 0);
  });

  it("counts the previous compaction entry as the old summary message", () => {
    // Context after c1: [c1 summary, e1, e2, e3, e4].
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      compaction("c1", "e2", "e1"),
      userEntry("e3", "c1", "three"),
      userEntry("e4", "e3", "four"),
    ];
    // A cut at e3 drops the summary plus e1 and e2; only e3 and e4 stay.
    assert.equal(contextSwapDropCount(branch, "e3"), 3);
    // A cut at e4 keeps only e4; the summary replaces everything else.
    assert.equal(contextSwapDropCount(branch, "e4"), 4);
  });

  it("drops the stale tail from the previous kept boundary to the new cut", () => {
    // Context after c1: [c1 summary, e3, e4, e5, e6].
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      userEntry("e3", "e2", "three"),
      userEntry("e4", "e3", "four"),
      compaction("c1", "e4", "e3"),
      userEntry("e5", "c1", "five"),
      userEntry("e6", "e5", "six"),
    ];
    // A cut at e6 drops the summary plus e3, e4, and e5.
    assert.equal(contextSwapDropCount(branch, "e6"), 4);
    // A cut between the previous kept boundary and the compaction entry drops
    // the summary plus the stale entries in between.
    assert.equal(contextSwapDropCount(branch, "e4"), 2);
    // A cut at the previous kept boundary only replaces the summary.
    assert.equal(contextSwapDropCount(branch, "e3"), 1);
  });

  it("returns undefined for cuts off the branch or before the previous boundary", () => {
    const branch = [userEntry("e1", null, "one"), userEntry("e2", "e1", "two")];
    assert.equal(contextSwapDropCount(branch, "missing"), undefined);

    const withCompaction = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      compaction("c1", "e2", "gone"),
      userEntry("e3", "c1", "three"),
    ];
    // Fallback when the previous kept entry is gone: only the summary is replaced.
    assert.equal(contextSwapDropCount(withCompaction, "e3"), 1);
    // A cut before the previous boundary cannot swap.
    assert.equal(contextSwapDropCount(withCompaction, "e2"), undefined);
  });

  it("skips system entries invisible to context handlers since Pi 0.87", () => {
    // Regression shape for the 0.87 session kill: three system entries (prompt
    // plus tool add/remove deltas) sit inside the drop range. The 0.87 context
    // event excludes them, so counting them drops three extra conversation
    // messages and orphans the call-2 tool result from its tool call.
    const branch = [
      systemEntry("sys0", null),
      userEntry("e1", "sys0", "one"),
      assistantToolCallEntry("a1", "e1", "call-1"),
      toolResultEntry("r1", "a1", "call-1"),
      systemEntry("sys1", "r1"),
      userEntry("e2", "sys1", "two"),
      systemEntry("sys2", "e2"),
      assistantToolCallEntry("a2", "sys2", "call-2"),
      toolResultEntry("r2", "a2", "call-2"),
      userEntry("e3", "r2", "three"),
    ];
    // Visible messages before the cut: e1, a1, r1, e2. The kept head is the
    // a2 tool call, so the call-2 pair stays intact.
    assert.equal(contextSwapDropCount(branch, "a2"), 4);
  });

  it("omits entries removed by a null context edit", () => {
    const branch = [
      userEntry("e1", null, "one"),
      userEntry("e2", "e1", "two"),
      contextEditEntry("t1", "e2", "e1"),
      userEntry("e3", "t1", "three"),
      userEntry("e4", "e3", "four"),
    ];
    // e1 projects to no message, so only e2 precedes the cut.
    assert.equal(contextSwapDropCount(branch, "e3"), 1);
    // A cut at an omitted entry has no message to keep: no swap.
    assert.equal(contextSwapDropCount(branch, "e1"), undefined);
  });
});

describe("hasOrphanedToolResult", () => {
  function messages(value: unknown): ContextEvent["messages"] {
    return value as ContextEvent["messages"];
  }

  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
  });
  const result = (toolCallId: string) => ({
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  const text = { role: "user", content: "hello" };

  it("accepts intact pairs and tails without tool traffic", () => {
    assert.equal(hasOrphanedToolResult(messages([text])), false);
    assert.equal(hasOrphanedToolResult(messages([call("call-1"), result("call-1")])), false);
    assert.equal(
      hasOrphanedToolResult(messages([call("call-1"), result("call-1"), call("call-2"), text])),
      false,
    );
  });

  it("rejects a kept tool result without its tool call", () => {
    // The 0.87 over-drop shape: the call fell off the kept head.
    assert.equal(hasOrphanedToolResult(messages([result("call-1"), text])), true);
    // A result for an unknown call is orphaned even beside other pairs.
    assert.equal(
      hasOrphanedToolResult(messages([call("call-1"), result("call-1"), result("call-2")])),
      true,
    );
  });
});

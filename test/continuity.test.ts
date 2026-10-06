import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildWorkingContext, isWorkingContextSkipped, planSwap } from "../src/working-context.js";
import { hasOrphanedToolResult } from "../src/swap.js";
import { USAGE, userEntry } from "./helpers/index-fixture.js";

function toolRounds(count: number): SessionEntry[] {
  const branch = [userEntry("u1", null, "a long coding task")];
  for (let round = 1; round <= count; round++) {
    branch.push({
      type: "message",
      id: `a${round}`,
      parentId: branch.at(-1)!.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: ["x", "y"].map((tool) => ({ type: "toolCall", id: `${tool}${round}`, name: "read", arguments: { path: tool } })),
        api: "test", provider: "test", model: "test", usage: USAGE, stopReason: "toolUse", timestamp: 0,
      },
    });
    for (const tool of ["x", "y"]) {
      branch.push({
        type: "message",
        id: `${tool}${round}`,
        parentId: branch.at(-1)!.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "toolResult", toolCallId: `${tool}${round}`, toolName: "read",
          content: [{ type: "text", text: "large tool output ".repeat(100) }], isError: false, timestamp: 0,
        },
      });
    }
  }
  return branch;
}

function context(branch: SessionEntry[], coverageEndEntryId: string, minimumRecentTurns = 10) {
  return buildWorkingContext({
    checkpoint: {
      summary: "verified checkpoint",
      coverage: { sourceStartEntryId: null, coverageEndEntryId, preparedAtLeafId: coverageEndEntryId, publishedAtLeafId: coverageEndEntryId },
    },
    branch,
    messages: buildSessionProjection(branch).messages.filter((message) => message.role !== "system"),
    minimumRecentTurns,
  });
}

describe("Pi turn continuity", () => {
  it("retains ten assistant/tool rounds, not an entire long user-message span", () => {
    const branch = toolRounds(15);
    const result = context(branch, "y15");
    assert.ok(!isWorkingContextSkipped(result), "a single user prompt must not pin every model round in context");
    assert.equal(result.plan.swapStartEntryId, "a6");
    assert.equal(result.messages.length, 31, "checkpoint plus ten complete parallel-tool rounds");
    assert.equal(result.droppedMessages, 16);
    assert.equal(hasOrphanedToolResult(result.messages), false);
  });

  it("preserves the whole round containing uncovered tool results", () => {
    const branch = toolRounds(5);
    const result = context(branch, "a2", 1);
    assert.ok(!isWorkingContextSkipped(result));
    assert.equal(result.plan.swapStartEntryId, "a2", "coverage of the call does not cover its subsequent tool outputs");
    assert.equal(result.messages.length, 13);
    assert.equal(hasOrphanedToolResult(result.messages), false);
  });

  it("preserves a partly covered user-message span instead of dropping its remaining reply", () => {
    const branch = [
      userEntry("u1", null, "first task"),
      userEntry("u2", "u1", "second task"),
      { ...toolRounds(1)[1]!, id: "a2", parentId: "u2" },
      { ...toolRounds(1)[2]!, id: "x2", parentId: "a2" },
      { ...toolRounds(1)[3]!, id: "y2", parentId: "x2" },
      userEntry("u3", "y2", "third task"),
    ];
    assert.equal(planSwap(branch, "u2", 1)?.swapStartEntryId, "u2", "the uncovered reply must remain verbatim");
  });

  it("does not count recovery-omitted rounds toward the recent-turn minimum", () => {
    const branch = toolRounds(15);
    for (const targetId of ["a14", "x14", "y14"]) {
      branch.push({
        type: "context_edit", id: `omit-${targetId}`, parentId: branch.at(-1)!.id,
        timestamp: "2026-01-01T00:00:00.000Z", targetId, replacement: null,
      });
    }
    const result = context(branch, branch.at(-1)!.id);
    assert.ok(!isWorkingContextSkipped(result));
    assert.equal(result.plan.swapStartEntryId, "a5");
    assert.equal(result.messages.length, 31);
    assert.equal(hasOrphanedToolResult(result.messages), false);
  });
});

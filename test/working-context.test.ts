import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CheckpointCoverage } from "../src/checkpoint.js";
import {
  buildWorkingContext,
  isWorkingContextSkipped,
  planSwap,
  type WorkingContextResult,
  type WorkingContextSkipped,
} from "../src/working-context.js";
import { userEntry } from "./helpers/index-fixture.js";

function assertBuilt(
  result: WorkingContextResult | WorkingContextSkipped,
): asserts result is WorkingContextResult {
  assert.ok(!isWorkingContextSkipped(result), `expected a built context, got ${JSON.stringify(result)}`);
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function coverage(coverageEndEntryId: string): CheckpointCoverage {
  return {
    sourceStartEntryId: null,
    coverageEndEntryId,
    preparedAtLeafId: "prepared",
    publishedAtLeafId: "published",
  };
}

/** N single-message user turns: entry e<i> projects to exactly message i. */
function userBranch(count: number): SessionEntry[] {
  const branch: SessionEntry[] = [];
  for (let i = 1; i <= count; i++) {
    branch.push(userEntry(`e${i}`, i === 1 ? null : `e${i - 1}`, `user turn number ${i} with enough words`));
  }
  return branch;
}

function userMessages(count: number): ContextEvent["messages"] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: `user turn number ${i + 1} with enough words`,
    timestamp: 0,
  })) as unknown as ContextEvent["messages"];
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 },
  } as unknown as SessionEntry;
}

describe("planSwap", () => {
  it("retains the coverage tail when the checkpoint is old", () => {
    const plan = planSwap(userBranch(20), "e5", 10);
    assert.equal(plan!.coverageTailStart, "e6");
    assert.equal(plan!.recentTailStart, "e11");
    assert.equal(plan!.swapStartEntryId, "e6");
  });

  it("retains the recent-turns minimum when the checkpoint is fresh", () => {
    const plan = planSwap(userBranch(20), "e18", 10);
    assert.equal(plan!.coverageTailStart, "e19");
    assert.equal(plan!.recentTailStart, "e11");
    assert.equal(plan!.swapStartEntryId, "e11");
  });

  it("keeps the partly uncovered turn at mid-turn coverage", () => {
    const branch = [
      userEntry("u1", null, "first user task with enough words here"),
      assistantEntry("a1", "u1", "first assistant reply with enough words here"),
      userEntry("u2", "a1", "second user task with enough words here"),
      assistantEntry("a2", "u2", "second assistant reply with enough words"),
      userEntry("u3", "a2", "third user task with enough words here"),
      assistantEntry("a3", "u3", "third assistant reply with enough words"),
      userEntry("u4", "a3", "fourth user task with enough words here"),
      assistantEntry("a4", "u4", "fourth assistant reply with enough words"),
    ];
    // Coverage ends at the user input: turn 2 still has an uncovered reply.
    const plan = planSwap(branch, "u2", 1);
    assert.equal(plan!.coverageTailStart, "u2");
    assert.equal(plan!.recentTailStart, "u4");
    assert.equal(plan!.swapStartEntryId, "u2");
  });

  it("rejects unknown coverage anchors and treats empty coverage as nothing covered", () => {
    const branch = userBranch(4);
    assert.equal(planSwap(branch, "missing", 10), undefined);
    assert.equal(planSwap(branch, "", 10)!.swapStartEntryId, "e1");
    assert.equal(planSwap([], "e1", 10), undefined);
  });

  it("honors an explicit tail override above the recent-turns minimum", () => {
    const branch = userBranch(20);
    // v1 cut at e6 with a ten-turn minimum: the earlier entry wins.
    assert.equal(planSwap(branch, "e5", 10, "e6")!.swapStartEntryId, "e6");
    assert.equal(planSwap(branch, "e15", 10, "e16")!.swapStartEntryId, "e11");
    assert.equal(planSwap(branch, "e5", 10, "missing"), undefined);
  });
});

describe("buildWorkingContext", () => {
  it("keeps every turn after the coverage boundary with no gap", () => {
    // Summary triggered at turn 60, generation finished at turn 75, swap at
    // turn 80: turns 61-80 must all remain represented.
    const branch = userBranch(80);
    const result = buildWorkingContext({
      checkpoint: { summary: "# checkpoint", coverage: coverage("e60") },
      branch,
      messages: userMessages(80),
      minimumRecentTurns: 10,
    });
    assertBuilt(result);
    assert.equal(result.continuityStartEntryId, "e61");
    assert.equal(result.droppedMessages, 60);
    assert.equal(result.messages.length, 21);
    assert.equal(result.messages[0]!.role, "compactionSummary");
  });

  it("serves the checkpoint summary verbatim above the tail", () => {
    const branch = userBranch(20);
    const result = buildWorkingContext({
      checkpoint: { summary: "# checkpoint", coverage: coverage("e5") },
      branch,
      messages: userMessages(20),
      minimumRecentTurns: 10,
    });
    assertBuilt(result);
    // No injected sections: the summary message is the checkpoint rendering.
    assert.equal((result.messages[0] as { summary: string }).summary, "# checkpoint");
    assert.equal(result.continuityStartEntryId, "e6");
  });

  it("fails closed on orphaned tool results and stale coverage", () => {
    const branch = userBranch(4);
    const orphaned = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], timestamp: 0 },
    ] as unknown as ContextEvent["messages"];
    assert.deepEqual(
      buildWorkingContext({
        checkpoint: { summary: "# checkpoint", coverage: coverage("e1") },
        branch,
        messages: orphaned,
        minimumRecentTurns: 1,
      }),
      { skipped: "orphan", droppedMessages: 1 },
    );
    assert.deepEqual(
      buildWorkingContext({
        checkpoint: { summary: "# checkpoint", coverage: coverage("missing") },
        branch,
        messages: userMessages(4),
        minimumRecentTurns: 10,
      }),
      { skipped: "stale-coverage" },
    );
  });

  it("skips swaps that would drop nothing", () => {
    const branch = userBranch(4);
    assert.deepEqual(
      buildWorkingContext({
        checkpoint: { summary: "# checkpoint", coverage: coverage("") },
        branch,
        messages: userMessages(4),
        minimumRecentTurns: 10,
      }),
      { skipped: "no-drop" },
    );
  });
});

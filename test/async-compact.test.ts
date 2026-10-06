import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fixture, waitFor, tick, USAGE } from "./helpers/index-fixture.js";
import { buildWorkingContext, isWorkingContextSkipped, triggerOverlapStart } from "../src/working-context.js";
import { checkpointStalenessReason, type PersistedShadowCheckpoint } from "../src/persist.js";

const CONFIG = { recentTurns: 1, idleCompact: { enabled: false } };

function rounds(count: number): SessionEntry[] {
  const branch: SessionEntry[] = [];
  for (let i = 1; i <= count; i++) {
    const add = (id: string, message: object) => branch.push({
      type: "message", id, parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z", message,
    } as SessionEntry);
    add(`u${i}`, { role: "user", content: `round ${i} ${"history detail ".repeat(100)}`, timestamp: i });
    add(`a${i}`, {
      role: "assistant", content: [{ type: "toolCall", id: `call${i}`, name: "probe", arguments: {} }],
      api: "test", provider: "test", model: "test", usage: USAGE, stopReason: "toolUse", timestamp: i,
    });
    add(`r${i}`, { role: "toolResult", toolCallId: `call${i}`, toolName: "probe", content: [{ type: "text", text: `output ${i}` }], timestamp: i });
  }
  return branch;
}

function boundary(branch: SessionEntry[], entries: unknown[] = []) {
  const projection = buildSessionProjection(branch);
  return { entries, context: { contextEntries: projection.entries, contextMessages: projection.messages }, outcome: "completed" };
}

const ready = (notifications: string[]) => notifications.some((message) => message.includes("checkpoint ready"));

describe("nonblocking checkpoint preparation and frozen overlap", () => {
  it("pins round 55 at trigger 60, combines coverage and recency, and rejects missing anchors", () => {
    const branch = rounds(80);
    const anchor = triggerOverlapStart(branch.slice(0, 60 * 3));
    assert.equal(anchor, "u55");
    const build = (coverageEndEntryId: string, minimumRecentTurns = 5, retainedAnchor = anchor) => buildWorkingContext({
      branch, messages: buildSessionProjection(branch).messages,
      checkpoint: { summary: "verified", coverage: { sourceStartEntryId: null, coverageEndEntryId, preparedAtLeafId: "r60", publishedAtLeafId: "r75" } },
      minimumRecentTurns, retainedAnchor,
    });
    const result = build("r60");
    assert.ok(!isWorkingContextSkipped(result));
    assert.equal(result.continuityStartEntryId, "u55");
    assert.deepEqual(result.messages.slice(1), buildSessionProjection(branch.slice(54 * 3)).messages);
    const older = build("a50");
    assert.ok(!isWorkingContextSkipped(older));
    assert.equal(older.continuityStartEntryId, "u50", "partly covered round and result stay paired");
    const larger = build("r60", 30);
    assert.ok(!isWorkingContextSkipped(larger));
    assert.equal(larger.continuityStartEntryId, "u51");
    assert.deepEqual(build("r60", 5, "missing"), { skipped: "stale-coverage" });
  });

  it("counts completed projected rounds, preserving late parallel results and queued input", () => {
    const branch = rounds(12);
    // An omitted response/result does not count toward the five completed rounds.
    branch.push(
      { type: "context_edit", id: "omit-call", parentId: "r12", timestamp: "2026-01-01T00:00:00.000Z", targetId: "a10", replacement: null },
      { type: "context_edit", id: "omit-result", parentId: "omit-call", timestamp: "2026-01-01T00:00:00.000Z", targetId: "r10", replacement: null },
    );
    assert.equal(triggerOverlapStart(branch), "u6");
    const pending = rounds(12);
    const call = pending.find((entry) => entry.id === "a12")!;
    assert.ok(call.type === "message" && call.message.role === "assistant");
    call.message.content.push({ type: "toolCall", id: "parallel", name: "probe", arguments: {} });
    pending.push({ type: "message", id: "queued", parentId: "r12", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "queued input", timestamp: 1 } });
    const anchor = triggerOverlapStart(pending);
    assert.equal(anchor, "u7", "incomplete parallel round is not counted as completed");
    pending.push({ type: "message", id: "late", parentId: "queued", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", toolCallId: "parallel", toolName: "probe", content: [{ type: "text", text: "late output" }], isError: false, timestamp: 1 } });
    const result = buildWorkingContext({
      branch: pending, messages: buildSessionProjection(pending).messages, minimumRecentTurns: 1, retainedAnchor: anchor,
      checkpoint: { summary: "verified", coverage: { sourceStartEntryId: null, coverageEndEntryId: "a12", preparedAtLeafId: "r12", publishedAtLeafId: "late" } },
    });
    assert.ok(!isWorkingContextSkipped(result));
    assert.deepEqual(result.messages.slice(1), buildSessionProjection(pending.slice(18)).messages);
  });

  it("keeps builder/verifier snapshots fixed across 16 later rounds, duplicate commands, persistence, and reload", async () => {
    const f = await fixture(CONFIG);
    try {
      f.setBranch(rounds(20));
      f.gate();
      await f.command("shadow-compact", "Preserve exact migration identifiers");
      assert.equal(f.registry.calls, 1, "command returned with builder blocked");
      await f.command("shadow-compact", "Different instructions");
      assert.equal(f.registry.calls, 1);
      assert.match(f.notifications.at(-1)!, /existing attempt and instructions unchanged/);
      f.setBranch(rounds(28));
      // Gate builder submit, then verifier's first read independently.
      f.gate();
      f.release();
      await waitFor(() => f.registry.calls === 2);
      f.gate();
      f.release();
      await waitFor(() => f.registry.calls === 3);
      f.setBranch(rounds(36));
      f.release();
      await waitFor(() => ready(f.notifications));
      assert.ok(f.registry.prompts.every((prompt) => !prompt.includes("Different instructions")));
      assert.ok(f.registry.prompts.every((prompt) => prompt.includes("Preserve exact migration identifiers")));
      const swap = await f.emit("context", { messages: f.contextMessages() });
      assert.deepEqual(swap.messages.slice(1), buildSessionProjection(rounds(36).slice(14 * 3)).messages);
      assert.ok(!JSON.stringify(swap.messages).includes("Preserve exact migration identifiers"));
      await f.emit("agent_settled");
      const persisted = f.appendedEntries[0]!.data as PersistedShadowCheckpoint;
      assert.equal(persisted.firstKeptEntryId, "u15");
      assert.ok(persisted.version === 3);
      assert.equal(persisted.coverage.preparedAtLeafId, "r20");
      assert.equal(persisted.coverage.coverageEndEntryId, "r20");
      assert.equal(persisted.coverage.publishedAtLeafId, "r36");
      const editedBranch = [...f.branch, { type: "context_edit", id: "edited-covered", parentId: f.branch.at(-1)!.id,
        timestamp: "2026-01-01T00:00:00.000Z", targetId: "u1", replacement: { content: "changed" } } as SessionEntry];
      assert.equal(checkpointStalenessReason(editedBranch, "session-1", persisted), "changed-coverage");
      const g = f.restart();
      await g.emit("session_start");
      const restored = await g.emit("context", { messages: g.contextMessages() });
      assert.deepEqual(restored.messages.slice(1), swap.messages.slice(1));
      // Explicit refresh ignores threshold hysteresis, even after reload.
      g.setPercent(10);
      await g.command("shadow-compact", "refresh guidance");
      await waitFor(() => ready(g.notifications));
      assert.equal(g.registry.calls, 6, "36 turns need two read pages per agent");
    } finally {
      await f.cleanup();
    }
  });

  it("proposes canonical installation once, only clears after commit, and respects earlier drafts", async () => {
    const f = await fixture(CONFIG);
    try {
      f.setBranch(rounds(20));
      f.gate();
      await f.emit("turn_end", boundary(f.branch));
      assert.equal(f.registry.calls, 1);
      f.release();
      await waitFor(() => ready(f.notifications));
      f.setPercent(10);
      assert.equal(await f.emit("agent_before_settle", { ...boundary(f.branch), outcome: "aborted" }), undefined);
      const result = await f.emit("agent_before_settle", boundary(f.branch));
      assert.equal(result.entries[0].type, "compaction");
      assert.equal(result.entries[0].firstKeptEntryId, "u15");
      assert.ok(await f.emit("context", { messages: f.contextMessages() }), "proposal alone keeps checkpoint serving");
      assert.ok(!f.notifications.some((message) => message.includes("checkpoint installed")));
      const edit = { type: "context_edit", targetId: "u1", replacement: { content: "changed evidence" } };
      assert.equal(await f.emit("agent_before_settle", boundary(f.branch, [edit])), undefined);
      f.setBranch([...f.branch, { ...result.entries[0], id: "installed", parentId: "r20", timestamp: "2026-01-01T00:00:00.000Z", tokensBefore: 10000 }]);
      assert.equal(await f.emit("context", { messages: f.contextMessages() }), undefined);
      assert.ok(f.notifications.some((message) => message.includes("checkpoint installed")));
      assert.equal(await f.emit("agent_before_settle", boundary(f.branch)), undefined);
      assert.deepEqual(f.compactCalls, []);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps a previous checkpoint on replacement failure and rejects changed evidence", async () => {
    const f = await fixture(CONFIG);
    try {
      f.setBranch(rounds(20));
      await f.command("shadow-compact");
      await waitFor(() => ready(f.notifications));
      const before = await f.emit("context", { messages: f.contextMessages() });
      f.registry.mode = "verifier-error";
      await f.command("shadow-compact");
      await waitFor(() => f.notifications.some((message) => message.includes("Verification model")));
      const after = await f.emit("context", { messages: f.contextMessages() });
      assert.deepEqual(after.messages.slice(1), before.messages.slice(1));
      assert.equal(after.messages[0].summary, before.messages[0].summary);
      assert.deepEqual(f.compactCalls, []);
      f.setBranch([...f.branch, { type: "context_edit", id: "edit", parentId: "r20", timestamp: "2026-01-01T00:00:00.000Z", targetId: "u1", replacement: { content: "new meaning" } }]);
      assert.equal(await f.emit("context", { messages: f.contextMessages() }), undefined);
      await tick();
    } finally {
      await f.cleanup();
    }
  });
});

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionProjection, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fixtureWithHistory as fixture, tick, USAGE, userEntry, waitFor, type Fixture } from "./helpers/index-fixture.js";

const CONFIG = { recentTurns: 1, idleCompact: { enabled: false } };

async function prepare(f: Fixture): Promise<void> {
  await f.emit("turn_end");
  await waitFor(() => f.notifications.some((message) => message.includes("checkpoint ready")));
}

function conversation(branch: SessionEntry[]): ContextEvent["messages"] {
  return buildSessionProjection(branch).messages.filter((message) => message.role !== "system");
}

function appendResult(f: Fixture, compaction: Record<string, unknown>): ContextEvent["messages"] {
  f.setBranch([...f.branch, {
    type: "compaction",
    id: "compacted",
    parentId: f.branch.at(-1)!.id,
    timestamp: new Date().toISOString(),
    ...compaction,
  } as SessionEntry]);
  return conversation(f.branch);
}

function addLongFollowUp(f: Fixture): void {
  f.setBranch([
    ...f.branch,
    userEntry("e5", f.branch.at(-1)!.id, "new work ".repeat(1000)),
    userEntry("e6", "e5", "continue with the latest work"),
  ]);
}

describe("Pi compaction interoperability", () => {
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    it(`does not recommit the identical working context during ${reason} compaction`, async () => {
      const f = await fixture(CONFIG);
      try {
        await prepare(f);
        const before = await f.emit("context", { type: "context", messages: conversation(f.branch) });
        assert.ok(before?.messages, "checkpoint is already serving");
        const calls = f.registry.calls;
        const outcome = await f.emit("session_before_compact", f.compactEvent({ reason, firstKeptEntryId: "history-3" }));
        assert.equal(outcome, undefined, "Pi must summarize natively instead of committing the identical checkpoint and tail");
        assert.equal(f.registry.calls, calls, "do not rebuild a checkpoint that already covers Pi's cut");
      } finally {
        await f.cleanup();
      }
    });
  }

  it("serves Pi's cut, not an earlier ten-user-span cut", async () => {
    const f = await fixture({ ...CONFIG, recentTurns: 10 });
    try {
      f.setBranch(Array.from({ length: 14 }, (_, index) => userEntry(
        `u${index + 1}`,
        index === 0 ? null : `u${index}`,
        "large conversation turn ".repeat(200),
      )));
      f.setBranch(f.branch.flatMap((entry) => [entry, {
        type: "message", id: `reply-${entry.id}`, parentId: entry.id, timestamp: entry.timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "completed round" }], timestamp: 0 },
      } as SessionEntry]).map((entry, i, entries) => ({ ...entry, parentId: i === 0 ? null : entries[i - 1]!.id })));
      await prepare(f);
      const before = await f.emit("context", { type: "context", messages: conversation(f.branch) });
      const outcome = await f.emit("session_before_compact", f.compactEvent({ firstKeptEntryId: "u13" }));
      assert.equal(outcome?.compaction?.firstKeptEntryId, "u13", "Pi's retained-token budget owns real compaction");
      const after = appendResult(f, outcome.compaction);
      assert.ok(after.length < before.messages.length, "canonical context must shrink relative to the already served working context");
      assert.equal(after.length, 5);
      await f.emit("session_compact", { type: "session_compact", fromExtension: true });
      assert.equal(await f.emit("context", { type: "context", messages: after }), undefined);
    } finally {
      await f.cleanup();
    }
  });

  for (const reason of ["threshold", "overflow"] as const) {
    it(`falls back natively for ${reason} when the checkpoint cannot cover Pi's prefix`, async () => {
      const f = await fixture(CONFIG);
      try {
        await prepare(f);
        addLongFollowUp(f);
        const calls = f.registry.calls;
        const outcome = await f.emit("session_before_compact", f.compactEvent({ reason, firstKeptEntryId: "e6" }));
        assert.equal(outcome, undefined, "never discard uncovered post-checkpoint history");
        assert.equal(f.registry.calls, calls);
      } finally {
        await f.cleanup();
      }
    });
  }

  it("honors recovery cuts on invisible omission entries without discarding uncovered input", async () => {
    const f = await fixture({ ...CONFIG, recentTurns: 2 });
    try {
      await prepare(f);
      f.setBranch([...f.branch, {
        type: "message", id: "failed-attempt", parentId: "e4", timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: { ...USAGE, totalTokens: 0 }, stopReason: "error", timestamp: 0 },
      }, {
        type: "context_edit", id: "omit-attempt", parentId: "failed-attempt", timestamp: new Date().toISOString(),
        targetId: "failed-attempt", replacement: null,
      }]);
      const outcome = await f.emit("session_before_compact", f.compactEvent({ reason: "overflow", firstKeptEntryId: "omit-attempt" }));
      assert.equal(outcome?.compaction?.firstKeptEntryId, "omit-attempt");
      assert.deepEqual(appendResult(f, outcome.compaction).map((message) => message.role), ["compactionSummary"]);
    } finally {
      await f.cleanup();
    }
  });

  it("refreshes stale coverage for manual compaction and serves Pi's smaller tail", async () => {
    const f = await fixture(CONFIG);
    try {
      await prepare(f);
      addLongFollowUp(f);
      const before = await f.emit("context", { type: "context", messages: conversation(f.branch) });
      const calls = f.registry.calls;
      const outcome = await f.emit("session_before_compact", f.compactEvent({ reason: "manual", firstKeptEntryId: "e6" }));
      assert.equal(f.registry.calls, calls + 4, "manual compaction audits the newly disposable history");
      assert.equal(outcome?.compaction?.firstKeptEntryId, "e6");
      const after = appendResult(f, outcome.compaction);
      assert.ok(after.length < before.messages.length);
    } finally {
      await f.cleanup();
    }
  });

  it("bypasses the ready checkpoint for an emergency native fallback", async () => {
    const f = await fixture(CONFIG);
    try {
      await prepare(f);
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, [{}]);
      assert.equal(await f.emit("session_before_compact", f.compactEvent({ reason: "manual" })), undefined);
    } finally {
      await f.cleanup();
    }
  });

  it("rearms checkpoint preparation after an emergency native compaction fails with nothing serving", async () => {
    const f = await fixture(CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      f.setPercent(92);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      await f.emit("session_compact_failed", { type: "session_compact_failed", fromExtension: false });
      f.release();
      await tick();
      f.setPercent(60);
      await f.emit("turn_end");
      assert.ok(f.registry.calls > 1, "an aborted preparation must not leave the refresh gate latched after native failure");
      await waitFor(() => f.notifications.some((message) => message.includes("checkpoint ready")));
    } finally {
      await f.cleanup();
    }
  });

  it("includes the incomplete draft and both recovery agents in compaction usage", async () => {
    const f = await fixture(CONFIG);
    try {
      const stream = f.registry.streamSimple.bind(f.registry);
      let nativeCalls = 0;
      f.registry.streamSimple = (model, context, options) => {
        if (context.tools?.length) return stream(model, context, options);
        nativeCalls++;
        return { result: async () => ({ ...fauxAssistantMessage("partial draft", { stopReason: "length" }), usage: { ...USAGE, output: 11 } }) } as ReturnType<typeof stream>;
      };
      const event = f.compactEvent({ reason: "threshold" });
      event.preparation.messagesToSummarize = f.branch.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      event.preparation.settings.reserveTokens = 1000;
      const result = await f.emit("session_before_compact", event);
      assert.equal(nativeCalls, 1);
      assert.equal(f.registry.calls, 4);
      assert.equal(result.compaction.usage.output, 39, "11 draft output tokens plus four seven-token agent rounds");
      assert.equal(result.compaction.firstKeptEntryId, "e4");
      assert.match(result.compaction.summary, /Continuation Checkpoint/);
    } finally {
      await f.cleanup();
    }
  });

  it("cancels before native generation when projection fails, even if notification also fails", async () => {
    const f = await fixture(CONFIG);
    try {
      const event = f.compactEvent({ reason: "threshold" });
      event.preparation.messagesToSummarize = f.branch.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      const ctx = f.ctx;
      const getBranch = ctx.sessionManager.getBranch;
      ctx.sessionManager.getBranch = () => { throw new Error("projection failed"); };
      ctx.ui.notify = () => { throw new Error("notification failed"); };
      assert.deepEqual(await f.emit("session_before_compact", event), { cancel: true });
      assert.equal(f.registry.calls, 0, "no native fall-through after taking ownership");
      ctx.sessionManager.getBranch = getBranch;
    } finally {
      await f.cleanup();
    }
  });

  it("stands down quietly when the session is replaced during native draft recovery", async () => {
    const f = await fixture(CONFIG);
    try {
      const stream = f.registry.streamSimple.bind(f.registry);
      f.registry.streamSimple = (model, context, options) => context.tools?.length
        ? stream(model, context, options)
        : { result: async () => fauxAssistantMessage("partial", { stopReason: "length" }) } as ReturnType<typeof stream>;
      const event = f.compactEvent({ reason: "threshold" });
      event.preparation.messagesToSummarize = f.branch.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      event.preparation.settings.reserveTokens = 1000;
      f.gate();
      const attempt = f.emit("session_before_compact", event);
      await waitFor(() => f.registry.calls === 1);
      f.setStale();
      f.release();
      assert.deepEqual(await attempt, { cancel: true });
      assert.deepEqual(f.notifications, []);
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps a valid serving checkpoint when compaction fails", async () => {
    const f = await fixture(CONFIG);
    try {
      await prepare(f);
      const before = await f.emit("context", { type: "context", messages: conversation(f.branch) });
      await f.emit("session_compact_failed", { type: "session_compact_failed", fromExtension: true });
      const after = await f.emit("context", { type: "context", messages: conversation(f.branch) });
      assert.ok(after, "a failed compaction did not change the branch or invalidate the checkpoint");
      assert.equal(after.messages[0].summary, before.messages[0].summary);
    } finally {
      await f.cleanup();
    }
  });

  it("releases the native escape when compaction fails before its hook", async () => {
    const f = await fixture({ ...CONFIG, recentTurns: 2 });
    try {
      await prepare(f);
      await f.commands.get("compact-native")!.handler("", { ...f.ctx, compact: () => {} });
      await f.emit("session_compact_failed", { type: "session_compact_failed", fromExtension: false });
      const outcome = await f.emit("session_before_compact", f.compactEvent());
      assert.ok(outcome?.compaction, "a failed escape must not bypass the next compaction");
    } finally {
      await f.cleanup();
    }
  });
});

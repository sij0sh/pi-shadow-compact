import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRollingEnabled } from "../src/config.js";
import { TRACE_FILE_ENV_VAR } from "../src/trace.js";
import {
  fixture,
  waitFor,
  tick,
} from "./helpers/index-fixture.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

// A five-percent prepare threshold with a one-turn tail so swaps stay
// observable on the two-turn fixture branch.
const THRESHOLD_FIVE = {
  prepareThresholdPercent: 5,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
};

/** Model calls per successful preparation: builder read + submit, verifier read + verdict. */
const CALLS_PER_PREPARE = 4;

type TraceRecord = Record<string, unknown> & { event: string };

async function withTraceFile<T>(run: (path: string) => Promise<T>): Promise<{ result: T; events: TraceRecord[] }> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
  const path = join(dir, "trace.jsonl");
  const previous = process.env[TRACE_FILE_ENV_VAR];
  process.env[TRACE_FILE_ENV_VAR] = path;
  try {
    const result = await run(path);
    let events: TraceRecord[] = [];
    try {
      const text = await readFile(path, "utf8");
      events = text
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TraceRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { result, events };
  } finally {
    if (previous === undefined) delete process.env[TRACE_FILE_ENV_VAR];
    else process.env[TRACE_FILE_ENV_VAR] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function ofType(events: TraceRecord[], type: string): TraceRecord[] {
  return events.filter((event) => event.event === type);
}

/** Runs turn_end at the given percent while the run continues (stays non-idle). */
async function turn(f: Fixture, percent: number): Promise<void> {
  f.setPercent(percent);
  await f.emit("turn_end");
}

describe("isRollingEnabled", () => {
  it("defaults on and honors opt-outs", async () => {
    const previous = process.env.SHADOW_COMPACT_ROLLING;
    try {
      delete process.env.SHADOW_COMPACT_ROLLING;
      assert.equal(isRollingEnabled(), true);
      process.env.SHADOW_COMPACT_ROLLING = "";
      assert.equal(isRollingEnabled(), true);
      for (const off of ["0", "false", "FALSE", "no", "off", " 0 "]) {
        process.env.SHADOW_COMPACT_ROLLING = off;
        assert.equal(isRollingEnabled(), false, off);
      }
      for (const on of ["1", "true", "yes"]) {
        process.env.SHADOW_COMPACT_ROLLING = on;
        assert.equal(isRollingEnabled(), true, on);
      }
    } finally {
      if (previous === undefined) delete process.env.SHADOW_COMPACT_ROLLING;
      else process.env.SHADOW_COMPACT_ROLLING = previous;
    }
  });
});

describe("rolling two-refresh smoke (fix §9)", () => {
  it("publishes A, serves it while B prepares, replaces it, and persists B once", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture({ ...THRESHOLD_FIVE });
      try {
        // turn 1: 3% — below the prepare threshold, nothing happens.
        await turn(f, 3);
        await tick();
        assert.equal(f.registry.calls, 0);

        // turn 2: 5.2% — prepare A. turn 3: 6% while A builds — suppressed.
        f.gate();
        await turn(f, 5.2);
        assert.equal(f.registry.calls, 1);
        await turn(f, 6);
        assert.equal(f.registry.calls, 1);
        f.release();
        await waitFor(() => f.registry.settled === CALLS_PER_PREPARE);
        await tick();

        // Summary A ready: the next request swaps without aborting the run.
        const swapA = (await f.emit("context", { messages: f.contextMessages() })) as {
          messages: Array<Record<string, unknown>>;
        };
        assert.equal(swapA?.messages.length, 2);
        assert.equal(swapA.messages[0]?.role, "compactionSummary");
        assert.equal(f.compactCalls.length, 0);

        // turn 4: swapped context reads 2.8% — the gate re-arms.
        await turn(f, 2.8);
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);

        // turn 5: 4% — below the prepare threshold, nothing happens.
        await turn(f, 4);
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);

        // turn 6: 5.1% — prepare B while A keeps serving.
        f.gate();
        await turn(f, 5.1);
        assert.equal(f.registry.calls, CALLS_PER_PREPARE + 1);
        const swapWhilePreparing = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(swapWhilePreparing, "A keeps serving while B prepares");
        assert.equal(f.compactCalls.length, 0, "an active run must not be aborted");

        // turn 7: B publishes and swaps in.
        f.release();
        await waitFor(() => f.registry.settled === CALLS_PER_PREPARE + 4);
        await tick();
        assert.equal(f.registry.calls, CALLS_PER_PREPARE + 4);
        const swapB = await f.emit("context", { messages: f.contextMessages() });
        assert.ok(swapB, "B serves after publishing");

        // Final settle: exactly one durable persist, and it is the latest
        // checkpoint. No compaction runs on the soft path.
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0);
        assert.equal(f.appendedEntries.length, 1);
        await f.emit("agent_settled");
        assert.equal(f.appendedEntries.length, 1, "one durable persist at final settle");
      } finally {
        await f.cleanup();
      }
    });

    const started = ofType(events, "prepare_started");
    const completed = ofType(events, "prepare_completed");
    const published = ofType(events, "checkpoint_published");
    const swaps = ofType(events, "swap_applied");
    const rearms = ofType(events, "checkpoint_rearmed");
    const fallbacks = ofType(events, "native_fallback");
    assert.equal(started.length, 2, "2 prepare_started");
    assert.equal(completed.length, 2, "2 prepare_completed");
    assert.equal(published.length, 2, "2 checkpoint_published");
    assert.ok(
      started[0]?.generation !== started[1]?.generation,
      "each preparation attempt has a unique generation",
    );
    assert.equal(published[0]?.replaced, false, "first publish is not a replacement");
    assert.equal(published[1]?.replaced, true, "rolling publish replaces A");
    assert.equal(
      swaps.filter((event) => event.firstSwap === true).length,
      2,
      "2 first swap_applied",
    );
    assert.equal(rearms.length, 1, "1 checkpoint_rearmed");
    assert.equal(fallbacks.length, 0, "0 native fallback");

    // Ordering: A published, rearmed, B started while A served, B published, then persisted.
    const order = (type: string, index = 0) => events.findIndex((e, i) => e.event === type &&
      events.slice(0, i + 1).filter((x) => x.event === type).length === index + 1);
    assert.ok(order("checkpoint_published", 0) < order("checkpoint_rearmed", 0));
    assert.ok(order("checkpoint_rearmed", 0) < order("prepare_started", 1));
    assert.ok(order("prepare_started", 1) < order("checkpoint_published", 1));
    assert.ok(order("checkpoint_published", 1) < order("checkpoint_persisted", 0));
    assert.equal(ofType(events, "checkpoint_persisted").length, 1);

    // Every completed preparation carries its agent cost and evidence
    // boundary (no longer hidden).
    for (const event of completed) {
      assert.ok(typeof event.summaryInput === "number");
      assert.ok(typeof event.summaryOutput === "number");
      assert.ok(typeof event.summaryChars === "number");
      assert.ok(typeof event.summaryWallMs === "number");
      assert.ok(typeof event.builderRounds === "number");
      assert.ok(typeof event.verifierRounds === "number");
      assert.ok(typeof event.inspectedEntries === "number");
      assert.ok(typeof event.coverageEnd === "string");
    }
    // Every swap carries the pre/post message shape for swap-reduction analysis.
    for (const event of swaps) {
      assert.ok(typeof event.messagesBefore === "number");
      assert.ok(typeof event.messagesAfter === "number");
      assert.ok(typeof event.messagesDropped === "number");
      assert.ok(typeof event.checkpointTokens === "number");
      assert.ok(typeof event.continuityTokens === "number");
      assert.ok(typeof event.totalInjectedTokens === "number");
    }
  });

  it("a failed B keeps A serving with safe fallback behavior", async () => {
    const f = await fixture({ ...THRESHOLD_FIVE });
    const previous = process.env[TRACE_FILE_ENV_VAR];
    delete process.env[TRACE_FILE_ENV_VAR];
    try {
      await turn(f, 5.2);
      await waitFor(() => f.registry.settled === CALLS_PER_PREPARE);
      await tick();
      const swapA = await f.emit("context", { messages: f.contextMessages() });
      assert.ok(swapA, "A serves");

      await turn(f, 2.8);
      assert.equal(f.registry.calls, CALLS_PER_PREPARE);

      // B fails: A remains published and keeps serving; no fallback is queued.
      f.registry.mode = "error";
      f.gate();
      await turn(f, 5.1);
      assert.equal(f.registry.calls, CALLS_PER_PREPARE + 1);
      f.release();
      await waitFor(() => f.registry.settled === CALLS_PER_PREPARE + 1);
      await tick();
      f.registry.mode = "ok";
      assert.match(f.notifications.at(-1) ?? "", /Summary model stopped with error/);
      const stillServing = await f.emit("context", { messages: f.contextMessages() });
      assert.ok(stillServing, "A continues serving after B fails");
      assert.equal(f.compactCalls.length, 0);

      // The failure must not manufacture a threshold crossing: still above
      // the prepare threshold with no new swap + shrink, so the next crossing
      // is suppressed.
      await turn(f, 5.3);
      await tick();
      assert.equal(f.registry.calls, CALLS_PER_PREPARE + 1, "no immediate retry after a failed replacement");

      // Only an observed swap + shrink re-arms: below the threshold, then C prepares.
      await turn(f, 2.8);
      await turn(f, 5.4);
      await waitFor(() => f.registry.calls === CALLS_PER_PREPARE + 5);
      await waitFor(() => f.registry.settled === CALLS_PER_PREPARE + 5);
      await tick();
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 0);
      assert.equal(f.appendedEntries.length, 1);
    } finally {
      if (previous === undefined) delete process.env[TRACE_FILE_ENV_VAR];
      else process.env[TRACE_FILE_ENV_VAR] = previous;
      await f.cleanup();
    }
  });

  it("no re-arm while the swapped working set stays above the prepare threshold", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture({ ...THRESHOLD_FIVE });
      try {
        await turn(f, 5.2);
        await waitFor(() => f.registry.settled === CALLS_PER_PREPARE);
        await tick();
        assert.ok(await f.emit("context", { messages: f.contextMessages() }));

        // The swap did not bring context below the threshold: log, don't refresh.
        await turn(f, 5.5);
        await tick();
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);
        await turn(f, 5.6);
        await tick();
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);

        // Once the working set actually shrinks below the threshold, the gate re-opens.
        await turn(f, 2.8);
        await turn(f, 5.1);
        await waitFor(() => f.registry.calls >= CALLS_PER_PREPARE + 1);
      } finally {
        await f.cleanup();
      }
    });

    const crossings = ofType(events, "threshold_crossed");
    assert.ok(
      crossings.some((event) => event.action === "suppressed"),
      "suppressed crossings are logged",
    );
    assert.ok(crossings.some((event) => event.action === "started"));
    assert.equal(ofType(events, "checkpoint_rearmed").length, 1);
  });

  it("single-shot mode never refreshes while a checkpoint is published", async () => {
    const previous = process.env.SHADOW_COMPACT_ROLLING;
    process.env.SHADOW_COMPACT_ROLLING = "0";
    try {
      const f = await fixture({ ...THRESHOLD_FIVE });
      try {
        await turn(f, 5.2);
        await waitFor(() => f.registry.settled === CALLS_PER_PREPARE);
        await tick();
        assert.ok(await f.emit("context", { messages: f.contextMessages() }));

        // Below the threshold and back above: no refresh while A is published.
        await turn(f, 2.8);
        await turn(f, 5.1);
        await tick();
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);

        // The idle persist keeps A serving (no stand-down): still exactly one
        // checkpoint per run, and further crossings do not refresh.
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0);
        assert.equal(f.appendedEntries.length, 1);
        assert.ok(await f.emit("context", { messages: f.contextMessages() }));
        await turn(f, 2.8);
        await turn(f, 5.4);
        await tick();
        assert.equal(f.registry.calls, CALLS_PER_PREPARE);
        await f.emit("agent_settled");
        assert.equal(f.appendedEntries.length, 1);
      } finally {
        await f.cleanup();
      }
    } finally {
      if (previous === undefined) delete process.env.SHADOW_COMPACT_ROLLING;
      else process.env.SHADOW_COMPACT_ROLLING = previous;
    }
  });
});

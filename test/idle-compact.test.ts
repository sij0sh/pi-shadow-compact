import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TRACE_FILE_ENV_VAR } from "../src/trace.js";
import {
  fixtureWithHistory as fixture,
  userEntry,
  waitFor,
  type Fixture,
} from "./helpers/index-fixture.js";

const READY_MESSAGE = "shadow-compact: checkpoint ready; next safe request will use it";

const IDLE_CONFIG = {
  prepareThresholdPercent: 60,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
  idleCompact: { enabled: true, minimumTokens: 20_000 },
};

type TraceRecord = Record<string, unknown> & { event: string };

async function withTraceFile<T>(run: () => Promise<T>): Promise<{ result: T; events: TraceRecord[] }> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
  const path = join(dir, "trace.jsonl");
  const previous = process.env[TRACE_FILE_ENV_VAR];
  process.env[TRACE_FILE_ENV_VAR] = path;
  try {
    const result = await run();
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

async function startPreparation(fixture: Fixture): Promise<void> {
  await fixture.emit("turn_end");
  await waitFor(() => fixture.notifications.includes(READY_MESSAGE));
}

describe("idle compaction", () => {
  it("prepares a fresh checkpoint when the agent settles with enough context", async () => {
    const f = await fixture(IDLE_CONFIG);
    try {
      // Below the prepare threshold (12.5%) but above the idle minimum: the
      // threshold path stays quiet while the idle path prepares.
      f.setUsage(25_000, 200_000);
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 0);

      await f.emit("agent_settled");
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.equal(f.registry.calls, 4);

      // The idle checkpoint activates for the next context request.
      const swapped = await f.emit("context", { messages: f.contextMessages() });
      assert.ok(swapped, "idle checkpoint serves");
      assert.equal(f.compactCalls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("stays quiet below the idle minimum", async () => {
    const f = await fixture(IDLE_CONFIG);
    try {
      f.setUsage(19_999, 200_000);
      await f.emit("turn_end");
      await f.emit("agent_settled");
      assert.equal(f.registry.calls, 0);
      assert.deepEqual(f.notifications, []);
    } finally {
      await f.cleanup();
    }
  });

  it("does not regenerate an identical checkpoint when the leaf matches coverage", async () => {
    const f = await fixture(IDLE_CONFIG);
    try {
      f.setUsage(25_000, 200_000);
      await f.emit("agent_settled");
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      const callsAfterFirst = f.registry.calls;

      // Same leaf, settled again: fresh already, no new preparation.
      await f.emit("agent_settled");
      assert.equal(f.registry.calls, callsAfterFirst);
    } finally {
      await f.cleanup();
    }
  });

  it("refreshes when the leaf moved past coverage", async () => {
    const f = await fixture({ ...IDLE_CONFIG, idleCompact: { enabled: true, minimumTokens: 1 } });
    try {
      await startPreparation(f);
      await f.emit("context", { messages: f.contextMessages() });
      f.setPercent(30);
      await f.emit("turn_end");
      const callsAfterFirst = f.registry.calls;

      // New work lands after the coverage boundary: the next settle refreshes.
      f.setBranch([
        ...f.branch,
        userEntry("e5", "e4", "follow-up work after the checkpoint with enough words"),
      ]);
      await f.emit("agent_settled");
      await waitFor(() => f.registry.calls > callsAfterFirst);
    } finally {
      await f.cleanup();
    }
  });

  it("honors the idle opt-out and single-shot mode", async () => {
    const disabled = await fixture({
      ...IDLE_CONFIG,
      idleCompact: { enabled: false, minimumTokens: 1 },
    });
    try {
      disabled.setUsage(25_000, 200_000);
      await disabled.emit("agent_settled");
      assert.equal(disabled.registry.calls, 0);
    } finally {
      await disabled.cleanup();
    }

    const previous = process.env.SHADOW_COMPACT_ROLLING;
    process.env.SHADOW_COMPACT_ROLLING = "0";
    try {
      const single = await fixture({ ...IDLE_CONFIG, idleCompact: { enabled: true, minimumTokens: 1 } });
      try {
        await startPreparation(single);
        const calls = single.registry.calls;
        single.setBranch([
          ...single.branch,
          userEntry("e5", "e4", "follow-up work after the checkpoint with enough words"),
        ]);
        await single.emit("agent_settled");
        assert.equal(single.registry.calls, calls, "single-shot keeps one checkpoint per run");
      } finally {
        await single.cleanup();
      }
    } finally {
      if (previous === undefined) delete process.env.SHADOW_COMPACT_ROLLING;
      else process.env.SHADOW_COMPACT_ROLLING = previous;
    }
  });

  it("traces force-swap arming once per checkpoint", async () => {
    const { events } = await withTraceFile(async () => {
      const f = await fixture(IDLE_CONFIG);
      try {
        await startPreparation(f);
        f.setPercent(85);
        await f.emit("turn_end");
        await f.emit("turn_end");
        await f.emit("turn_end");
      } finally {
        await f.cleanup();
      }
    });
    const armed = events.filter(
      (event) => event.event === "threshold_crossed" && event.action === "force-swap",
    );
    assert.equal(armed.length, 1);
    assert.equal(armed[0]?.reason, "swap-threshold");
  });
});

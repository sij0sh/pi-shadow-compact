import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  SOFT_THRESHOLD_ABS_ENV_VAR,
  SUMMARIZER_ID_ENV_VAR,
  SUMMARIZER_PROVIDER_ENV_VAR,
} from "../src/config.js";
import { CHECKPOINT_CUSTOM_TYPE } from "../src/persist.js";
import {
  compactionEntry,
  fixture,
  fixtureWithHistory,
  tick,
  userEntry,
  waitFor,
  type Fixture,
} from "./helpers/index-fixture.js";

const READY_MESSAGE = "shadow-compact: checkpoint ready; next safe request will use it";
const MANUAL_PREPARE_MESSAGE = "shadow-compact: preparing a fresh checkpoint for /compact";

// Small snapshots exercise preparation. Serving tests add disposable history.
const SWAP_CONFIG = {
  prepareThresholdPercent: 60,
  summarizerModel: { provider: "", id: "" },
  recentTurns: 1,
};

let savedAgentDir: string | undefined;
let savedAbs: string | undefined;
let savedSummarizerProvider: string | undefined;
let savedSummarizerId: string | undefined;

beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  savedAbs = process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  savedSummarizerProvider = process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  savedSummarizerId = process.env[SUMMARIZER_ID_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  delete process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  delete process.env[SUMMARIZER_ID_ENV_VAR];
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedAbs === undefined) delete process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  else process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = savedAbs;
  if (savedSummarizerProvider === undefined) delete process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  else process.env[SUMMARIZER_PROVIDER_ENV_VAR] = savedSummarizerProvider;
  if (savedSummarizerId === undefined) delete process.env[SUMMARIZER_ID_ENV_VAR];
  else process.env[SUMMARIZER_ID_ENV_VAR] = savedSummarizerId;
});

async function startPreparation(fixture: Fixture): Promise<void> {
  await fixture.emit("turn_end");
  await waitFor(() => fixture.notifications.includes(READY_MESSAGE));
}

describe("shadowCompact extension orchestration", () => {
  it("bounds default prose and lowers private reasoning without imposing a generation cap", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      // Builder (read + submit) and verifier (read + verdict) run as agents;
      // every checkpoint model call carries tools.
      const agentCalls = f.registry.optionsList.filter((_, index) => f.registry.toolsUsed[index]);
      assert.equal(agentCalls.length, 4);
      assert.ok(agentCalls.every((options) => options?.maxTokens === undefined));
      assert.ok(agentCalls.every((options) => options?.reasoning === "low"));
      assert.match(f.registry.prompts[0]!, /within 16000 characters/);
    } finally {
      await f.cleanup();
    }
  });

  it("honors summaryMaxTokens and thinkingLevel overrides", async () => {
    const f = await fixture({
      ...SWAP_CONFIG,
      summaryMaxTokens: 32768,
      thinkingLevel: "high",
      summarizerModel: { provider: "configured", id: "summary-model" },
      verificationModel: { provider: "configured", id: "summary-model" },
    });
    try {
      await startPreparation(f);
      const agentCalls = f.registry.optionsList.filter((_, index) => f.registry.toolsUsed[index]);
      assert.equal(agentCalls.length, 4);
      assert.ok(agentCalls.every((options) => options?.maxTokens === 32768));
      assert.ok(
        agentCalls.every((options) => (options as { reasoning?: unknown }).reasoning === "high"),
      );
    } finally {
      await f.cleanup();
    }
  });

  it("derives the shared rendered target from the configured response allowance", async () => {
    const f = await fixture({ ...SWAP_CONFIG, summaryMaxTokens: 1000 });
    try {
      await startPreparation(f);
      assert.match(f.registry.prompts[0]!, /within 2000 characters/);
      assert.match(f.registry.prompts[2]!, /within 2000 characters/);
    } finally { await f.cleanup(); }
  });

  it("prompts the checkpoint agent with the session manifest and read-only tools", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      assert.match(f.registry.prompts[0]!, /Session manifest/);
      assert.match(f.registry.prompts[2]!, /Audit this draft/);
      assert.deepEqual(f.registry.toolsUsed, [true, true, true, true]);
    } finally {
      await f.cleanup();
    }
  });

  it("starts background preparation at the threshold and resolves turn_end before the model call completes", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      f.release();
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.equal(f.registry.calls, 4);
      assert.equal(f.registry.settled, 4);
    } finally {
      await f.cleanup();
    }
  });

  it("ignores duplicate turn_end while a preparation is already running", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      f.release();
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.equal(f.registry.calls, 4);
      assert.equal(f.registry.settled, 4);
    } finally {
      await f.cleanup();
    }
  });

  it("honors the benchmark-only absolute threshold override", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = "601";
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);

      // Env changes take effect at the next session start (config is memoized
      // within a session).
      process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = "600";
      await f.emit("session_start");
      await f.emit("turn_end");
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
      assert.equal(f.registry.calls, 4);
    } finally {
      await f.cleanup();
    }
  });

  it("persists a ready result as extension state and serves the matching before_compact from cache", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 1);
      const persisted = f.appendedEntries[0];
      assert.equal(persisted?.customType, CHECKPOINT_CUSTOM_TYPE);
      const data = persisted?.data as { version: number; summary: string };
      assert.equal(data.version, 3);
      assert.match(data.summary, /Prepared continuation checkpoint/);

      // A settled agent with no new work re-persists nothing: the same
      // checkpoint id is already durable.
      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 1);
    } finally {
      await f.cleanup();
    }
  });

  it("discards a ready result whose leaf is no longer on the branch", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      f.setBranch([userEntry("solo", null, "a divergent branch with enough words here")]);
      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("discards a ready result when a newer compaction landed on the branch", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      f.setBranch([...f.branch, compactionEntry("c1", "e4")]);
      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("declines cached compactions that would not reduce the working context", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      for (const firstKeptEntryId of ["e4", "e3", "nope"]) {
        const outcome = await f.emit("session_before_compact", f.compactEvent({ firstKeptEntryId }));
        assert.equal(outcome, undefined);
      }
      assert.deepEqual(f.compactCalls, []);
    } finally {
      await f.cleanup();
    }
  });

  it("uses native manual compaction when the ready checkpoint cannot shrink further", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      await startPreparation(f);
      const callsBefore = f.registry.calls;
      const outcome = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "manual", customInstructions: "[shadow-compact:commit:dead]" }),
      );
      assert.equal(outcome, undefined);
      assert.equal(f.registry.calls, callsBefore);
    } finally {
      await f.cleanup();
    }
  });

  it("prepares fresh for manual compaction when nothing is ready, then serves", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      // The checkpoint must be smaller than the context it replaces.
      f.setBranch([userEntry("e1", null, "old conversation detail ".repeat(1000)), ...f.branch.slice(1)]);
      const outcome = await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      assert.ok(outcome.compaction.summary.includes("Prepared continuation checkpoint"));
      assert.equal(outcome.compaction.firstKeptEntryId, "e4");
      assert.ok(f.notifications.includes(MANUAL_PREPARE_MESSAGE));
      assert.ok(f.registry.calls >= 4);
    } finally {
      await f.cleanup();
    }
  });

  it("aborts a manual fresh prepare when the hook signal fires", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      const controller = new AbortController();
      const manual = f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "manual", signal: controller.signal }),
      );
      await waitFor(() => f.registry.calls === 1);
      controller.abort();
      f.release();
      const outcome = await manual;
      assert.equal(outcome, undefined);
      assert.ok(!f.notifications.includes(READY_MESSAGE));
      assert.deepEqual(f.compactCalls, []);
      // The aborted preparation released instead of latching: a later turn
      // can still prepare fresh.
      await f.emit("turn_end");
      await waitFor(() => f.notifications.includes(READY_MESSAGE));
    } finally {
      await f.cleanup();
    }
  });

  it("manual compaction in native mode keeps the valid checkpoint until success", async () => {
    const f = await fixtureWithHistory({ ...SWAP_CONFIG, manualCompactMode: "native" });
    try {
      await startPreparation(f);
      const outcome = await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      assert.equal(outcome, undefined);
      const swapped = await f.emit("context", { messages: f.contextMessages() });
      assert.ok(swapped, "native failure must not preemptively discard a valid checkpoint");
    } finally {
      await f.cleanup();
    }
  });

  it("compact-native runs one native compaction bypassing Shadow", async () => {
    const f = await fixtureWithHistory({ ...SWAP_CONFIG, recentTurns: 2 });
    try {
      await startPreparation(f);
      const command = f.commands.get("compact-native");
      assert.ok(command, "compact-native command is registered");
      await command.handler("", {
        ...f.ctx,
        compact: (options: unknown) => void f.compactCalls.push(options as never),
      });
      const outcome = await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      assert.equal(outcome, undefined);
      // The escape is one-shot: the next manual serves Shadow again.
      const again = await f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      assert.ok(again.compaction.summary.includes("Prepared continuation checkpoint"));
    } finally {
      await f.cleanup();
    }
  });

  it("keeps a newer preparation alive when a superseded summary completes", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.setBranch([userEntry("e1", null, "old conversation detail ".repeat(1000)), ...f.branch.slice(1)]);
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      // A manual compaction aborts the in-flight preparation and awaits a
      // fresh one; the stale completion must no-op on its old generation.
      f.gate();
      const manual = f.emit("session_before_compact", f.compactEvent({ reason: "manual" }));
      await waitFor(() => f.registry.calls === 2);
      f.release();
      await tick();
      f.release();
      const outcome = await manual;
      assert.ok(outcome.compaction.summary.includes("Prepared continuation checkpoint"));
      assert.deepEqual(f.compactCalls, []);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);
    } finally {
      await f.cleanup();
    }
  });

  it("skips fallback when an intervening compaction leaves no disposable history", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.gate();
      await f.emit("turn_end");
      assert.equal(f.registry.calls, 1);
      f.setBranch([...f.branch, compactionEntry("c1", "e4")]);
      f.release();
      await waitFor(() => f.registry.settled >= 4);
      await tick();
      assert.deepEqual(f.compactCalls, []);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);
      await f.emit("agent_settled");
      assert.deepEqual(f.compactCalls, []);
    } finally {
      await f.cleanup();
    }
  });

  it("retries config loading after a failure and announces recovery", async () => {
    const f = await fixture();
    try {
      const configPath = join(f.agentDir, "shadow-compact.json");
      await writeFile(configPath, "{ not json");
      f.setPercent(61);
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.equal(f.notifications.length, 1);
      assert.match(f.notifications[0]!, /not valid JSON/);

      // The retry stays deduped to one toast while the file stays broken.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 0);
      assert.equal(f.notifications.length, 1);

      // A fixed file takes effect on the next turn without session_start.
      await writeFile(
        configPath,
        JSON.stringify({
          prepareThresholdPercent: 61,
          summarizerModel: { provider: "", id: "" },
          recentTurns: 1,
        }),
      );
      await f.emit("turn_end");
      await waitFor(() => f.registry.settled >= 4);
      await tick();
      assert.equal(f.registry.calls, 4);
      // Config error toast, recovery toast, then the ready announcement.
      assert.deepEqual(f.notifications, [
        `shadow-compact: ${join(f.agentDir, "shadow-compact.json")} is not valid JSON`,
        "shadow-compact: config recovered",
        READY_MESSAGE,
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("falls back to plain native compaction after a summary model error", async () => {
    const f = await fixture(SWAP_CONFIG);
    try {
      f.registry.mode = "error";
      await f.emit("turn_end");
      // A stopReason error is not retried; only checkpoint validation failures are.
      await waitFor(() => f.registry.settled >= 1);
      await tick();
      assert.equal(f.registry.calls, 1);
      assert.deepEqual(f.notifications, ["shadow-compact: Summary model (configured/summary-model) stopped with error: synthetic failure"]);
      assert.equal(f.compactCalls.length, 0);
      // A queued fallback owns the next idle point: no new preparation on top of it.
      await f.emit("turn_end");
      await tick();
      assert.equal(f.registry.calls, 1);
      await f.emit("agent_settled");
      assert.equal(f.compactCalls.length, 1);
      assert.deepEqual(f.compactCalls[0], {});
    } finally {
      await f.cleanup();
    }
  });

  it("publishes the verified checkpoint text, not the draft", async () => {
    const f = await fixtureWithHistory(SWAP_CONFIG);
    try {
      f.registry.mode = "verifier-rewrite";
      await startPreparation(f);
      await tick();

      const swapped = (await f.emit("context", { messages: f.contextMessages() })) as {
        messages: Array<{ summary?: unknown }>;
      };
      assert.match(String(swapped.messages[0]?.summary), /Verified continuation checkpoint/);
      assert.doesNotMatch(String(swapped.messages[0]?.summary), /Prepared continuation checkpoint/);

      await f.emit("agent_settled");
      assert.equal(f.appendedEntries.length, 1);
      const data = f.appendedEntries[0]?.data as { summary: string };
      assert.match(data.summary, /Verified continuation checkpoint/);
    } finally {
      await f.cleanup();
    }
  });
});

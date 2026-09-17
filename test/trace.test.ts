import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  TRACE_FILE_ENV_VAR,
  TRACE_STDERR_ENV_VAR,
  TRACE_STDERR_PREFIX,
  isStderrTraceEnabled,
  traceEvent,
} from "../src/trace.js";
import { fixture, waitFor, tick } from "./helpers/index-fixture.js";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function readEvents(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("trace sinks", () => {
  it("isStderrTraceEnabled honors opt-out spellings", () => {
    const previous = process.env[TRACE_STDERR_ENV_VAR];
    try {
      delete process.env[TRACE_STDERR_ENV_VAR];
      assert.equal(isStderrTraceEnabled(), false);
      process.env[TRACE_STDERR_ENV_VAR] = "";
      assert.equal(isStderrTraceEnabled(), false);
      process.env[TRACE_STDERR_ENV_VAR] = "0";
      assert.equal(isStderrTraceEnabled(), false);
      process.env[TRACE_STDERR_ENV_VAR] = "false";
      assert.equal(isStderrTraceEnabled(), false);
      process.env[TRACE_STDERR_ENV_VAR] = "1";
      assert.equal(isStderrTraceEnabled(), true);
    } finally {
      restoreEnv(TRACE_STDERR_ENV_VAR, previous);
    }
  });

  it("stays silent with no sinks and never throws on an unwritable file", () => {
    const previousFile = process.env[TRACE_FILE_ENV_VAR];
    const previousStderr = process.env[TRACE_STDERR_ENV_VAR];
    try {
      delete process.env[TRACE_FILE_ENV_VAR];
      delete process.env[TRACE_STDERR_ENV_VAR];
      assert.doesNotThrow(() => traceEvent("turn_usage", { turn: 1 }));
      process.env[TRACE_FILE_ENV_VAR] = join("/nonexistent-dir-xyz", "trace.jsonl");
      assert.doesNotThrow(() => traceEvent("turn_usage", { turn: 1 }));
    } finally {
      restoreEnv(TRACE_FILE_ENV_VAR, previousFile);
      restoreEnv(TRACE_STDERR_ENV_VAR, previousStderr);
    }
  });

  it("prefixes stderr lines for harness grepping", () => {
    const previous = process.env[TRACE_STDERR_ENV_VAR];
    const original = process.stderr.write;
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env[TRACE_STDERR_ENV_VAR] = "1";
      traceEvent("swap_applied", { turn: 4, firstSwap: true });
      assert.equal(captured.length, 1);
      assert.ok(captured[0]!.startsWith(TRACE_STDERR_PREFIX));
      const parsed = JSON.parse(captured[0]!.slice(TRACE_STDERR_PREFIX.length)) as Record<string, unknown>;
      assert.equal(parsed.event, "swap_applied");
      assert.equal(parsed.turn, 4);
      assert.ok(typeof parsed.ts === "string");
    } finally {
      process.stderr.write = original;
      restoreEnv(TRACE_STDERR_ENV_VAR, previous);
    }
  });
});

describe("trace lifecycle flow", () => {
  it("records turn usage, preparation cost, swap shape, and persist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
    const path = join(dir, "trace.jsonl");
    const previous = process.env[TRACE_FILE_ENV_VAR];
    process.env[TRACE_FILE_ENV_VAR] = path;
    try {
      const f = await fixture();
      try {
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled >= 2);
        await tick();
        await f.emit("context", { messages: f.contextMessages() });
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0);
        assert.equal(f.appendedEntries.length, 1);
      } finally {
        await f.cleanup();
      }
    } finally {
      restoreEnv(TRACE_FILE_ENV_VAR, previous);
    }

    const events = await readEvents(path);
    const byType = (type: string) => events.filter((event) => event.event === type);
    await rm(dir, { recursive: true, force: true });

    const usage = byType("turn_usage");
    assert.ok(usage.length >= 1);
    assert.ok(typeof usage[0]!.turn === "number");
    assert.ok(typeof usage[0]!.contextTokens === "number");
    assert.ok(typeof usage[0]!.contextPercent === "number");
    assert.equal(usage[0]!.phase, "idle");

    const started = byType("prepare_started");
    assert.equal(started.length, 1);
    assert.ok(typeof started[0]!.branchEntries === "number");

    const completed = byType("prepare_completed");
    assert.equal(completed.length, 1);
    for (const field of [
      "summaryChars",
      "summaryInput",
      "summaryOutput",
      "summaryCacheRead",
      "summaryCacheWrite",
      "summaryModel",
      "summaryThinking",
      "verifierInput",
      "verifierOutput",
      "verifierCacheRead",
      "verifierCacheWrite",
      "verifierModel",
      "verifierThinking",
      "verifierWallMs",
      "summaryWallMs",
      "packetChars",
      "sourceEntries",
      "firstKeptEntryId",
      "leafId",
    ]) {
      assert.ok(completed[0]![field] !== undefined, `prepare_completed carries ${field}`);
    }

    assert.equal(byType("checkpoint_published").length, 1);

    const swaps = byType("swap_applied");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.firstSwap, true);
    for (const field of [
      "messagesBefore",
      "messagesAfter",
      "messagesDropped",
      "contextTokensBefore",
      "firstKeptEntryId",
    ]) {
      assert.ok(swaps[0]![field] !== undefined && swaps[0]![field] !== null, `swap carries ${field}`);
    }

    const persisted = byType("checkpoint_persisted");
    assert.equal(persisted.length, 1);
    assert.ok(typeof persisted[0]!.checkpointId === "string");
    assert.equal(persisted[0]!.action, undefined);
  });

  it("skips a stale hard-threshold fallback when context recovered before idle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
    const path = join(dir, "trace.jsonl");
    const previous = process.env[TRACE_FILE_ENV_VAR];
    process.env[TRACE_FILE_ENV_VAR] = path;
    try {
      const f = await fixture();
      try {
        // Spike past the default hard threshold (80) queues the hatch.
        f.setPercent(85);
        await f.emit("turn_end");
        // The run drains below hard before the idle point: the hatch is stale.
        f.setPercent(50);
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0);
      } finally {
        await f.cleanup();
      }
    } finally {
      restoreEnv(TRACE_FILE_ENV_VAR, previous);
    }

    const events = await readEvents(path);
    await rm(dir, { recursive: true, force: true });
    const fallbacks = events.filter((event) => event.event === "native_fallback");
    assert.equal(fallbacks.length, 2);
    assert.equal(fallbacks[0]!.reason, "hard-threshold");
    assert.equal(fallbacks[0]!.contextPercent, 85);
    assert.equal(fallbacks[0]!.action, undefined);
    assert.equal(fallbacks[1]!.reason, "hard-threshold");
    assert.equal(fallbacks[1]!.action, "skipped-recovered");
    assert.equal(fallbacks[1]!.contextPercent, 50);
  });

  it("reports useful served-checkpoint exposure on turn_usage and swap_applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
    const path = join(dir, "trace.jsonl");
    const previous = process.env[TRACE_FILE_ENV_VAR];
    process.env[TRACE_FILE_ENV_VAR] = path;
    try {
      const f = await fixture();
      try {
        await f.emit("turn_end");
        await waitFor(() => f.registry.settled >= 2);
        await tick();
        await f.emit("context", { messages: f.contextMessages() });
        await f.emit("turn_end");
        await tick();
      } finally {
        await f.cleanup();
      }
    } finally {
      restoreEnv(TRACE_FILE_ENV_VAR, previous);
    }

    const events = await readEvents(path);
    await rm(dir, { recursive: true, force: true });
    const byType = (type: string) => events.filter((event) => event.event === type);

    const swaps = byType("swap_applied");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.firstSwap, true);
    assert.equal(swaps[0]!.swapCount, 1);

    const usage = byType("turn_usage");
    assert.ok(usage.length >= 2);
    // Pre-swap rows carry a zero count and no exposure window yet.
    assert.equal(usage[0]!.swapCount, 0);
    assert.equal(usage[0]!.firstSwapTurn, undefined);
    // The row after the first swap (turn 1) reports one post-swap turn.
    const last = usage.at(-1)!;
    assert.equal(last.swapCount, 1);
    assert.equal(last.firstSwapTurn, 1);
    assert.equal(last.postSwapModelTurns, 1);
  });

  it("records the hard-threshold native fallback with its trigger context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-trace-"));
    const path = join(dir, "trace.jsonl");
    const previous = process.env[TRACE_FILE_ENV_VAR];
    process.env[TRACE_FILE_ENV_VAR] = path;
    try {
      const f = await fixture();
      try {
        f.setPercent(80);
        await f.emit("turn_end");
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 1);
      } finally {
        await f.cleanup();
      }
    } finally {
      restoreEnv(TRACE_FILE_ENV_VAR, previous);
    }

    const events = await readEvents(path);
    await rm(dir, { recursive: true, force: true });
    const fallbacks = events.filter((event) => event.event === "native_fallback");
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0]!.reason, "hard-threshold");
    assert.equal(fallbacks[0]!.contextPercent, 80);
  });
});

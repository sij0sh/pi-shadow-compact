import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MODE_ENV_VAR } from "../src/config.js";
import { TRACE_FILE_ENV_VAR } from "../src/trace.js";
import { fixture, tick } from "./helpers/index-fixture.js";

describe("observe mode (instrumented control)", () => {
  it("emits turn_usage but never prepares, swaps, or compacts", async () => {
    const previousMode = process.env[MODE_ENV_VAR];
    const previousTrace = process.env[TRACE_FILE_ENV_VAR];
    const dir = await mkdtemp(join(tmpdir(), "shadow-observe-"));
    const tracePath = join(dir, "trace.jsonl");
    process.env[MODE_ENV_VAR] = "observe";
    process.env[TRACE_FILE_ENV_VAR] = tracePath;
    try {
      const f = await fixture({
        softCompactThresholdPercent: 5,
        summarizerModel: { provider: "", id: "" },
      });
      try {
        // Well above the soft threshold: active mode would prepare here.
        f.setPercent(60);
        await f.emit("turn_end");
        await tick();
        assert.equal(f.registry.calls, 0);
        assert.equal(f.compactCalls.length, 0);
        assert.deepEqual(f.notifications, []);

        // The context hook stays disabled.
        assert.equal(await f.emit("context", { messages: f.contextMessages() }), undefined);

        // Settle compacts nothing and reads no cache.
        await f.emit("agent_settled");
        assert.equal(f.compactCalls.length, 0);
        assert.equal(
          await f.emit("session_before_compact", f.compactEvent({ reason: "threshold" })),
          undefined,
        );
      } finally {
        await f.cleanup();
      }

      const text = await readFile(tracePath, "utf8");
      const events = text
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: string });
      assert.ok(events.length > 0, "observe mode emits telemetry");
      assert.ok(
        events.every((event) => event.event === "turn_usage" || event.event === "compaction_route"),
        "observe mode emits usage and route diagnostics without taking ownership",
      );
    } finally {
      if (previousMode === undefined) delete process.env[MODE_ENV_VAR];
      else process.env[MODE_ENV_VAR] = previousMode;
      if (previousTrace === undefined) delete process.env[TRACE_FILE_ENV_VAR];
      else process.env[TRACE_FILE_ENV_VAR] = previousTrace;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

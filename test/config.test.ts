import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
  defaultConfig,
  loadConfig,
} from "../src/config.js";

function context(cwd: string, trusted = true): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => trusted,
  } as ExtensionContext;
}

async function temporaryProject(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-shadow-compact-config-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function writeConfig(cwd: string, config: unknown): Promise<void> {
  const configDir = join(cwd, ".pi");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "shadow-compact.json"), JSON.stringify(config));
}

function config(
  softCompactThresholdPercent: unknown,
  provider = "",
  id = "",
): unknown {
  return {
    softCompactThresholdPercent,
    summarizerModel: { provider, id },
  };
}

describe("shadow compact config", () => {
  it("defaults to the standard threshold and a blank summarizer model", () => {
    assert.deepEqual(defaultConfig(), {
      softCompactThresholdPercent: DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "", id: "" },
    });
  });

  it("falls back to defaults when the config file is missing", async (t) => {
    const cwd = await temporaryProject(t);

    assert.deepEqual(await loadConfig(context(cwd)), defaultConfig());
  });

  it("does not load project config when the project is untrusted", async (t) => {
    const cwd = await temporaryProject(t);
    await writeConfig(cwd, config(75, "provider", "model"));

    assert.deepEqual(await loadConfig(context(cwd, false)), defaultConfig());
  });

  it("loads custom config from .pi/shadow-compact.json", async (t) => {
    const cwd = await temporaryProject(t);
    await writeConfig(cwd, config(75, " provider ", " model "));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 75,
      summarizerModel: { provider: "provider", id: "model" },
    });
  });

  for (const threshold of [1, 42.5, 99]) {
    it(`accepts threshold ${threshold}`, async (t) => {
      const cwd = await temporaryProject(t);
      await writeConfig(cwd, config(threshold));

      assert.equal((await loadConfig(context(cwd))).softCompactThresholdPercent, threshold);
    });
  }

  for (const threshold of [0, 100, "60"]) {
    it(`rejects out-of-range or non-numeric threshold ${JSON.stringify(threshold)}`, async (t) => {
      const cwd = await temporaryProject(t);
      await writeConfig(cwd, config(threshold));

      await assert.rejects(loadConfig(context(cwd)));
    });
  }

  for (const model of [
    { provider: "", id: "" },
    { provider: "provider", id: "model" },
  ]) {
    it(`accepts model fields when both are ${model.provider ? "set" : "blank"}`, async (t) => {
      const cwd = await temporaryProject(t);
      await writeConfig(cwd, config(60, model.provider, model.id));

      assert.deepEqual((await loadConfig(context(cwd))).summarizerModel, model);
    });
  }

  for (const model of [
    { provider: "provider", id: "" },
    { provider: "", id: "model" },
  ]) {
    it("rejects model fields when only one is set", async (t) => {
      const cwd = await temporaryProject(t);
      await writeConfig(cwd, config(60, model.provider, model.id));

      await assert.rejects(
        loadConfig(context(cwd)),
        /summarizerModel\.provider and summarizerModel\.id must both be blank or both be set/,
      );
    });
  }
});

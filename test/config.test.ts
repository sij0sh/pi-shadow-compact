import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
  DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
  HARD_THRESHOLD_ENV_VAR,
  MODE_ENV_VAR,
  SOFT_THRESHOLD_ENV_VAR,
  SOFT_THRESHOLD_ABS_ENV_VAR,
  SUMMARIZER_ID_ENV_VAR,
  SUMMARIZER_PROVIDER_ENV_VAR,
  SUMMARIZER_THINKING_ENV_VAR,
  TARGET_TAIL_ENV_VAR,
  defaultConfig,
  isAtOrAboveSoft,
  isBelowSoft,
  isObserveMode,
  loadConfig,
  resolveKeepRecentTokens,
} from "../src/config.js";

const CONFIG_FILE = "shadow-compact.json";

let savedAgentDirEnv: string | undefined;
let savedSoftEnv: string | undefined;
let savedSoftTokensEnv: string | undefined;
let savedHardEnv: string | undefined;
let savedTailEnv: string | undefined;
let savedModeEnv: string | undefined;
let savedSummarizerProviderEnv: string | undefined;
let savedSummarizerIdEnv: string | undefined;
let savedSummarizerThinkingEnv: string | undefined;
let agentDir = "";

function context(cwd: string, trusted = true): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => trusted,
  } as ExtensionContext;
}

function globalConfigPath(): string {
  return join(agentDir, CONFIG_FILE);
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", CONFIG_FILE);
}

async function temporaryCwd(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-shadow-compact-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function writeRaw(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function configBody(
  threshold: unknown,
  provider: unknown = "",
  id: unknown = "",
): Record<string, unknown> {
  return {
    softCompactThresholdPercent: threshold,
    summarizerModel: { provider, id },
  };
}

async function assertLoadError(
  promise: Promise<unknown>,
  path: string,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      error.message.includes(path),
      `expected "${error.message}" to include "${path}"`,
    );
    assert.match(error.message, pattern);
    return true;
  });
}

beforeEach(async () => {
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  savedSoftEnv = process.env[SOFT_THRESHOLD_ENV_VAR];
  savedSoftTokensEnv = process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  savedHardEnv = process.env[HARD_THRESHOLD_ENV_VAR];
  savedTailEnv = process.env[TARGET_TAIL_ENV_VAR];
  savedModeEnv = process.env[MODE_ENV_VAR];
  savedSummarizerProviderEnv = process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  savedSummarizerIdEnv = process.env[SUMMARIZER_ID_ENV_VAR];
  savedSummarizerThinkingEnv = process.env[SUMMARIZER_THINKING_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  delete process.env[HARD_THRESHOLD_ENV_VAR];
  delete process.env[TARGET_TAIL_ENV_VAR];
  delete process.env[MODE_ENV_VAR];
  delete process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  delete process.env[SUMMARIZER_ID_ENV_VAR];
  delete process.env[SUMMARIZER_THINKING_ENV_VAR];
  agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-compact-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (savedAgentDirEnv === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
  }
  if (savedSoftEnv === undefined) {
    delete process.env[SOFT_THRESHOLD_ENV_VAR];
  } else {
    process.env[SOFT_THRESHOLD_ENV_VAR] = savedSoftEnv;
  }
  if (savedSoftTokensEnv === undefined) {
    delete process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  } else {
    process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = savedSoftTokensEnv;
  }
  if (savedHardEnv === undefined) {
    delete process.env[HARD_THRESHOLD_ENV_VAR];
  } else {
    process.env[HARD_THRESHOLD_ENV_VAR] = savedHardEnv;
  }
  if (savedTailEnv === undefined) {
    delete process.env[TARGET_TAIL_ENV_VAR];
  } else {
    process.env[TARGET_TAIL_ENV_VAR] = savedTailEnv;
  }
  if (savedModeEnv === undefined) {
    delete process.env[MODE_ENV_VAR];
  } else {
    process.env[MODE_ENV_VAR] = savedModeEnv;
  }
  if (savedSummarizerProviderEnv === undefined) {
    delete process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  } else {
    process.env[SUMMARIZER_PROVIDER_ENV_VAR] = savedSummarizerProviderEnv;
  }
  if (savedSummarizerIdEnv === undefined) {
    delete process.env[SUMMARIZER_ID_ENV_VAR];
  } else {
    process.env[SUMMARIZER_ID_ENV_VAR] = savedSummarizerIdEnv;
  }
  if (savedSummarizerThinkingEnv === undefined) {
    delete process.env[SUMMARIZER_THINKING_ENV_VAR];
  } else {
    process.env[SUMMARIZER_THINKING_ENV_VAR] = savedSummarizerThinkingEnv;
  }
  await rm(agentDir, { recursive: true, force: true });
});

describe("shadow compact config loading", () => {
  it("uses defaults when no config files exist", async (t) => {
    const cwd = await temporaryCwd(t);

    assert.deepEqual(await loadConfig(context(cwd)), defaultConfig());
    assert.equal(
      defaultConfig().softCompactThresholdPercent,
      DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
    );
  });

  it("applies the global config file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 80,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "global-provider", id: "global-model" },
    });
  });

  it("project file overrides the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "project-provider", id: "project-model" },
    });
  });

  it("project file overrides the global file wholesale", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "", id: "" },
    });
  });

  it("untrusted project ignores the project file but still applies the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd, false)), {
      softCompactThresholdPercent: 80,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "global-provider", id: "global-model" },
    });
  });

  it("trims model fields and accepts both blank or both set", async (t) => {
    const cwd = await temporaryCwd(t);

    await writeJson(projectConfigPath(cwd), configBody(42.5, " provider ", " model "));
    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42.5,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "provider", id: "model" },
    });

    await writeJson(projectConfigPath(cwd), configBody(42.5));
    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42.5,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "", id: "" },
    });
  });

  it("accepts summaryMaxTokens, summarizerContextTokens, and thinkingLevel overrides", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(42, "provider", "model"),
      summaryMaxTokens: 32_768,
      summarizerContextTokens: 1_000_000,
      thinkingLevel: "high",
    });

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42,
      hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
      summarizerModel: { provider: "provider", id: "model" },
      summaryMaxTokens: 32_768,
      summarizerContextTokens: 1_000_000,
      thinkingLevel: "high",
    });
  });

  it("accepts a hardCompactThresholdPercent override", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(60),
      hardCompactThresholdPercent: 90,
    });

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 60,
      hardCompactThresholdPercent: 90,
      summarizerModel: { provider: "", id: "" },
    });
  });

  it("rejects a hardCompactThresholdPercent at or below the soft threshold", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(60),
      hardCompactThresholdPercent: 60,
    });

    await assertLoadError(
      loadConfig(context(cwd)),
      projectConfigPath(cwd),
      /hardCompactThresholdPercent must be greater than softCompactThresholdPercent/,
    );
  });

  for (const location of ["global", "project"] as const) {
    describe(`invalid ${location} config`, () => {
      async function writeBadConfig(cwd: string, value: unknown): Promise<string> {
        const path =
          location === "global" ? globalConfigPath() : projectConfigPath(cwd);
        if (typeof value === "string") {
          await writeRaw(path, value);
        } else {
          await writeJson(path, value);
        }
        return path;
      }

      it("invalid JSON throws with the file path", async (t) => {
        const cwd = await temporaryCwd(t);
        const path = await writeBadConfig(cwd, "{ not json");

        await assertLoadError(loadConfig(context(cwd)), path, /is not valid JSON/);
      });

      it("unknown top-level key throws with the file path", async (t) => {
        const cwd = await temporaryCwd(t);
        const path = await writeBadConfig(cwd, {
          ...configBody(60, "provider", "model"),
          unexpected: true,
        });

        await assertLoadError(loadConfig(context(cwd)), path, /has unknown key: unexpected/);
      });

      it("unknown summarizerModel key throws with the file path", async (t) => {
        const cwd = await temporaryCwd(t);
        const path = await writeBadConfig(cwd, {
          softCompactThresholdPercent: 60,
          summarizerModel: { provider: "provider", id: "model", extra: 1 },
        });

        await assertLoadError(
          loadConfig(context(cwd)),
          path,
          /summarizerModel has unknown key: extra/,
        );
      });

      for (const threshold of [0, 100]) {
        it(`out-of-range threshold ${threshold} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, configBody(threshold));

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /softCompactThresholdPercent must be between 1 and 99/,
          );
        });
      }

      for (const threshold of ["60", true, null]) {
        it(`non-number threshold ${JSON.stringify(threshold)} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, configBody(threshold));

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /softCompactThresholdPercent must be a number/,
          );
        });
      }

      for (const model of [
        { provider: "provider", id: "" },
        { provider: "", id: "model" },
      ]) {
        it("model fields with only one set throw with the file path", async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, configBody(60, model.provider, model.id));

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /summarizerModel\.provider and \.id must both be blank or both be set/,
          );
        });
      }

      for (const model of [
        { provider: 5, id: "" },
        { provider: null, id: "" },
        { provider: "", id: 5 },
      ]) {
        it(`non-string model fields (${JSON.stringify(model)}) throw with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, configBody(60, model.provider, model.id));

          const field = model.provider === "" ? "id" : "provider";
          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            new RegExp(`summarizerModel\\.${field} must be a string`),
          );
        });
      }

      for (const invalid of [
        { summaryMaxTokens: 0 },
        { summaryMaxTokens: -1 },
        { summaryMaxTokens: 1.5 },
        { summaryMaxTokens: "4096" },
        { summaryMaxTokens: null },
        { summarizerContextTokens: 0 },
        { summarizerContextTokens: -5 },
        { summarizerContextTokens: 1.5 },
        { summarizerContextTokens: "1000000" },
        { summarizerContextTokens: null },
        { thinkingLevel: "bogus" },
        { thinkingLevel: 5 },
        { hardCompactThresholdPercent: 0 },
        { hardCompactThresholdPercent: 100 },
        { hardCompactThresholdPercent: "80" },
        { hardCompactThresholdPercent: null },
      ]) {
        it(`invalid ${JSON.stringify(invalid)} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, { ...configBody(60), ...invalid });

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /summaryMaxTokens must be a positive integer|summarizerContextTokens must be a positive integer|thinkingLevel must be one of|hardCompactThresholdPercent must be/,
          );
        });
      }

    });
  }

  describe("threshold environment overrides", () => {
    it("env thresholds override file config", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        hardCompactThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "5";
      process.env[HARD_THRESHOLD_ENV_VAR] = "15";

      assert.deepEqual(await loadConfig(context(cwd)), {
        softCompactThresholdPercent: 5,
        hardCompactThresholdPercent: 15,
        summarizerModel: { provider: "", id: "" },
      });
    });

    it("a single env threshold merges with file config", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        hardCompactThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "10";

      const config = await loadConfig(context(cwd));
      assert.equal(config.softCompactThresholdPercent, 10);
      assert.equal(config.hardCompactThresholdPercent, 80);
    });

    it("empty env values are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ENV_VAR] = "  ";
      process.env[HARD_THRESHOLD_ENV_VAR] = "";

      const config = await loadConfig(context(cwd));
      assert.equal(config.softCompactThresholdPercent, DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT);
      assert.equal(config.hardCompactThresholdPercent, DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT);
    });

    for (const value of ["lots", "NaN", "0", "100", "-3"]) {
      it(`invalid soft env ${JSON.stringify(value)} throws naming the variable`, async (t) => {
        const cwd = await temporaryCwd(t);
        process.env[SOFT_THRESHOLD_ENV_VAR] = value;

        await assert.rejects(
          loadConfig(context(cwd)),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(SOFT_THRESHOLD_ENV_VAR));
            return true;
          },
        );
      });
    }

    it("env hard at or below the soft threshold throws", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ENV_VAR] = "15";
      process.env[HARD_THRESHOLD_ENV_VAR] = "15";

      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(HARD_THRESHOLD_ENV_VAR));
          return true;
        },
      );
    });

    it("env soft above the file hard threshold throws", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        hardCompactThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "85";

      await assert.rejects(loadConfig(context(cwd)), /must be greater than the soft threshold/);
    });
  });

  describe("absolute soft threshold tokens override", () => {
    it("is absent by default, leaving percent behavior unchanged", async (t) => {
      const cwd = await temporaryCwd(t);

      assert.equal((await loadConfig(context(cwd))).softCompactThresholdTokens, undefined);
    });

    it("sets the token knob without touching percent thresholds", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = "60000";

      const config = await loadConfig(context(cwd));
      assert.equal(config.softCompactThresholdTokens, 60000);
      assert.equal(config.softCompactThresholdPercent, DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT);
      assert.equal(config.hardCompactThresholdPercent, DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT);
    });

    it("empty values are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = "  ";

      assert.equal((await loadConfig(context(cwd))).softCompactThresholdTokens, undefined);
    });

    for (const value of ["lots", "NaN", "0", "-3", "1.5", "30k"]) {
      it(`invalid token threshold ${JSON.stringify(value)} throws naming the variable`, async (t) => {
        const cwd = await temporaryCwd(t);
        process.env[SOFT_THRESHOLD_ABS_ENV_VAR] = value;

        await assert.rejects(
          loadConfig(context(cwd)),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(SOFT_THRESHOLD_ABS_ENV_VAR));
            return true;
          },
        );
      });
    }
  });

  describe("isAtOrAboveSoft / isBelowSoft", () => {
    it("token threshold wins when set and tokens are reported", () => {
      const config = { softCompactThresholdPercent: 5, softCompactThresholdTokens: 60000 };
      // Tokens above, percent below: tokens win -> at/above.
      assert.equal(isAtOrAboveSoft({ tokens: 61000, percent: 1 }, config), true);
      assert.equal(isBelowSoft({ tokens: 61000, percent: 1 }, config), false);
      // Tokens below, percent above: tokens win -> below.
      assert.equal(isAtOrAboveSoft({ tokens: 59000, percent: 90 }, config), false);
      assert.equal(isBelowSoft({ tokens: 59000, percent: 90 }, config), true);
    });

    it("falls back to percent when tokens are unset or unreported", () => {
      assert.equal(isAtOrAboveSoft({ percent: 5 }, { softCompactThresholdPercent: 5 }), true);
      assert.equal(isAtOrAboveSoft({ percent: 4.9 }, { softCompactThresholdPercent: 5 }), false);
      assert.equal(
        isAtOrAboveSoft(
          { percent: 90 },
          { softCompactThresholdPercent: 5, softCompactThresholdTokens: 60000 },
        ),
        true,
      );
      assert.equal(
        isBelowSoft(
          { percent: 1 },
          { softCompactThresholdPercent: 5, softCompactThresholdTokens: 60000 },
        ),
        true,
      );
    });
  });

  describe("summarizer environment overrides", () => {
    it("unset overrides leave file summarizer config untouched", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60, "file-provider", "file-model"),
        thinkingLevel: "low",
      });

      const config = await loadConfig(context(cwd));
      assert.deepEqual(config.summarizerModel, { provider: "file-provider", id: "file-model" });
      assert.equal(config.thinkingLevel, "low");
    });

    it("blank overrides are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SUMMARIZER_PROVIDER_ENV_VAR] = "  ";
      process.env[SUMMARIZER_ID_ENV_VAR] = "";
      process.env[SUMMARIZER_THINKING_ENV_VAR] = " ";

      const config = await loadConfig(context(cwd));
      assert.deepEqual(config.summarizerModel, { provider: "", id: "" });
      assert.equal("thinkingLevel" in config, false);
    });

    it("provider and id override together, including slash/colon ids", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), configBody(60, "file-provider", "file-model"));
      process.env[SUMMARIZER_PROVIDER_ENV_VAR] = "bench-provider";
      process.env[SUMMARIZER_ID_ENV_VAR] = "org/model:variant";

      const config = await loadConfig(context(cwd));
      assert.deepEqual(config.summarizerModel, { provider: "bench-provider", id: "org/model:variant" });
    });

    it("a lone provider without id throws naming both variables", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SUMMARIZER_PROVIDER_ENV_VAR] = "bench-provider";

      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(SUMMARIZER_PROVIDER_ENV_VAR));
          assert.match(error.message, new RegExp(SUMMARIZER_ID_ENV_VAR));
          return true;
        },
      );
    });

    it("a lone id without provider throws", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SUMMARIZER_ID_ENV_VAR] = "bench-model";

      await assert.rejects(loadConfig(context(cwd)), /both be set or both be unset/);
    });

    it("a valid thinking level overrides the file value", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        thinkingLevel: "low",
      });
      process.env[SUMMARIZER_THINKING_ENV_VAR] = "medium";

      assert.equal((await loadConfig(context(cwd))).thinkingLevel, "medium");
    });

    it("an invalid thinking level throws naming the variable", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SUMMARIZER_THINKING_ENV_VAR] = "ultra";

      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(SUMMARIZER_THINKING_ENV_VAR));
          return true;
        },
      );
    });
  });

  describe("target tail environment override", () => {
    it("is absent by default, leaving Pi behavior unchanged", async (t) => {
      const cwd = await temporaryCwd(t);

      assert.equal((await loadConfig(context(cwd))).targetTailPercent, undefined);
    });

    it("sets the experimental tail knob without touching thresholds", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[TARGET_TAIL_ENV_VAR] = "2";

      const config = await loadConfig(context(cwd));
      assert.equal(config.targetTailPercent, 2);
      assert.equal(config.softCompactThresholdPercent, DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT);
      assert.equal(config.hardCompactThresholdPercent, DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT);
    });

    it("empty values are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[TARGET_TAIL_ENV_VAR] = "  ";

      assert.equal((await loadConfig(context(cwd))).targetTailPercent, undefined);
    });

    for (const value of ["lots", "NaN", "0", "100", "-3"]) {
      it(`invalid target tail ${JSON.stringify(value)} throws naming the variable`, async (t) => {
        const cwd = await temporaryCwd(t);
        process.env[TARGET_TAIL_ENV_VAR] = value;

        await assert.rejects(
          loadConfig(context(cwd)),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(TARGET_TAIL_ENV_VAR));
            return true;
          },
        );
      });
    }
  });
});

describe("resolveKeepRecentTokens", () => {
  it("returns Pi's budget when the knob is unset or the window is unknown", () => {
    assert.equal(resolveKeepRecentTokens(20_000, undefined, 272_000), 20_000);
    assert.equal(resolveKeepRecentTokens(20_000, 2, undefined), 20_000);
  });

  it("derives the tail from the context window on luna (272k x 2% = 5440)", () => {
    assert.equal(resolveKeepRecentTokens(20_000, 2, 272_000), 5440);
  });

  it("caps an oversized target at Pi's budget so production behavior is unchanged", () => {
    assert.equal(resolveKeepRecentTokens(20_000, 99, 272_000), 20_000);
    assert.equal(resolveKeepRecentTokens(30, 90, 1000), 30);
  });

  it("uses the smaller tail on small windows", () => {
    assert.equal(resolveKeepRecentTokens(30, 2, 1000), 20);
  });
});

describe("isObserveMode", () => {
  it("is off by default and on only for observe", () => {
    assert.equal(isObserveMode(), false);
    process.env[MODE_ENV_VAR] = "observe";
    assert.equal(isObserveMode(), true);
    process.env[MODE_ENV_VAR] = "OBSERVE";
    assert.equal(isObserveMode(), true);
    process.env[MODE_ENV_VAR] = "active";
    assert.equal(isObserveMode(), false);
    process.env[MODE_ENV_VAR] = "";
    assert.equal(isObserveMode(), false);
  });
});

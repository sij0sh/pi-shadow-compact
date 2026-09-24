import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_IDLE_COMPACT_MIN_TOKENS,
  DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT,
  DEFAULT_PREPARE_THRESHOLD_PERCENT,
  DEFAULT_RECENT_TURNS,
  DEFAULT_SWAP_THRESHOLD_PERCENT,
  HARD_THRESHOLD_ENV_VAR,
  IDLE_MIN_TOKENS_ENV_VAR,
  MANUAL_MODE_ENV_VAR,
  MODE_ENV_VAR,
  NATIVE_THRESHOLD_ENV_VAR,
  SOFT_THRESHOLD_ENV_VAR,
  SOFT_THRESHOLD_ABS_ENV_VAR,
  SUMMARIZER_ID_ENV_VAR,
  SUMMARIZER_PROVIDER_ENV_VAR,
  SUMMARIZER_THINKING_ENV_VAR,
  VERIFIER_ID_ENV_VAR,
  VERIFIER_PROVIDER_ENV_VAR,
  VERIFIER_THINKING_ENV_VAR,
  defaultConfig,
  isAtOrAboveNativeFallback,
  isAtOrAbovePrepare,
  isAtOrAboveSwap,
  isAtOrAboveSoft,
  isBelowSoft,
  isObserveMode,
  loadConfig,
} from "../src/config.js";

const CONFIG_FILE = "shadow-compact.json";

function expectedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prepareThresholdPercent: DEFAULT_PREPARE_THRESHOLD_PERCENT,
    swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
    nativeFallbackThresholdPercent: DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT,
    summarizerModel: { provider: "", id: "" },
    idleCompact: { enabled: true, minimumTokens: DEFAULT_IDLE_COMPACT_MIN_TOKENS },
    recentTurns: DEFAULT_RECENT_TURNS,
    manualCompactMode: "shadow",
    ...overrides,
  };
}

let savedAgentDirEnv: string | undefined;
let savedSoftEnv: string | undefined;
let savedSoftTokensEnv: string | undefined;
let savedHardEnv: string | undefined;
let savedNativeEnv: string | undefined;
let savedManualEnv: string | undefined;
let savedIdleEnv: string | undefined;
let savedModeEnv: string | undefined;
let savedSummarizerProviderEnv: string | undefined;
let savedSummarizerIdEnv: string | undefined;
let savedSummarizerThinkingEnv: string | undefined;
let savedVerifierProviderEnv: string | undefined;
let savedVerifierIdEnv: string | undefined;
let savedVerifierThinkingEnv: string | undefined;
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
    prepareThresholdPercent: threshold,
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
  savedNativeEnv = process.env[NATIVE_THRESHOLD_ENV_VAR];
  savedManualEnv = process.env[MANUAL_MODE_ENV_VAR];
  savedIdleEnv = process.env[IDLE_MIN_TOKENS_ENV_VAR];
  savedModeEnv = process.env[MODE_ENV_VAR];
  savedSummarizerProviderEnv = process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  savedSummarizerIdEnv = process.env[SUMMARIZER_ID_ENV_VAR];
  savedSummarizerThinkingEnv = process.env[SUMMARIZER_THINKING_ENV_VAR];
  savedVerifierProviderEnv = process.env[VERIFIER_PROVIDER_ENV_VAR];
  savedVerifierIdEnv = process.env[VERIFIER_ID_ENV_VAR];
  savedVerifierThinkingEnv = process.env[VERIFIER_THINKING_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ABS_ENV_VAR];
  delete process.env[HARD_THRESHOLD_ENV_VAR];
  delete process.env[NATIVE_THRESHOLD_ENV_VAR];
  delete process.env[MANUAL_MODE_ENV_VAR];
  delete process.env[IDLE_MIN_TOKENS_ENV_VAR];
  delete process.env[MODE_ENV_VAR];
  delete process.env[SUMMARIZER_PROVIDER_ENV_VAR];
  delete process.env[SUMMARIZER_ID_ENV_VAR];
  delete process.env[SUMMARIZER_THINKING_ENV_VAR];
  delete process.env[VERIFIER_PROVIDER_ENV_VAR];
  delete process.env[VERIFIER_ID_ENV_VAR];
  delete process.env[VERIFIER_THINKING_ENV_VAR];
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
  if (savedNativeEnv === undefined) {
    delete process.env[NATIVE_THRESHOLD_ENV_VAR];
  } else {
    process.env[NATIVE_THRESHOLD_ENV_VAR] = savedNativeEnv;
  }
  if (savedManualEnv === undefined) {
    delete process.env[MANUAL_MODE_ENV_VAR];
  } else {
    process.env[MANUAL_MODE_ENV_VAR] = savedManualEnv;
  }
  if (savedIdleEnv === undefined) {
    delete process.env[IDLE_MIN_TOKENS_ENV_VAR];
  } else {
    process.env[IDLE_MIN_TOKENS_ENV_VAR] = savedIdleEnv;
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
  if (savedVerifierProviderEnv === undefined) {
    delete process.env[VERIFIER_PROVIDER_ENV_VAR];
  } else {
    process.env[VERIFIER_PROVIDER_ENV_VAR] = savedVerifierProviderEnv;
  }
  if (savedVerifierIdEnv === undefined) {
    delete process.env[VERIFIER_ID_ENV_VAR];
  } else {
    process.env[VERIFIER_ID_ENV_VAR] = savedVerifierIdEnv;
  }
  if (savedVerifierThinkingEnv === undefined) {
    delete process.env[VERIFIER_THINKING_ENV_VAR];
  } else {
    process.env[VERIFIER_THINKING_ENV_VAR] = savedVerifierThinkingEnv;
  }
  await rm(agentDir, { recursive: true, force: true });
});

describe("shadow compact config loading", () => {
  it("uses defaults when no config files exist", async (t) => {
    const cwd = await temporaryCwd(t);

    assert.deepEqual(await loadConfig(context(cwd)), defaultConfig());
    assert.equal(
      defaultConfig().prepareThresholdPercent,
      DEFAULT_PREPARE_THRESHOLD_PERCENT,
    );
  });

  it("applies the global config file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));

    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 80,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "global-provider", id: "global-model" },
    }));
  });

  it("project file overrides the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 42,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "project-provider", id: "project-model" },
    }));
  });

  it("project file overrides the global file wholesale", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42));

    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 42,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "", id: "" },
    }));
  });

  it("untrusted project ignores the project file but still applies the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd, false)), expectedConfig({
      prepareThresholdPercent: 80,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "global-provider", id: "global-model" },
    }));
  });

  it("trims model fields and accepts both blank or both set", async (t) => {
    const cwd = await temporaryCwd(t);

    await writeJson(projectConfigPath(cwd), configBody(42.5, " provider ", " model "));
    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 42.5,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "provider", id: "model" },
    }));

    await writeJson(projectConfigPath(cwd), configBody(42.5));
    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 42.5,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "", id: "" },
    }));
  });

  it("accepts summaryMaxTokens and thinkingLevel overrides", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(42, "provider", "model"),
      summaryMaxTokens: 32_768,
      thinkingLevel: "high",
    });

    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 42,
      swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
      summarizerModel: { provider: "provider", id: "model" },
      summaryMaxTokens: 32_768,
      thinkingLevel: "high",
    }));
  });

  it("accepts a swapThresholdPercent override", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(60),
      swapThresholdPercent: 90,
    });

    assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
      prepareThresholdPercent: 60,
      swapThresholdPercent: 90,
      summarizerModel: { provider: "", id: "" },
    }));
  });

  it("rejects a swapThresholdPercent at or below the soft threshold", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(60),
      swapThresholdPercent: 60,
    });

    await assertLoadError(
      loadConfig(context(cwd)),
      projectConfigPath(cwd),
      /swapThresholdPercent must be greater than prepareThresholdPercent/,
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

      it("removed historicTurns key throws as unknown", async (t) => {
        const cwd = await temporaryCwd(t);
        const path = await writeBadConfig(cwd, {
          ...configBody(60, "provider", "model"),
          historicTurns: { enabled: true },
        });

        await assertLoadError(loadConfig(context(cwd)), path, /has unknown key: historicTurns/);
      });

      it("unknown summarizerModel key throws with the file path", async (t) => {
        const cwd = await temporaryCwd(t);
        const path = await writeBadConfig(cwd, {
          prepareThresholdPercent: 60,
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
            /prepareThresholdPercent must be between 1 and 99/,
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
            /prepareThresholdPercent must be a number/,
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
        { thinkingLevel: "bogus" },
        { thinkingLevel: 5 },
        { swapThresholdPercent: 0 },
        { swapThresholdPercent: 100 },
        { swapThresholdPercent: "80" },
        { swapThresholdPercent: null },
      ]) {
        it(`invalid ${JSON.stringify(invalid)} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, { ...configBody(60), ...invalid });

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /summaryMaxTokens must be a positive integer|thinkingLevel must be one of|swapThresholdPercent must be/,
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
        swapThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "5";
      process.env[HARD_THRESHOLD_ENV_VAR] = "15";

      assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
        prepareThresholdPercent: 5,
        swapThresholdPercent: 15,
        summarizerModel: { provider: "", id: "" },
      }));
    });

    it("a single env threshold merges with file config", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        swapThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "10";

      const config = await loadConfig(context(cwd));
      assert.equal(config.prepareThresholdPercent, 10);
      assert.equal(config.swapThresholdPercent, 80);
    });

    it("empty env values are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ENV_VAR] = "  ";
      process.env[HARD_THRESHOLD_ENV_VAR] = "";

      const config = await loadConfig(context(cwd));
      assert.equal(config.prepareThresholdPercent, DEFAULT_PREPARE_THRESHOLD_PERCENT);
      assert.equal(config.swapThresholdPercent, DEFAULT_SWAP_THRESHOLD_PERCENT);
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
        swapThresholdPercent: 80,
      });
      process.env[SOFT_THRESHOLD_ENV_VAR] = "85";

      await assert.rejects(loadConfig(context(cwd)), /must be greater than the prepare threshold/);
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
      assert.equal(config.prepareThresholdPercent, DEFAULT_PREPARE_THRESHOLD_PERCENT);
      assert.equal(config.swapThresholdPercent, DEFAULT_SWAP_THRESHOLD_PERCENT);
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
      const config = { prepareThresholdPercent: 5, softCompactThresholdTokens: 60000 };
      // Tokens above, percent below: tokens win -> at/above.
      assert.equal(isAtOrAboveSoft({ tokens: 61000, percent: 1 }, config), true);
      assert.equal(isBelowSoft({ tokens: 61000, percent: 1 }, config), false);
      // Tokens below, percent above: tokens win -> below.
      assert.equal(isAtOrAboveSoft({ tokens: 59000, percent: 90 }, config), false);
      assert.equal(isBelowSoft({ tokens: 59000, percent: 90 }, config), true);
    });

    it("falls back to percent when tokens are unset or unreported", () => {
      assert.equal(isAtOrAboveSoft({ percent: 5 }, { prepareThresholdPercent: 5 }), true);
      assert.equal(isAtOrAboveSoft({ percent: 4.9 }, { prepareThresholdPercent: 5 }), false);
      assert.equal(
        isAtOrAboveSoft(
          { percent: 90 },
          { prepareThresholdPercent: 5, softCompactThresholdTokens: 60000 },
        ),
        true,
      );
      assert.equal(
        isBelowSoft(
          { percent: 1 },
          { prepareThresholdPercent: 5, softCompactThresholdTokens: 60000 },
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

  describe("verification model config", () => {
    it("is absent by default, so the verifier reuses the summarizer model", async (t) => {
      const cwd = await temporaryCwd(t);

      const config = await loadConfig(context(cwd));
      assert.equal(config.verificationModel, undefined);
      assert.equal(config.verificationThinkingLevel, undefined);
    });

    it("accepts a verificationModel pair and thinking level from file", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60, "provider", "model"),
        verificationModel: { provider: "verify-provider", id: "org/verifier:strong" },
        verificationThinkingLevel: "high",
      });

      assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
        prepareThresholdPercent: 60,
        swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
        summarizerModel: { provider: "provider", id: "model" },
        verificationModel: { provider: "verify-provider", id: "org/verifier:strong" },
        verificationThinkingLevel: "high",
      }));
    });

    it("accepts a blank verification pair as unset-equivalent", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        verificationModel: { provider: "", id: "" },
      });

      assert.deepEqual((await loadConfig(context(cwd))).verificationModel, {
        provider: "",
        id: "",
      });
    });

    it("a half-set verification pair throws", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, {
        ...configBody(60),
        verificationModel: { provider: "verify-provider", id: "" },
      });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /verificationModel\.provider and \.id must both be blank or both be set/,
      );
    });

    it("an unknown verificationModel key throws", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, {
        ...configBody(60),
        verificationModel: { provider: "p", id: "m", extra: 1 },
      });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /verificationModel has unknown key: extra/,
      );
    });

    it("an invalid verificationThinkingLevel throws", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, { ...configBody(60), verificationThinkingLevel: "ultra" });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /verificationThinkingLevel must be one of/,
      );
    });
  });

  describe("verifier environment overrides", () => {
    it("unset overrides leave file verifier config untouched", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60, "file-provider", "file-model"),
        verificationModel: { provider: "file-verify", id: "file-verifier" },
        verificationThinkingLevel: "low",
      });

      const config = await loadConfig(context(cwd));
      assert.deepEqual(config.verificationModel, {
        provider: "file-verify",
        id: "file-verifier",
      });
      assert.equal(config.verificationThinkingLevel, "low");
    });

    it("blank overrides are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[VERIFIER_PROVIDER_ENV_VAR] = "  ";
      process.env[VERIFIER_ID_ENV_VAR] = "";
      process.env[VERIFIER_THINKING_ENV_VAR] = " ";

      const config = await loadConfig(context(cwd));
      assert.equal(config.verificationModel, undefined);
      assert.equal("verificationThinkingLevel" in config, false);
    });

    it("provider and id override together, including slash/colon ids", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        verificationModel: { provider: "file-verify", id: "file-verifier" },
      });
      process.env[VERIFIER_PROVIDER_ENV_VAR] = "bench-provider";
      process.env[VERIFIER_ID_ENV_VAR] = "org/model:variant";

      const config = await loadConfig(context(cwd));
      assert.deepEqual(config.verificationModel, {
        provider: "bench-provider",
        id: "org/model:variant",
      });
    });

    it("a lone provider without id throws naming both variables", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[VERIFIER_PROVIDER_ENV_VAR] = "bench-provider";

      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(VERIFIER_PROVIDER_ENV_VAR));
          assert.match(error.message, new RegExp(VERIFIER_ID_ENV_VAR));
          return true;
        },
      );
    });

    it("a valid thinking level overrides the file value", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        verificationThinkingLevel: "low",
      });
      process.env[VERIFIER_THINKING_ENV_VAR] = "high";

      assert.equal((await loadConfig(context(cwd))).verificationThinkingLevel, "high");
    });

    it("an invalid thinking level throws naming the variable", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[VERIFIER_THINKING_ENV_VAR] = "ultra";

      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(VERIFIER_THINKING_ENV_VAR));
          return true;
        },
      );
    });
  });

  describe("threshold aliases and ordering", () => {
    it("loads legacy soft/hard keys as prepare/swap thresholds", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        softCompactThresholdPercent: 55,
        hardCompactThresholdPercent: 75,
        summarizerModel: { provider: "", id: "" },
      });

      const config = await loadConfig(context(cwd));
      assert.equal(config.prepareThresholdPercent, 55);
      assert.equal(config.swapThresholdPercent, 75);
    });

    it("conflicting canonical and alias values throw", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, {
        prepareThresholdPercent: 60,
        softCompactThresholdPercent: 50,
        summarizerModel: { provider: "", id: "" },
      });

      await assertLoadError(loadConfig(context(cwd)), path, /and legacy softCompactThresholdPercent conflict/);
    });

    it("an explicit native threshold at or below swap throws", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, { ...configBody(60), nativeFallbackThresholdPercent: 80 });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /nativeFallbackThresholdPercent must be greater than swapThresholdPercent/,
      );
    });

    for (const invalid of [
      { nativeFallbackThresholdPercent: 0 },
      { nativeFallbackThresholdPercent: "92" },
      { recentTurns: 0 },
      { recentTurns: "10" },
      { manualCompactMode: "sometimes" },
      { idleCompact: { enabled: "yes" } },
      { idleCompact: { minimumTokens: 0 } },
      { idleCompact: { surprise: 1 } },
      { historicTurns: { enabled: true } },
    ]) {
      it(`invalid ${JSON.stringify(invalid)} throws with the file path`, async (t) => {
        const cwd = await temporaryCwd(t);
        const path = projectConfigPath(cwd);
        await writeJson(path, { ...configBody(60), ...invalid });

        await assertLoadError(
          loadConfig(context(cwd)),
          path,
          /nativeFallbackThresholdPercent must be|recentTurns must be a positive integer|manualCompactMode must be|idleCompact|historicTurns/,
        );
      });
    }
  });

  describe("idle, recent, and manual config", () => {
    it("applies defaults for the new behaviors", async (t) => {
      const cwd = await temporaryCwd(t);

      assert.deepEqual(await loadConfig(context(cwd)), expectedConfig());
    });

    it("accepts file overrides for the new behaviors", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        ...configBody(60),
        nativeFallbackThresholdPercent: 95,
        idleCompact: { enabled: false, minimumTokens: 5000 },
        recentTurns: 12,
        manualCompactMode: "native",
      });

      assert.deepEqual(await loadConfig(context(cwd)), expectedConfig({
        nativeFallbackThresholdPercent: 95,
        idleCompact: { enabled: false, minimumTokens: 5000 },
        recentTurns: 12,
        manualCompactMode: "native",
      }));
    });
  });

  describe("native, manual, and idle environment overrides", () => {
    it("env native threshold merges and enforces ordering", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[NATIVE_THRESHOLD_ENV_VAR] = "95";
      assert.equal((await loadConfig(context(cwd))).nativeFallbackThresholdPercent, 95);

      process.env[NATIVE_THRESHOLD_ENV_VAR] = "70";
      await assert.rejects(loadConfig(context(cwd)), /must be greater than the swap threshold/);
    });

    it("env manual mode accepts shadow/native and rejects the rest", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[MANUAL_MODE_ENV_VAR] = "native";
      assert.equal((await loadConfig(context(cwd))).manualCompactMode, "native");

      process.env[MANUAL_MODE_ENV_VAR] = "sometimes";
      await assert.rejects(
        loadConfig(context(cwd)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(MANUAL_MODE_ENV_VAR));
          return true;
        },
      );
    });

    it("env idle minimum tokens merges without touching other idle settings", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), { ...configBody(60), idleCompact: { enabled: false } });
      process.env[IDLE_MIN_TOKENS_ENV_VAR] = "5000";

      assert.deepEqual((await loadConfig(context(cwd))).idleCompact, {
        enabled: false,
        minimumTokens: 5000,
      });
    });

  });
});

describe("threshold comparisons", () => {
  it("prepare uses absolute tokens when set, else percent", () => {
    const config = { prepareThresholdPercent: 60, softCompactThresholdTokens: 60000 };
    assert.equal(isAtOrAbovePrepare({ tokens: 61000, percent: 1 }, config), true);
    assert.equal(isAtOrAbovePrepare({ tokens: 59000, percent: 90 }, config), false);
    assert.equal(isAtOrAbovePrepare({ percent: 60 }, { prepareThresholdPercent: 60 }), true);
    assert.equal(isAtOrAbovePrepare({ percent: 59 }, { prepareThresholdPercent: 60 }), false);
  });

  it("swap and native fallback compare percent only", () => {
    assert.equal(isAtOrAboveSwap({ percent: 80 }, { swapThresholdPercent: 80 }), true);
    assert.equal(isAtOrAboveSwap({ percent: 79 }, { swapThresholdPercent: 80 }), false);
    assert.equal(isAtOrAboveSwap({ tokens: 999999 }, { swapThresholdPercent: 80 }), false);
    assert.equal(
      isAtOrAboveNativeFallback({ percent: 92 }, { nativeFallbackThresholdPercent: 92 }),
      true,
    );
    assert.equal(
      isAtOrAboveNativeFallback({ percent: 91 }, { nativeFallbackThresholdPercent: 92 }),
      false,
    );
  });

  it("legacy soft aliases match prepare semantics", () => {
    const config = { prepareThresholdPercent: 60 };
    assert.equal(isAtOrAboveSoft({ percent: 60 }, config), isAtOrAbovePrepare({ percent: 60 }, config));
    assert.equal(isBelowSoft({ percent: 59 }, config), true);
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

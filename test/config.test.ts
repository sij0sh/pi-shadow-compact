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
  NATIVE_THRESHOLD_ENV_VAR,
  SOFT_THRESHOLD_ENV_VAR,
  defaultConfig,
  isAtOrAbovePrepare,
  isBelowPrepare,
  loadConfig,
} from "../src/config.js";

const CONFIG_FILE = "shadow-compact.json";

function expectedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prepareThresholdPercent: DEFAULT_PREPARE_THRESHOLD_PERCENT,
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
let savedNativeEnv: string | undefined;
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
    assert.ok(error.message.includes(path), `expected "${error.message}" to include "${path}"`);
    assert.match(error.message, pattern);
    return true;
  });
}

beforeEach(async () => {
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  savedSoftEnv = process.env[SOFT_THRESHOLD_ENV_VAR];
  savedNativeEnv = process.env[NATIVE_THRESHOLD_ENV_VAR];
  delete process.env[SOFT_THRESHOLD_ENV_VAR];
  delete process.env[NATIVE_THRESHOLD_ENV_VAR];
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
  if (savedNativeEnv === undefined) {
    delete process.env[NATIVE_THRESHOLD_ENV_VAR];
  } else {
    process.env[NATIVE_THRESHOLD_ENV_VAR] = savedNativeEnv;
  }
  await rm(agentDir, { recursive: true, force: true });
});

describe("shadow compact config loading", () => {
  it("uses defaults when no config files exist", async (t) => {
    const cwd = await temporaryCwd(t);

    assert.deepEqual(await loadConfig(context(cwd)), defaultConfig());
    assert.equal(defaultConfig().prepareThresholdPercent, DEFAULT_PREPARE_THRESHOLD_PERCENT);
  });

  it("applies the global config file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));

    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 80,
        summarizerModel: { provider: "global-provider", id: "global-model" },
      }),
    );
  });

  it("project file overrides the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 42,
        summarizerModel: { provider: "project-provider", id: "project-model" },
      }),
    );
  });

  it("project file overrides the global file wholesale", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42));

    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 42,
        summarizerModel: { provider: "", id: "" },
      }),
    );
  });

  it("untrusted project ignores the project file but still applies the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(
      await loadConfig(context(cwd, false)),
      expectedConfig({
        prepareThresholdPercent: 80,
        summarizerModel: { provider: "global-provider", id: "global-model" },
      }),
    );
  });

  it("trims model fields and accepts both blank or both set", async (t) => {
    const cwd = await temporaryCwd(t);

    await writeJson(projectConfigPath(cwd), configBody(42.5, " provider ", " model "));
    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 42.5,
        summarizerModel: { provider: "provider", id: "model" },
      }),
    );

    await writeJson(projectConfigPath(cwd), configBody(42.5));
    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 42.5,
        summarizerModel: { provider: "", id: "" },
      }),
    );
  });

  it("accepts summaryMaxTokens and thinkingLevel overrides", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(projectConfigPath(cwd), {
      ...configBody(42, "provider", "model"),
      summaryMaxTokens: 32_768,
      thinkingLevel: "high",
    });

    assert.deepEqual(
      await loadConfig(context(cwd)),
      expectedConfig({
        prepareThresholdPercent: 42,
        summarizerModel: { provider: "provider", id: "model" },
        summaryMaxTokens: 32_768,
        thinkingLevel: "high",
      }),
    );
  });

  for (const location of ["global", "project"] as const) {
    describe(`invalid ${location} config`, () => {
      async function writeBadConfig(cwd: string, value: unknown): Promise<string> {
        const path = location === "global" ? globalConfigPath() : projectConfigPath(cwd);
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
      ]) {
        it(`invalid ${JSON.stringify(invalid)} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, { ...configBody(60), ...invalid });

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /summaryMaxTokens must be a positive integer|thinkingLevel must be one of/,
          );
        });
      }
    });
  }

  describe("threshold environment overrides", () => {
    it("env threshold overrides file config", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), configBody(60));
      process.env[SOFT_THRESHOLD_ENV_VAR] = "5";

      assert.deepEqual(
        await loadConfig(context(cwd)),
        expectedConfig({
          prepareThresholdPercent: 5,
          summarizerModel: { provider: "", id: "" },
        }),
      );
    });

    it("empty env values are ignored", async (t) => {
      const cwd = await temporaryCwd(t);
      process.env[SOFT_THRESHOLD_ENV_VAR] = "  ";

      const config = await loadConfig(context(cwd));
      assert.equal(config.prepareThresholdPercent, DEFAULT_PREPARE_THRESHOLD_PERCENT);
    });

    for (const value of ["lots", "NaN", "0", "100", "-3"]) {
      it(`invalid soft env ${JSON.stringify(value)} throws naming the variable`, async (t) => {
        const cwd = await temporaryCwd(t);
        process.env[SOFT_THRESHOLD_ENV_VAR] = value;

        await assert.rejects(loadConfig(context(cwd)), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(SOFT_THRESHOLD_ENV_VAR));
          return true;
        });
      });
    }
  });

  describe("isAtOrAbovePrepare / isBelowPrepare", () => {
    it("compares the reported percent against the prepare threshold", () => {
      assert.equal(isAtOrAbovePrepare({ percent: 5 }, { prepareThresholdPercent: 5 }), true);
      assert.equal(isAtOrAbovePrepare({ percent: 4.9 }, { prepareThresholdPercent: 5 }), false);
      assert.equal(isBelowPrepare({ percent: 5 }, { prepareThresholdPercent: 5 }), false);
      assert.equal(isBelowPrepare({ percent: 4.9 }, { prepareThresholdPercent: 5 }), true);
    });

    it("treats missing percent as below the threshold", () => {
      assert.equal(isAtOrAbovePrepare({}, { prepareThresholdPercent: 60 }), false);
      assert.equal(isAtOrAbovePrepare({ percent: null }, { prepareThresholdPercent: 60 }), false);
      assert.equal(isBelowPrepare({ percent: null }, { prepareThresholdPercent: 60 }), true);
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

      assert.deepEqual(
        await loadConfig(context(cwd)),
        expectedConfig({
          prepareThresholdPercent: 60,
          summarizerModel: { provider: "provider", id: "model" },
          verificationModel: { provider: "verify-provider", id: "org/verifier:strong" },
          verificationThinkingLevel: "high",
        }),
      );
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

  describe("threshold aliases and ordering", () => {
    it("loads the legacy soft key as the prepare threshold", async (t) => {
      const cwd = await temporaryCwd(t);
      await writeJson(projectConfigPath(cwd), {
        softCompactThresholdPercent: 55,
        summarizerModel: { provider: "", id: "" },
      });

      const config = await loadConfig(context(cwd));
      assert.equal(config.prepareThresholdPercent, 55);
    });

    it("rejects the removed hard/swap keys", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, { ...configBody(60), hardCompactThresholdPercent: 75 });

      await assertLoadError(loadConfig(context(cwd)), path, /hardCompactThresholdPercent/);
    });

    it("conflicting canonical and alias values throw", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, {
        prepareThresholdPercent: 60,
        softCompactThresholdPercent: 50,
        summarizerModel: { provider: "", id: "" },
      });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /and legacy softCompactThresholdPercent conflict/,
      );
    });

    it("an explicit native threshold at or below prepare throws", async (t) => {
      const cwd = await temporaryCwd(t);
      const path = projectConfigPath(cwd);
      await writeJson(path, { ...configBody(60), nativeFallbackThresholdPercent: 55 });

      await assertLoadError(
        loadConfig(context(cwd)),
        path,
        /nativeFallbackThresholdPercent must be greater than prepareThresholdPercent/,
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

      assert.deepEqual(
        await loadConfig(context(cwd)),
        expectedConfig({
          nativeFallbackThresholdPercent: 95,
          idleCompact: { enabled: false, minimumTokens: 5000 },
          recentTurns: 12,
          manualCompactMode: "native",
        }),
      );
    });
  });
});

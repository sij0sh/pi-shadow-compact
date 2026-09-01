import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
  defaultConfig,
  loadConfig,
} from "../src/config.js";

const CONFIG_FILE = "shadow-compact.json";

let savedAgentDirEnv: string | undefined;
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
  agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-compact-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (savedAgentDirEnv === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
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
      summarizerModel: { provider: "global-provider", id: "global-model" },
    });
  });

  it("project file overrides the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42,
      summarizerModel: { provider: "project-provider", id: "project-model" },
    });
  });

  it("project file overrides the global file wholesale", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42));

    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42,
      summarizerModel: { provider: "", id: "" },
    });
  });

  it("untrusted project ignores the project file but still applies the global file", async (t) => {
    const cwd = await temporaryCwd(t);
    await writeJson(globalConfigPath(), configBody(80, "global-provider", "global-model"));
    await writeJson(projectConfigPath(cwd), configBody(42, "project-provider", "project-model"));

    assert.deepEqual(await loadConfig(context(cwd, false)), {
      softCompactThresholdPercent: 80,
      summarizerModel: { provider: "global-provider", id: "global-model" },
    });
  });

  it("trims model fields and accepts both blank or both set", async (t) => {
    const cwd = await temporaryCwd(t);

    await writeJson(projectConfigPath(cwd), configBody(42.5, " provider ", " model "));
    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42.5,
      summarizerModel: { provider: "provider", id: "model" },
    });

    await writeJson(projectConfigPath(cwd), configBody(42.5));
    assert.deepEqual(await loadConfig(context(cwd)), {
      softCompactThresholdPercent: 42.5,
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
      summarizerModel: { provider: "provider", id: "model" },
      summaryMaxTokens: 32_768,
      summarizerContextTokens: 1_000_000,
      thinkingLevel: "high",
    });
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
      ]) {
        it(`invalid ${JSON.stringify(invalid)} throws with the file path`, async (t) => {
          const cwd = await temporaryCwd(t);
          const path = await writeBadConfig(cwd, { ...configBody(60), ...invalid });

          await assertLoadError(
            loadConfig(context(cwd)),
            path,
            /summaryMaxTokens must be a positive integer|summarizerContextTokens must be a positive integer|thinkingLevel must be one of/,
          );
        });
      }

    });
  }
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT = 60;
export const DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT = 80;

export const SOFT_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_SOFT_THRESHOLD_PERCENT";
export const HARD_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_HARD_THRESHOLD_PERCENT";
/**
 * Benchmark-only absolute soft trigger (env-only, never a file setting).
 * When set, the soft trigger compares raw context tokens instead of
 * `usage.percent`, so threshold sweeps mean the same thing on every model
 * window. Percent env/file/defaults remain the fallback when this is unset
 * or the runtime reports no token count.
 *
 * Named `..._ABS` (not fix.md's suggested `..._TOKENS`) because the roast
 * harness rejects literal `_TOKENS`-suffixed env values as credential-like;
 * per-variant literals are the only way to give twin arms different values.
 */
export const SOFT_THRESHOLD_ABS_ENV_VAR = "SHADOW_COMPACT_SOFT_THRESHOLD_ABS";
export const ROLLING_ENV_VAR = "SHADOW_COMPACT_ROLLING";
export const TARGET_TAIL_ENV_VAR = "SHADOW_COMPACT_TARGET_TAIL_PERCENT";
export const MODE_ENV_VAR = "SHADOW_COMPACT_MODE";
/**
 * Benchmark-only summarizer overrides (all default-off). Provider and ID are
 * separate vars — never one combined string — because IDs can contain `/`
 * or `:`. File behavior is byte-identical when all three are unset/blank.
 */
export const SUMMARIZER_PROVIDER_ENV_VAR = "SHADOW_COMPACT_SUMMARIZER_PROVIDER";
export const SUMMARIZER_ID_ENV_VAR = "SHADOW_COMPACT_SUMMARIZER_ID";
export const SUMMARIZER_THINKING_ENV_VAR = "SHADOW_COMPACT_SUMMARIZER_THINKING";
/**
 * Benchmark-only verifier overrides (all default-off). Same split-var shape
 * as the summarizer knobs: provider and ID are separate because IDs can
 * contain `/` or `:`. When the pair is unset the verifier reuses the
 * summarizer model; thinking falls back to `thinkingLevel` when unset.
 */
export const VERIFIER_PROVIDER_ENV_VAR = "SHADOW_COMPACT_VERIFIER_PROVIDER";
export const VERIFIER_ID_ENV_VAR = "SHADOW_COMPACT_VERIFIER_ID";
export const VERIFIER_THINKING_ENV_VAR = "SHADOW_COMPACT_VERIFIER_THINKING";

/**
 * Rolling refresh lets an already-published checkpoint be replaced while it
 * serves. Set to "0"/"false"/"no"/"off" for legacy single-shot behavior (one
 * useful mid-run summary per session), which is the control condition for
 * Control-vs-Single-vs-Rolling experiments.
 */
/**
 * Shared env-flag reader: trimmed lowercase value, or undefined when
 * unset/blank. Callers keep their own truth tables (opt-out vs opt-in
 * flags differ by design); only the read-and-normalize step is shared.
 */
export function readEnvFlag(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim().toLowerCase();
}

export function isRollingEnabled(): boolean {
  const value = readEnvFlag(ROLLING_ENV_VAR);
  if (value === undefined) return true;
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

/**
 * Observe-only instrumented control: turn_end emits turn_usage telemetry and
 * everything else (summaries, swaps, compactions, cache reads) stays disabled.
 * Gives context-AUC a control baseline without perturbing the working set.
 */
export function isObserveMode(): boolean {
  return readEnvFlag(MODE_ENV_VAR) === "observe";
}

/**
 * Derives Shadow's retained-tail budget from the experimental tail knob.
 *
 * Keeps approximately targetTailPercent of the session model's context window
 * as verbatim recent history after the checkpoint boundary. Capped at Pi's
 * keepRecentTokens so an absent, tiny-window, or oversized target leaves
 * production behavior unchanged.
 */
export function resolveKeepRecentTokens(
  piKeepRecentTokens: number,
  targetTailPercent: number | undefined,
  contextWindow: number | undefined,
): number {
  if (targetTailPercent === undefined || contextWindow === undefined) return piKeepRecentTokens;
  return Math.min(piKeepRecentTokens, Math.floor((contextWindow * targetTailPercent) / 100));
}

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export interface ShadowCompactConfig {
  softCompactThresholdPercent: number;
  hardCompactThresholdPercent: number;
  /** Benchmark-only absolute soft trigger in tokens (env-only, never from file). */
  softCompactThresholdTokens?: number;
  /** Experimental harness knob (env-only): retained-tail budget as context-window percent. */
  targetTailPercent?: number;
  summarizerModel: {
    provider: string;
    id: string;
  };
  summaryMaxTokens?: number;
  summarizerContextTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
  /**
   * Second-pass verification model (verifier.md). Optional so existing
   * configs keep loading unchanged: when absent or blank the verifier
   * reuses the resolved summarizer model.
   */
  verificationModel?: {
    provider: string;
    id: string;
  };
  /** Verifier reasoning level; falls back to `thinkingLevel` when unset. */
  verificationThinkingLevel?: ModelThinkingLevel;
}

export function defaultConfig(): ShadowCompactConfig {
  return {
    softCompactThresholdPercent: DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
    hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
    summarizerModel: { provider: "", id: "" },
  };
}

export async function loadConfig(ctx: ExtensionContext): Promise<ShadowCompactConfig> {
  let config = defaultConfig();
  const globalPath = join(getAgentDir(), "shadow-compact.json");
  const globalSource = await readOptional(globalPath);
  if (globalSource !== undefined) {
    config = parseConfig(globalSource, globalPath);
  }

  if (ctx.isProjectTrusted()) {
    const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "shadow-compact.json");
    const projectSource = await readOptional(projectPath);
    if (projectSource !== undefined) {
      config = parseConfig(projectSource, projectPath);
    }
  }
  return applyEnvOverrides(config);
}

/**
 * Trimmed raw env value, or undefined when unset/blank. All env parsers
 * share this so empty-vs-missing handling cannot drift between knobs.
 */
function rawEnv(name: string): { trimmed: string; raw: string } | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return { trimmed: raw.trim(), raw };
}

function parseEnvThreshold(name: string): number | undefined {
  const env = rawEnv(name);
  if (env === undefined) return undefined;
  const value = Number(env.trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number between 1 and 99, got ${JSON.stringify(env.raw)}`);
  }
  if (value < 1 || value > 99) {
    throw new Error(`${name} must be between 1 and 99, got ${JSON.stringify(env.raw)}`);
  }
  return value;
}

function parseEnvTokenCount(name: string): number | undefined {
  const env = rawEnv(name);
  if (env === undefined) return undefined;
  const value = Number(env.trimmed);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer token count, got ${JSON.stringify(env.raw)}`);
  }
  return value;
}

function parseOptionalString(name: string): string | undefined {
  return rawEnv(name)?.trimmed;
}

function parseEnvThinking(name: string): ModelThinkingLevel | undefined {
  const env = rawEnv(name);
  if (env === undefined) return undefined;
  if (!THINKING_LEVELS.includes(env.trimmed as ModelThinkingLevel)) {
    throw new Error(`${name} must be one of: ${THINKING_LEVELS.join(", ")}, got ${JSON.stringify(env.raw)}`);
  }
  return env.trimmed as ModelThinkingLevel;
}

/**
 * Resolved soft-trigger comparison. An absolute token threshold wins when
 * set and the runtime reports a token count; otherwise the percent
 * threshold applies. Single abstraction for both the initial trigger and
 * the rolling below-threshold re-arm so hysteresis stays consistent.
 */
export interface SoftThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

export function isAtOrAboveSoft(
  usage: SoftThresholdUsage,
  config: Pick<ShadowCompactConfig, "softCompactThresholdPercent" | "softCompactThresholdTokens">,
): boolean {
  if (
    config.softCompactThresholdTokens !== undefined &&
    usage.tokens !== undefined &&
    usage.tokens !== null
  ) {
    return usage.tokens >= config.softCompactThresholdTokens;
  }
  return (
    usage.percent !== undefined &&
    usage.percent !== null &&
    usage.percent >= config.softCompactThresholdPercent
  );
}

export function isBelowSoft(
  usage: SoftThresholdUsage,
  config: Pick<ShadowCompactConfig, "softCompactThresholdPercent" | "softCompactThresholdTokens">,
): boolean {
  return !isAtOrAboveSoft(usage, config);
}

function assertEnvPair(
  first: string | undefined,
  firstVar: string,
  second: string | undefined,
  secondVar: string,
): void {
  if ((first !== undefined) !== (second !== undefined)) {
    throw new Error(`${firstVar} and ${secondVar} must both be set or both be unset`);
  }
}

export function applyEnvOverrides(config: ShadowCompactConfig): ShadowCompactConfig {
  const soft = parseEnvThreshold(SOFT_THRESHOLD_ENV_VAR);
  const hard = parseEnvThreshold(HARD_THRESHOLD_ENV_VAR);
  const softTokens = parseEnvTokenCount(SOFT_THRESHOLD_ABS_ENV_VAR);
  const targetTail = parseEnvThreshold(TARGET_TAIL_ENV_VAR);
  const summarizerProvider = parseOptionalString(SUMMARIZER_PROVIDER_ENV_VAR);
  const summarizerId = parseOptionalString(SUMMARIZER_ID_ENV_VAR);
  assertEnvPair(summarizerProvider, SUMMARIZER_PROVIDER_ENV_VAR, summarizerId, SUMMARIZER_ID_ENV_VAR);
  const summarizerThinking = parseEnvThinking(SUMMARIZER_THINKING_ENV_VAR);
  const verifierProvider = parseOptionalString(VERIFIER_PROVIDER_ENV_VAR);
  const verifierId = parseOptionalString(VERIFIER_ID_ENV_VAR);
  assertEnvPair(verifierProvider, VERIFIER_PROVIDER_ENV_VAR, verifierId, VERIFIER_ID_ENV_VAR);
  const verifierThinking = parseEnvThinking(VERIFIER_THINKING_ENV_VAR);
  const merged: ShadowCompactConfig = {
    ...config,
    ...(soft !== undefined ? { softCompactThresholdPercent: soft } : {}),
    ...(hard !== undefined ? { hardCompactThresholdPercent: hard } : {}),
    ...(softTokens !== undefined ? { softCompactThresholdTokens: softTokens } : {}),
    ...(targetTail !== undefined ? { targetTailPercent: targetTail } : {}),
    ...(summarizerProvider !== undefined && summarizerId !== undefined
      ? { summarizerModel: { provider: summarizerProvider, id: summarizerId } }
      : {}),
    ...(summarizerThinking !== undefined ? { thinkingLevel: summarizerThinking } : {}),
    ...(verifierProvider !== undefined && verifierId !== undefined
      ? { verificationModel: { provider: verifierProvider, id: verifierId } }
      : {}),
    ...(verifierThinking !== undefined ? { verificationThinkingLevel: verifierThinking } : {}),
  };
  // File-only pairs keep their existing validation: an explicit file hard threshold
  // must exceed soft, while an implicit default hard may equal it. The merged
  // check below applies only when env moves at least one threshold, so file
  // behavior stays byte-identical and env misuse still fails fast.
  if (
    (soft !== undefined || hard !== undefined) &&
    merged.hardCompactThresholdPercent <= merged.softCompactThresholdPercent
  ) {
    throw new Error(
      `${HARD_THRESHOLD_ENV_VAR} must be greater than the soft threshold ` +
        `(${merged.softCompactThresholdPercent}), got ${merged.hardCompactThresholdPercent}`,
    );
  }
  return merged;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${String(error)}`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  scope: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(scope ? `${path} ${scope} has unknown key: ${key}` : `${path} has unknown key: ${key}`);
    }
  }
}

interface ModelPair {
  provider: string;
  id: string;
}

function parseModelPair(value: unknown, path: string, key: string): ModelPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} ${key} must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertKnownKeys(record, ["provider", "id"], path, key);
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (record.provider !== undefined && typeof record.provider !== "string") {
    throw new Error(`${path} ${key}.provider must be a string`);
  }
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new Error(`${path} ${key}.id must be a string`);
  }
  if ((provider.length > 0) !== (id.length > 0)) {
    throw new Error(`${path} ${key}.provider and .id must both be blank or both be set`);
  }
  return { provider, id };
}

function parsePositiveInt(value: unknown, path: string, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} ${key} must be a positive integer`);
  }
  return value;
}

function parseThinkingLevel(value: unknown, path: string, key: string): ModelThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${path} ${key} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ModelThinkingLevel;
}

export function parseConfig(source: string, path: string): ShadowCompactConfig {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  assertKnownKeys(
    record,
    [
      "softCompactThresholdPercent",
      "hardCompactThresholdPercent",
      "summarizerModel",
      "summaryMaxTokens",
      "summarizerContextTokens",
      "thinkingLevel",
      "verificationModel",
      "verificationThinkingLevel",
    ],
    path,
    "",
  );

  const rawThreshold = record.softCompactThresholdPercent;
  if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold)) {
    throw new Error(`${path} softCompactThresholdPercent must be a number`);
  }
  if (rawThreshold < 1 || rawThreshold > 99) {
    throw new Error(`${path} softCompactThresholdPercent must be between 1 and 99`);
  }

  const { provider, id } = parseModelPair(record.summarizerModel, path, "summarizerModel");

  const config: ShadowCompactConfig = {
    softCompactThresholdPercent: rawThreshold,
    hardCompactThresholdPercent: DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
    summarizerModel: { provider, id },
  };

  const rawHardThreshold = record.hardCompactThresholdPercent;
  if (rawHardThreshold !== undefined) {
    if (typeof rawHardThreshold !== "number" || !Number.isFinite(rawHardThreshold)) {
      throw new Error(`${path} hardCompactThresholdPercent must be a number`);
    }
    if (rawHardThreshold < 1 || rawHardThreshold > 99) {
      throw new Error(`${path} hardCompactThresholdPercent must be between 1 and 99`);
    }
    if (rawHardThreshold <= config.softCompactThresholdPercent) {
      throw new Error(
        `${path} hardCompactThresholdPercent must be greater than softCompactThresholdPercent`,
      );
    }
    config.hardCompactThresholdPercent = rawHardThreshold;
  }

  const maxTokens = parsePositiveInt(record.summaryMaxTokens, path, "summaryMaxTokens");
  if (maxTokens !== undefined) config.summaryMaxTokens = maxTokens;

  const contextTokens = parsePositiveInt(record.summarizerContextTokens, path, "summarizerContextTokens");
  if (contextTokens !== undefined) config.summarizerContextTokens = contextTokens;

  const thinkingLevel = parseThinkingLevel(record.thinkingLevel, path, "thinkingLevel");
  if (thinkingLevel !== undefined) config.thinkingLevel = thinkingLevel;

  if (record.verificationModel !== undefined) {
    config.verificationModel = parseModelPair(record.verificationModel, path, "verificationModel");
  }

  const verificationThinkingLevel = parseThinkingLevel(
    record.verificationThinkingLevel,
    path,
    "verificationThinkingLevel",
  );
  if (verificationThinkingLevel !== undefined) {
    config.verificationThinkingLevel = verificationThinkingLevel;
  }

  return config;
}

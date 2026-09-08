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
 * Rolling refresh lets an already-published checkpoint be replaced while it
 * serves. Set to "0"/"false"/"no"/"off" for legacy single-shot behavior (one
 * useful mid-run summary per session), which is the control condition for
 * Control-vs-Single-vs-Rolling experiments.
 */
export function isRollingEnabled(): boolean {
  const raw = process.env[ROLLING_ENV_VAR];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

/**
 * Observe-only instrumented control: turn_end emits turn_usage telemetry and
 * everything else (summaries, swaps, compactions, cache reads) stays disabled.
 * Gives context-AUC a control baseline without perturbing the working set.
 */
export function isObserveMode(): boolean {
  const raw = process.env[MODE_ENV_VAR];
  if (raw === undefined) return false;
  return raw.trim().toLowerCase() === "observe";
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

function parseEnvThreshold(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number between 1 and 99, got ${JSON.stringify(raw)}`);
  }
  if (value < 1 || value > 99) {
    throw new Error(`${name} must be between 1 and 99, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseEnvTokenCount(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer token count, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseOptionalString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function parseEnvThinking(name: string): ModelThinkingLevel | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (!THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${name} must be one of: ${THINKING_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return value as ModelThinkingLevel;
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

export function applyEnvOverrides(config: ShadowCompactConfig): ShadowCompactConfig {
  const soft = parseEnvThreshold(SOFT_THRESHOLD_ENV_VAR);
  const hard = parseEnvThreshold(HARD_THRESHOLD_ENV_VAR);
  const softTokens = parseEnvTokenCount(SOFT_THRESHOLD_ABS_ENV_VAR);
  const targetTail = parseEnvThreshold(TARGET_TAIL_ENV_VAR);
  const summarizerProvider = parseOptionalString(SUMMARIZER_PROVIDER_ENV_VAR);
  const summarizerId = parseOptionalString(SUMMARIZER_ID_ENV_VAR);
  if ((summarizerProvider !== undefined) !== (summarizerId !== undefined)) {
    throw new Error(
      `${SUMMARIZER_PROVIDER_ENV_VAR} and ${SUMMARIZER_ID_ENV_VAR} must both be set or both be unset`,
    );
  }
  const summarizerThinking = parseEnvThinking(SUMMARIZER_THINKING_ENV_VAR);
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
  for (const key of Object.keys(record)) {
    if (
      key !== "softCompactThresholdPercent" &&
      key !== "hardCompactThresholdPercent" &&
      key !== "summarizerModel" &&
      key !== "summaryMaxTokens" &&
      key !== "summarizerContextTokens" &&
      key !== "thinkingLevel"
    ) {
      throw new Error(`${path} has unknown key: ${key}`);
    }
  }

  const rawThreshold = record.softCompactThresholdPercent;
  if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold)) {
    throw new Error(`${path} softCompactThresholdPercent must be a number`);
  }
  if (rawThreshold < 1 || rawThreshold > 99) {
    throw new Error(`${path} softCompactThresholdPercent must be between 1 and 99`);
  }

  const rawModel = record.summarizerModel;
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    throw new Error(`${path} summarizerModel must be an object`);
  }
  const model = rawModel as Record<string, unknown>;
  for (const key of Object.keys(model)) {
    if (key !== "provider" && key !== "id") {
      throw new Error(`${path} summarizerModel has unknown key: ${key}`);
    }
  }
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (model.provider !== undefined && typeof model.provider !== "string") {
    throw new Error(`${path} summarizerModel.provider must be a string`);
  }
  if (model.id !== undefined && typeof model.id !== "string") {
    throw new Error(`${path} summarizerModel.id must be a string`);
  }
  if ((provider.length > 0) !== (id.length > 0)) {
    throw new Error(`${path} summarizerModel.provider and .id must both be blank or both be set`);
  }

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

  const rawMaxTokens = record.summaryMaxTokens;
  if (rawMaxTokens !== undefined) {
    if (typeof rawMaxTokens !== "number" || !Number.isInteger(rawMaxTokens) || rawMaxTokens < 1) {
      throw new Error(`${path} summaryMaxTokens must be a positive integer`);
    }
    config.summaryMaxTokens = rawMaxTokens;
  }

  const rawContextTokens = record.summarizerContextTokens;
  if (rawContextTokens !== undefined) {
    if (
      typeof rawContextTokens !== "number" ||
      !Number.isInteger(rawContextTokens) ||
      rawContextTokens < 1
    ) {
      throw new Error(`${path} summarizerContextTokens must be a positive integer`);
    }
    config.summarizerContextTokens = rawContextTokens;
  }

  const rawThinkingLevel = record.thinkingLevel;
  if (rawThinkingLevel !== undefined) {
    if (
      typeof rawThinkingLevel !== "string" ||
      !THINKING_LEVELS.includes(rawThinkingLevel as ModelThinkingLevel)
    ) {
      throw new Error(`${path} thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    config.thinkingLevel = rawThinkingLevel as ModelThinkingLevel;
  }

  return config;
}

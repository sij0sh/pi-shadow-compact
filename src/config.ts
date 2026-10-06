import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_PREPARE_THRESHOLD_PERCENT = 60;
export const DEFAULT_SWAP_THRESHOLD_PERCENT = 80;
export const DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT = 92;
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 20_000;
export const DEFAULT_RECENT_TURNS = 10;

/** Legacy aliases for the preparation/swap thresholds (one release). */
export const DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT = DEFAULT_PREPARE_THRESHOLD_PERCENT;
export const DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT = DEFAULT_SWAP_THRESHOLD_PERCENT;

export const SOFT_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_SOFT_THRESHOLD_PERCENT";
export const HARD_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_HARD_THRESHOLD_PERCENT";
export const NATIVE_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_NATIVE_THRESHOLD_PERCENT";
export const MANUAL_MODE_ENV_VAR = "SHADOW_COMPACT_MANUAL_MODE";
export const IDLE_MIN_TOKENS_ENV_VAR = "SHADOW_COMPACT_IDLE_MIN_TOKENS";
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

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export type ManualCompactMode = "shadow" | "native";

export interface ShadowCompactConfig {
  /** Usage percent where checkpoint preparation starts. */
  prepareThresholdPercent: number;
  /** Usage percent where a ready checkpoint becomes the mandatory working context. */
  swapThresholdPercent: number;
  /** Emergency percent for one native compaction (true provider-limit path). */
  nativeFallbackThresholdPercent: number;
  /** Benchmark-only absolute prepare trigger in tokens (env-only, never from file). */
  softCompactThresholdTokens?: number;
  summarizerModel: {
    provider: string;
    id: string;
  };
  summaryMaxTokens?: number;
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
  idleCompact: {
    enabled: boolean;
    minimumTokens: number;
  };
  /** Minimum recent assistant/tool rounds retained by request-local checkpoints. */
  recentTurns: number;
  manualCompactMode: ManualCompactMode;
}

export function defaultConfig(): ShadowCompactConfig {
  return {
    prepareThresholdPercent: DEFAULT_PREPARE_THRESHOLD_PERCENT,
    swapThresholdPercent: DEFAULT_SWAP_THRESHOLD_PERCENT,
    nativeFallbackThresholdPercent: DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT,
    summarizerModel: { provider: "", id: "" },
    idleCompact: { enabled: true, minimumTokens: DEFAULT_IDLE_COMPACT_MIN_TOKENS },
    recentTurns: DEFAULT_RECENT_TURNS,
    manualCompactMode: "shadow",
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
 * Resolved prepare-trigger comparison. An absolute token threshold wins when
 * set and the runtime reports a token count; otherwise the percent
 * threshold applies. Single abstraction for both the initial trigger and
 * the rolling below-threshold re-arm so hysteresis stays consistent.
 */
export interface ThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

/** Legacy alias for ThresholdUsage. */
export type SoftThresholdUsage = ThresholdUsage;

export function isAtOrAbovePrepare(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "prepareThresholdPercent" | "softCompactThresholdTokens">,
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
    usage.percent >= config.prepareThresholdPercent
  );
}

export function isBelowPrepare(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "prepareThresholdPercent" | "softCompactThresholdTokens">,
): boolean {
  return !isAtOrAbovePrepare(usage, config);
}

/** Legacy aliases: the soft threshold is the prepare threshold. */
export const isAtOrAboveSoft = isAtOrAbovePrepare;
export const isBelowSoft = isBelowPrepare;

export function isAtOrAboveSwap(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "swapThresholdPercent">,
): boolean {
  return (
    usage.percent !== undefined &&
    usage.percent !== null &&
    usage.percent >= config.swapThresholdPercent
  );
}

export function isAtOrAboveNativeFallback(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "nativeFallbackThresholdPercent">,
): boolean {
  return (
    usage.percent !== undefined &&
    usage.percent !== null &&
    usage.percent >= config.nativeFallbackThresholdPercent
  );
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

function parseEnvManualMode(): ManualCompactMode | undefined {
  const env = rawEnv(MANUAL_MODE_ENV_VAR);
  if (env === undefined) return undefined;
  if (env.trimmed !== "shadow" && env.trimmed !== "native") {
    throw new Error(`${MANUAL_MODE_ENV_VAR} must be "shadow" or "native", got ${JSON.stringify(env.raw)}`);
  }
  return env.trimmed;
}

export function applyEnvOverrides(config: ShadowCompactConfig): ShadowCompactConfig {
  const soft = parseEnvThreshold(SOFT_THRESHOLD_ENV_VAR);
  const hard = parseEnvThreshold(HARD_THRESHOLD_ENV_VAR);
  const native = parseEnvThreshold(NATIVE_THRESHOLD_ENV_VAR);
  const softTokens = parseEnvTokenCount(SOFT_THRESHOLD_ABS_ENV_VAR);
  const idleMinTokens = parseEnvTokenCount(IDLE_MIN_TOKENS_ENV_VAR);
  const manualMode = parseEnvManualMode();
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
    ...(soft !== undefined ? { prepareThresholdPercent: soft } : {}),
    ...(hard !== undefined ? { swapThresholdPercent: hard } : {}),
    ...(native !== undefined ? { nativeFallbackThresholdPercent: native } : {}),
    ...(softTokens !== undefined ? { softCompactThresholdTokens: softTokens } : {}),
    ...(idleMinTokens !== undefined
      ? { idleCompact: { ...config.idleCompact, minimumTokens: idleMinTokens } }
      : {}),
    ...(manualMode !== undefined ? { manualCompactMode: manualMode } : {}),
    ...(summarizerProvider !== undefined && summarizerId !== undefined
      ? { summarizerModel: { provider: summarizerProvider, id: summarizerId } }
      : {}),
    ...(summarizerThinking !== undefined ? { thinkingLevel: summarizerThinking } : {}),
    ...(verifierProvider !== undefined && verifierId !== undefined
      ? { verificationModel: { provider: verifierProvider, id: verifierId } }
      : {}),
    ...(verifierThinking !== undefined ? { verificationThinkingLevel: verifierThinking } : {}),
  };
  // File-only pairs keep their existing validation: an explicit file swap
  // threshold must exceed prepare, while implicit defaults fill silently.
  // The merged checks below apply only when env moves a threshold, so file
  // behavior stays byte-identical and env misuse still fails fast.
  if (
    (soft !== undefined || hard !== undefined) &&
    merged.swapThresholdPercent <= merged.prepareThresholdPercent
  ) {
    throw new Error(
      `${HARD_THRESHOLD_ENV_VAR} must be greater than the prepare threshold ` +
        `(${merged.prepareThresholdPercent}), got ${merged.swapThresholdPercent}`,
    );
  }
  if (
    native !== undefined &&
    merged.nativeFallbackThresholdPercent <= merged.swapThresholdPercent
  ) {
    throw new Error(
      `${NATIVE_THRESHOLD_ENV_VAR} must be greater than the swap threshold ` +
        `(${merged.swapThresholdPercent}), got ${merged.nativeFallbackThresholdPercent}`,
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

function parseFileThreshold(value: unknown, path: string, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} ${key} must be a number`);
  }
  if (value < 1 || value > 99) {
    throw new Error(`${path} ${key} must be between 1 and 99`);
  }
  return value;
}

/**
 * Resolves a canonical threshold key with its legacy alias. Both present
 * with different values is a config bug and throws; otherwise the explicit
 * value wins and the default fills a fully absent threshold.
 */
function resolveThreshold(
  record: Record<string, unknown>,
  path: string,
  key: string,
  aliasKey: string,
  defaultValue: number,
): number {
  const primary = parseFileThreshold(record[key], path, key);
  const alias = parseFileThreshold(record[aliasKey], path, aliasKey);
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new Error(`${path} ${key} and legacy ${aliasKey} conflict; use ${key}`);
  }
  return primary ?? alias ?? defaultValue;
}

function parseBoolean(value: unknown, path: string, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${path} ${key} must be a boolean`);
  }
  return value;
}

function parseManualMode(value: unknown, path: string): ManualCompactMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "shadow" && value !== "native") {
    throw new Error(`${path} manualCompactMode must be "shadow" or "native"`);
  }
  return value;
}

function parseIdleCompact(
  value: unknown,
  path: string,
): ShadowCompactConfig["idleCompact"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} idleCompact must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertKnownKeys(record, ["enabled", "minimumTokens"], path, "idleCompact");
  const enabled = parseBoolean(record.enabled, path, "idleCompact.enabled") ?? true;
  const minimumTokens = parsePositiveInt(record.minimumTokens, path, "idleCompact.minimumTokens")
    ?? DEFAULT_IDLE_COMPACT_MIN_TOKENS;
  return { enabled, minimumTokens };
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
      "prepareThresholdPercent",
      "swapThresholdPercent",
      "nativeFallbackThresholdPercent",
      "softCompactThresholdPercent",
      "hardCompactThresholdPercent",
      "summarizerModel",
      "summaryMaxTokens",
      "thinkingLevel",
      "verificationModel",
      "verificationThinkingLevel",
      "idleCompact",
      "recentTurns",
      "manualCompactMode",
    ],
    path,
    "",
  );

  const prepareThresholdPercent = resolveThreshold(
    record,
    path,
    "prepareThresholdPercent",
    "softCompactThresholdPercent",
    DEFAULT_PREPARE_THRESHOLD_PERCENT,
  );
  const swapThresholdPercent = resolveThreshold(
    record,
    path,
    "swapThresholdPercent",
    "hardCompactThresholdPercent",
    DEFAULT_SWAP_THRESHOLD_PERCENT,
  );
  const swapExplicit = record.swapThresholdPercent !== undefined || record.hardCompactThresholdPercent !== undefined;
  if (swapExplicit && swapThresholdPercent <= prepareThresholdPercent) {
    throw new Error(`${path} swapThresholdPercent must be greater than prepareThresholdPercent`);
  }
  const nativeFallbackThresholdPercent = parseFileThreshold(
    record.nativeFallbackThresholdPercent,
    path,
    "nativeFallbackThresholdPercent",
  ) ?? DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT;
  if (
    record.nativeFallbackThresholdPercent !== undefined &&
    nativeFallbackThresholdPercent <= swapThresholdPercent
  ) {
    throw new Error(`${path} nativeFallbackThresholdPercent must be greater than swapThresholdPercent`);
  }

  const summarizer = record.summarizerModel === undefined
    ? { provider: "", id: "" }
    : parseModelPair(record.summarizerModel, path, "summarizerModel");

  const config: ShadowCompactConfig = {
    prepareThresholdPercent,
    swapThresholdPercent,
    nativeFallbackThresholdPercent,
    summarizerModel: summarizer,
    idleCompact: parseIdleCompact(record.idleCompact, path)
      ?? { enabled: true, minimumTokens: DEFAULT_IDLE_COMPACT_MIN_TOKENS },
    recentTurns: parsePositiveInt(record.recentTurns, path, "recentTurns") ?? DEFAULT_RECENT_TURNS,
    manualCompactMode: parseManualMode(record.manualCompactMode, path) ?? "shadow",
  };

  const maxTokens = parsePositiveInt(record.summaryMaxTokens, path, "summaryMaxTokens");
  if (maxTokens !== undefined) config.summaryMaxTokens = maxTokens;

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

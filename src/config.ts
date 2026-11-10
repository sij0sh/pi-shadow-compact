import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_PREPARE_THRESHOLD_PERCENT = 60;
export const DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT = 92;
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 20_000;
export const DEFAULT_RECENT_TURNS = 10;

export const SOFT_THRESHOLD_ENV_VAR = "SHADOW_COMPACT_SOFT_THRESHOLD_PERCENT";
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

export interface ModelPair {
  provider: string;
  id: string;
}

export interface ShadowCompactConfig {
  /** Usage percent where checkpoint preparation starts. */
  prepareThresholdPercent: number;
  /** Emergency percent for one native compaction (true provider-limit path). */
  nativeFallbackThresholdPercent: number;
  /** Benchmark-only absolute prepare trigger in tokens (env-only, never from file). */
  softCompactThresholdTokens?: number;
  summarizerModel: ModelPair;
  summaryMaxTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
  /**
   * Second-pass verification model (verifier.md). Optional so existing
   * configs keep loading unchanged: when absent or blank the verifier
   * reuses the resolved summarizer model.
   */
  verificationModel?: ModelPair;
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
 * One validation surface for every setting, whatever its source.
 *
 * A source adapter only does what only it can do — JSON parsing and unknown-key
 * checks for files, string/blank normalization for env vars — and hands the raw
 * values here. Ranges, kinds, model-pair completeness, and threshold ordering
 * are stated exactly once.
 */
interface RawSettings {
  prepareThresholdPercent?: unknown;
  nativeFallbackThresholdPercent?: unknown;
  summarizerModel?: unknown;
  summaryMaxTokens?: unknown;
  thinkingLevel?: unknown;
  verificationModel?: unknown;
  verificationThinkingLevel?: unknown;
  idleCompact?: unknown;
  recentTurns?: unknown;
  manualCompactMode?: unknown;
}

interface Settings extends Partial<Omit<ShadowCompactConfig, "idleCompact">> {
  idleCompact?: Partial<ShadowCompactConfig["idleCompact"]>;
}

/** Human name of a setting in the source being read (file path + key, or env var). */
type Label = (key: keyof RawSettings) => string;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown key: ${key}`);
  }
}

function expectPercent(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  if (value < 1 || value > 99) {
    throw new Error(`${label} must be between 1 and 99`);
  }
  return value;
}

function expectPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectThinkingLevel(value: unknown, label: string): ModelThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ModelThinkingLevel;
}

function expectManualMode(value: unknown, label: string): ManualCompactMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "shadow" && value !== "native") {
    throw new Error(`${label} must be "shadow" or "native"`);
  }
  return value;
}

/** Provider and ID are all-or-nothing: a half pair is a config bug, not a partial override. */
function expectModelPair(value: unknown, label: string): ModelPair | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, label);
  assertKnownKeys(record, ["provider", "id"], label);
  const provider = expectText(record.provider, `${label}.provider`);
  const id = expectText(record.id, `${label}.id`);
  if ((provider.length > 0) !== (id.length > 0)) {
    throw new Error(`${label}.provider and .id must both be blank or both be set`);
  }
  return { provider, id };
}

function expectText(value: unknown, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.trim();
}

function expectIdleCompact(
  value: unknown,
  label: string,
): { enabled?: boolean; minimumTokens?: number } | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, label);
  assertKnownKeys(record, ["enabled", "minimumTokens"], label);
  const enabled = expectBoolean(record.enabled, `${label}.enabled`);
  const minimumTokens = expectPositiveInt(record.minimumTokens, `${label}.minimumTokens`);
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(minimumTokens !== undefined ? { minimumTokens } : {}),
  };
}

/** Validates a raw settings record from any source; absent settings stay absent. */
function validateSettings(raw: RawSettings, label: Label): Settings {
  const prepare = expectPercent(raw.prepareThresholdPercent, label("prepareThresholdPercent"));
  const native = expectPercent(raw.nativeFallbackThresholdPercent, label("nativeFallbackThresholdPercent"));
  const summarizer = expectModelPair(raw.summarizerModel, label("summarizerModel"));
  const summaryMaxTokens = expectPositiveInt(raw.summaryMaxTokens, label("summaryMaxTokens"));
  const thinkingLevel = expectThinkingLevel(raw.thinkingLevel, label("thinkingLevel"));
  const verificationModel = expectModelPair(raw.verificationModel, label("verificationModel"));
  const verificationThinking = expectThinkingLevel(
    raw.verificationThinkingLevel,
    label("verificationThinkingLevel"),
  );
  const idleCompact = expectIdleCompact(raw.idleCompact, label("idleCompact"));
  const recentTurns = expectPositiveInt(raw.recentTurns, label("recentTurns"));
  const manualCompactMode = expectManualMode(raw.manualCompactMode, label("manualCompactMode"));
  return {
    ...(prepare !== undefined ? { prepareThresholdPercent: prepare } : {}),
    ...(native !== undefined ? { nativeFallbackThresholdPercent: native } : {}),
    ...(summarizer !== undefined ? { summarizerModel: summarizer } : {}),
    ...(summaryMaxTokens !== undefined ? { summaryMaxTokens } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(verificationModel !== undefined ? { verificationModel } : {}),
    ...(verificationThinking !== undefined ? { verificationThinkingLevel: verificationThinking } : {}),
    ...(idleCompact !== undefined ? { idleCompact } : {}),
    ...(recentTurns !== undefined ? { recentTurns } : {}),
    ...(manualCompactMode !== undefined ? { manualCompactMode } : {}),
  };
}

/**
 * The native fallback must fire after preparation starts, or the emergency
 * hatch would pre-empt the checkpoint path it depends on. Checked only when
 * the native threshold is stated, so an unrelated prepare override keeps the
 * default ordering.
 */
function assertThresholdOrder(
  config: Pick<ShadowCompactConfig, "prepareThresholdPercent" | "nativeFallbackThresholdPercent">,
  label: Label,
): void {
  if (config.nativeFallbackThresholdPercent <= config.prepareThresholdPercent) {
    throw new Error(
      `${label("nativeFallbackThresholdPercent")} must be greater than prepareThresholdPercent ` +
        `(${config.prepareThresholdPercent})`,
    );
  }
}

const FILE_KEYS = [
  "prepareThresholdPercent",
  "nativeFallbackThresholdPercent",
  "softCompactThresholdPercent",
  "summarizerModel",
  "summaryMaxTokens",
  "thinkingLevel",
  "verificationModel",
  "verificationThinkingLevel",
  "idleCompact",
  "recentTurns",
  "manualCompactMode",
] as const;

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
  assertKnownKeys(record, FILE_KEYS, path);

  const label: Label = (key) => `${path} ${key}`;
  // Legacy soft key: an alias for the prepare threshold, but not a second way
  // to say "absent" — both set with different values is a config bug.
  const prepare = expectPercent(record.prepareThresholdPercent, label("prepareThresholdPercent"));
  const alias = expectPercent(record.softCompactThresholdPercent, `${path} softCompactThresholdPercent`);
  if (prepare !== undefined && alias !== undefined && prepare !== alias) {
    throw new Error(
      `${path} prepareThresholdPercent and legacy softCompactThresholdPercent conflict; use prepareThresholdPercent`,
    );
  }
  const settings = validateSettings(
    { ...record, ...(record.prepareThresholdPercent === undefined && alias !== undefined ? { prepareThresholdPercent: alias } : {}) },
    label,
  );
  const config: ShadowCompactConfig = {
    ...defaultConfig(),
    ...settings,
    idleCompact: { ...defaultConfig().idleCompact, ...settings.idleCompact },
  };
  if (record.nativeFallbackThresholdPercent !== undefined) assertThresholdOrder(config, label);
  return config;
}

// ---------------------------------------------------------------------------
// Environment adapter: the same settings, one env var each.
// ---------------------------------------------------------------------------

/** Trimmed raw env value, or undefined when unset/blank. */
function rawEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function envNumber(name: string): number | undefined {
  const raw = rawEnv(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(process.env[name])}`);
  }
  return value;
}

/** Provider and ID arrive as two vars; a lone half is still a config bug. */
function envModelPair(providerVar: string, idVar: string): ModelPair | undefined {
  const provider = rawEnv(providerVar);
  const id = rawEnv(idVar);
  if ((provider === undefined) !== (id === undefined)) {
    throw new Error(`${providerVar} and ${idVar} must both be set or both be unset`);
  }
  if (provider === undefined || id === undefined) return undefined;
  return { provider, id };
}

export function applyEnvOverrides(config: ShadowCompactConfig): ShadowCompactConfig {
  const raw: RawSettings = {
    ...(rawEnv(SOFT_THRESHOLD_ENV_VAR) !== undefined
      ? { prepareThresholdPercent: envNumber(SOFT_THRESHOLD_ENV_VAR) }
      : {}),
    ...(rawEnv(NATIVE_THRESHOLD_ENV_VAR) !== undefined
      ? { nativeFallbackThresholdPercent: envNumber(NATIVE_THRESHOLD_ENV_VAR) }
      : {}),
    ...(rawEnv(SUMMARIZER_PROVIDER_ENV_VAR) !== undefined || rawEnv(SUMMARIZER_ID_ENV_VAR) !== undefined
      ? { summarizerModel: envModelPair(SUMMARIZER_PROVIDER_ENV_VAR, SUMMARIZER_ID_ENV_VAR) }
      : {}),
    ...(rawEnv(SUMMARIZER_THINKING_ENV_VAR) !== undefined
      ? { thinkingLevel: rawEnv(SUMMARIZER_THINKING_ENV_VAR) }
      : {}),
    ...(rawEnv(VERIFIER_PROVIDER_ENV_VAR) !== undefined || rawEnv(VERIFIER_ID_ENV_VAR) !== undefined
      ? { verificationModel: envModelPair(VERIFIER_PROVIDER_ENV_VAR, VERIFIER_ID_ENV_VAR) }
      : {}),
    ...(rawEnv(VERIFIER_THINKING_ENV_VAR) !== undefined
      ? { verificationThinkingLevel: rawEnv(VERIFIER_THINKING_ENV_VAR) }
      : {}),
    ...(rawEnv(MANUAL_MODE_ENV_VAR) !== undefined ? { manualCompactMode: rawEnv(MANUAL_MODE_ENV_VAR) } : {}),
    ...(rawEnv(IDLE_MIN_TOKENS_ENV_VAR) !== undefined
      ? { idleCompact: { minimumTokens: envNumber(IDLE_MIN_TOKENS_ENV_VAR) } }
      : {}),
  };
  const envLabel: Label = (key) => ENV_VAR_BY_KEY[key] ?? key;
  const { idleCompact, ...settings } = validateSettings(raw, envLabel);
  // Env-only knobs outside the shared record.
  const softTokens = expectPositiveInt(
    envNumber(SOFT_THRESHOLD_ABS_ENV_VAR),
    SOFT_THRESHOLD_ABS_ENV_VAR,
  );
  const merged: ShadowCompactConfig = {
    ...config,
    ...settings,
    ...(softTokens !== undefined ? { softCompactThresholdTokens: softTokens } : {}),
    ...(idleCompact !== undefined
      ? { idleCompact: { ...config.idleCompact, ...idleCompact } }
      : {}),
  };
  if (settings.nativeFallbackThresholdPercent !== undefined) assertThresholdOrder(merged, envLabel);
  return merged;
}

const ENV_VAR_BY_KEY: Record<keyof RawSettings, string> = {
  prepareThresholdPercent: SOFT_THRESHOLD_ENV_VAR,
  nativeFallbackThresholdPercent: NATIVE_THRESHOLD_ENV_VAR,
  summarizerModel: `${SUMMARIZER_PROVIDER_ENV_VAR} / ${SUMMARIZER_ID_ENV_VAR}`,
  summaryMaxTokens: "summaryMaxTokens",
  thinkingLevel: SUMMARIZER_THINKING_ENV_VAR,
  verificationModel: `${VERIFIER_PROVIDER_ENV_VAR} / ${VERIFIER_ID_ENV_VAR}`,
  verificationThinkingLevel: VERIFIER_THINKING_ENV_VAR,
  idleCompact: `${IDLE_MIN_TOKENS_ENV_VAR} idleCompact`,
  recentTurns: "recentTurns",
  manualCompactMode: MANUAL_MODE_ENV_VAR,
};

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${String(error)}`);
  }
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

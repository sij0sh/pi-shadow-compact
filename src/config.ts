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
  if (provider.length > 0 !== id.length > 0) {
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
  const native = expectPercent(
    raw.nativeFallbackThresholdPercent,
    label("nativeFallbackThresholdPercent"),
  );
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
    ...(verificationThinking !== undefined
      ? { verificationThinkingLevel: verificationThinking }
      : {}),
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
  const alias = expectPercent(
    record.softCompactThresholdPercent,
    `${path} softCompactThresholdPercent`,
  );
  if (prepare !== undefined && alias !== undefined && prepare !== alias) {
    throw new Error(
      `${path} prepareThresholdPercent and legacy softCompactThresholdPercent conflict; use prepareThresholdPercent`,
    );
  }
  const settings = validateSettings(
    {
      ...record,
      ...(record.prepareThresholdPercent === undefined && alias !== undefined
        ? { prepareThresholdPercent: alias }
        : {}),
    },
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
// Environment adapter: threshold-only ephemeral overrides.
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

export function applyEnvOverrides(config: ShadowCompactConfig): ShadowCompactConfig {
  const raw: RawSettings = {
    ...(rawEnv(SOFT_THRESHOLD_ENV_VAR) !== undefined
      ? { prepareThresholdPercent: envNumber(SOFT_THRESHOLD_ENV_VAR) }
      : {}),
    ...(rawEnv(NATIVE_THRESHOLD_ENV_VAR) !== undefined
      ? { nativeFallbackThresholdPercent: envNumber(NATIVE_THRESHOLD_ENV_VAR) }
      : {}),
  };
  const envLabel: Label = (key) => ENV_VAR_BY_KEY[key] ?? key;
  const { idleCompact, ...settings } = validateSettings(raw, envLabel);
  const merged: ShadowCompactConfig = {
    ...config,
    ...settings,
    ...(idleCompact !== undefined
      ? { idleCompact: { ...config.idleCompact, ...idleCompact } }
      : {}),
  };
  if (settings.nativeFallbackThresholdPercent !== undefined) {
    assertThresholdOrder(merged, envLabel);
  }
  return merged;
}

const ENV_VAR_BY_KEY: Partial<Record<keyof RawSettings, string>> = {
  prepareThresholdPercent: SOFT_THRESHOLD_ENV_VAR,
  nativeFallbackThresholdPercent: NATIVE_THRESHOLD_ENV_VAR,
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
 * Resolved prepare-trigger comparison. The percent threshold is the only
 * user-facing trigger; the same comparison gates the initial trigger and the
 * rolling below-threshold re-arm so hysteresis stays consistent.
 */
export interface ThresholdUsage {
  percent?: number | null | undefined;
}

export function isAtOrAbovePrepare(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "prepareThresholdPercent">,
): boolean {
  return (
    usage.percent !== undefined &&
    usage.percent !== null &&
    usage.percent >= config.prepareThresholdPercent
  );
}

export function isBelowPrepare(
  usage: ThresholdUsage,
  config: Pick<ShadowCompactConfig, "prepareThresholdPercent">,
): boolean {
  return !isAtOrAbovePrepare(usage, config);
}

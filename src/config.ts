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
  return config;
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

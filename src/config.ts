import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT = 60;

export interface ShadowCompactConfig {
  softCompactThresholdPercent: number;
  summarizerModel: {
    provider: string;
    id: string;
  };
}

export function defaultConfig(): ShadowCompactConfig {
  return {
    softCompactThresholdPercent: DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
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
    if (key !== "softCompactThresholdPercent" && key !== "summarizerModel") {
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

  return {
    softCompactThresholdPercent: rawThreshold,
    summarizerModel: { provider, id },
  };
}

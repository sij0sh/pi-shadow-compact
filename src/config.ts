import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT = 60;

const ConfigSchema = z
  .object({
    softCompactThresholdPercent: z.number().finite().min(1).max(99),
    summarizerModel: z
      .object({
        provider: z.string().trim(),
        id: z.string().trim(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const hasProvider = config.summarizerModel.provider.length > 0;
    const hasId = config.summarizerModel.id.length > 0;
    if (hasProvider !== hasId) {
      context.addIssue({
        code: "custom",
        message: "summarizerModel.provider and summarizerModel.id must both be blank or both be set",
        path: ["summarizerModel"],
      });
    }
  });

export type ShadowCompactConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): ShadowCompactConfig {
  return {
    softCompactThresholdPercent: DEFAULT_SOFT_COMPACT_THRESHOLD_PERCENT,
    summarizerModel: { provider: "", id: "" },
  };
}

export async function loadConfig(ctx: ExtensionContext): Promise<ShadowCompactConfig> {
  const fallback = defaultConfig();
  const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "shadow-compact.json");

  if (!ctx.isProjectTrusted()) return fallback;

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }

  return ConfigSchema.parse(JSON.parse(source));
}

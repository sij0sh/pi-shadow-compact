import type { Usage } from "@earendil-works/pi-ai";
import type { FileDetails } from "./prepare.js";
import type { Checkpoint } from "./summary.js";

/**
 * Durable checkpoint data model (refactor §2, §9, §24).
 *
 * A checkpoint is evidence-grounded against the durable session, and
 * `coverage` states precisely how far that grounding extends. The summary
 * text is a rendering; the structured checkpoint is the durable object.
 */

/**
 * Current durable checkpoint schema version. V3 drops the removed
 * historic-turn subsystem (no `historicTurns`, no relevance prompt version).
 * Persisted v1 checkpoints restore with derived coverage; persisted v2
 * checkpoints restore with their Jev payload ignored.
 */
export const CHECKPOINT_SCHEMA_VERSION = 3;

/** Prompt versions carried by every checkpoint. */
export const SUMMARY_PROMPT_VERSION = 2;
export const VERIFIER_PROMPT_VERSION = 2;

export interface PromptVersions {
  summaryPromptVersion: number;
  verifierPromptVersion: number;
}

export function currentPromptVersions(): PromptVersions {
  return {
    summaryPromptVersion: SUMMARY_PROMPT_VERSION,
    verifierPromptVersion: VERIFIER_PROMPT_VERSION,
  };
}

/**
 * Where a checkpoint's evidence grounding starts and ends.
 *
 * - `sourceStartEntryId`: oldest session entry eligible as evidence (null
 *   when the checkpoint covers from the session start).
 * - `coverageEndEntryId`: the summary is guaranteed to represent session
 *   history through this entry. Never inferred from when generation
 *   completed: a checkpoint triggered at 60% that finishes at 79% covers
 *   only what its agent actually inspected.
 * - `preparedAtLeafId`: branch leaf when preparation started.
 * - `publishedAtLeafId`: branch leaf when the checkpoint published (the
 *   session kept moving while the agent worked).
 */
export interface CheckpointCoverage {
  sourceStartEntryId: string | null;
  coverageEndEntryId: string;
  preparedAtLeafId: string;
  publishedAtLeafId: string;
}

export interface ShadowCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  structured: Checkpoint;
  rendered: string;
  coverage: CheckpointCoverage;
  generatedAt: number;
  prompts: PromptVersions;
  usage?: Usage;
  details?: FileDetails;
}

/**
 * Builds coverage for a freshly generated checkpoint. The agent-supplied
 * `coverageEndEntryId` is authoritative; the leaves record branch movement
 * during generation so the swap can prove a gap-free tail.
 */
export function buildCoverage(options: {
  sourceStartEntryId: string | null;
  coverageEndEntryId: string;
  preparedAtLeafId: string;
  publishedAtLeafId: string;
}): CheckpointCoverage {
  return {
    sourceStartEntryId: options.sourceStartEntryId,
    coverageEndEntryId: options.coverageEndEntryId,
    preparedAtLeafId: options.preparedAtLeafId,
    publishedAtLeafId: options.publishedAtLeafId,
  };
}

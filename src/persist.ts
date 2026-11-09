import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointCoverage,
  type PromptVersions,
} from "./summary.js";
import { coverageIsUnchanged, type FileDetails } from "./working-context.js";
import { SECTIONS, type Checkpoint } from "./summary.js";

/**
 * Durable Shadow checkpoints as extension state.
 *
 * Ready checkpoints install through Pi boundary drafts when safe. Completion
 * while idle persists a CustomEntry instead; it is invisible to the model.
 * Both paths preserve raw history as evidence for future checkpoints.
 */
export const CHECKPOINT_CUSTOM_TYPE = "shadow-compact.checkpoint";

/**
 * How many prior Shadow summaries ride along as protected evidence slots.
 * Sessions are append-only, so pre-compaction Shadow checkpoints physically
 * survive native compactions on the branch; carrying the newest two (plus
 * the native previous summary) keeps Shadow coverage visible to the next
 * checkpoint without letting protected slots crowd out raw evidence.
 */
export const SHADOW_CHAIN_LIMIT = 2;

/**
 * One checkpoint shape is both the durable entry and the serving value: a
 * published result is already a v3 checkpoint, so persistence appends it
 * as-is and restore hands the entry straight back to the state controller.
 *
 * The structured checkpoint is the durable object, the rendering is derived,
 * and coverage states the evidence boundary explicitly. No historic-turn
 * payload: long-range continuity is the verified checkpoint's job, near-term
 * continuity the no-gap tail's.
 */
export interface PersistedShadowCheckpoint {
  version: typeof CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  sessionId: string;
  summary: string;
  /** Frozen trigger overlap: the earliest entry the checkpoint's tail keeps. */
  firstKeptEntryId: string;
  leafId: string;
  latestCompactionId: string | null;
  /** Context size observed at publish; metadata for the mid-run swap message. */
  contextTokensBefore: number;
  usage: Usage;
  details: FileDetails;
  /** Wall-clock publish time. */
  createdAt: number;
  structured: Checkpoint;
  coverage: CheckpointCoverage;
  prompts: PromptVersions;
  generatedAt: number;
}

export type PreparedResult = PersistedShadowCheckpoint;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key] as number)) return false;
  }
  const cost = usage.cost;
  if (!cost || typeof cost !== "object") return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (typeof (cost as Record<string, unknown>)[key] !== "number") return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCheckpointCoverage(value: unknown): value is CheckpointCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = value as Record<string, unknown>;
  if (coverage.sourceStartEntryId !== null && typeof coverage.sourceStartEntryId !== "string") return false;
  for (const key of ["coverageEndEntryId", "preparedAtLeafId", "publishedAtLeafId"] as const) {
    if (!isNonEmptyString(coverage[key])) return false;
  }
  return true;
}

function isPromptVersions(value: unknown): value is PromptVersions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prompts = value as Record<string, unknown>;
  for (const key of ["summaryPromptVersion", "verifierPromptVersion"] as const) {
    if (typeof prompts[key] !== "number" || !Number.isFinite(prompts[key] as number)) return false;
  }
  return true;
}

const CHECKPOINT_SECTION_KEYS = [...SECTIONS, "verificationState", "continuationState"];

/** Shape check for the structured checkpoint (evidence refs are branch-relative, not re-validated). */
function isStructuredCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  for (const key of CHECKPOINT_SECTION_KEYS) {
    if (!(key in checkpoint)) return false;
  }
  return true;
}

/** Structural validation for entries read back from the session file. */
export function isPersistedShadowCheckpoint(value: unknown): value is PersistedShadowCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== CHECKPOINT_SCHEMA_VERSION) return false;
  for (const key of ["checkpointId", "sessionId", "summary", "firstKeptEntryId", "leafId"] as const) {
    if (typeof candidate[key] !== "string" || (candidate[key] as string).length === 0) return false;
  }
  if (candidate.latestCompactionId !== null && typeof candidate.latestCompactionId !== "string") {
    return false;
  }
  if (typeof candidate.contextTokensBefore !== "number" || !Number.isFinite(candidate.contextTokensBefore)) {
    return false;
  }
  if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) return false;
  if (!isUsage(candidate.usage)) return false;
  if (!candidate.details || typeof candidate.details !== "object" || Array.isArray(candidate.details)) {
    return false;
  }
  const details = candidate.details as Record<string, unknown>;
  if (!isStringList(details.readFiles) || !isStringList(details.modifiedFiles)) return false;
  if (!isStructuredCheckpoint(candidate.structured)) return false;
  if (!isCheckpointCoverage(candidate.coverage)) return false;
  if (!isPromptVersions(candidate.prompts)) return false;
  return typeof candidate.generatedAt === "number" && Number.isFinite(candidate.generatedAt);
}

/**
 * Newest structurally valid checkpoint wins. A corrupt newer shadow entry
 * falls back to the older valid one instead of failing the restore outright.
 * Structural only: the winner may still be stale (wrong session, moved cut
 * ancestry, newer native compaction) — currency is checked separately, or
 * use findLatestRestorableCheckpoint to skip stale winners outright.
 */
/**
 * Newest-first walk over structurally valid checkpoints. Corrupt entries are
 * skipped silently; staleness is the caller's decision (structural-only find
 * vs restorable find), never the iterator's.
 */
function* newestValidCheckpoints(
  branch: SessionEntry[],
): Generator<{ entryId: string; checkpoint: PersistedShadowCheckpoint }> {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
    if (!isPersistedShadowCheckpoint(entry.data)) continue;
    yield { entryId: entry.id, checkpoint: entry.data };
  }
}

export function findLatestPersistedCheckpoint(
  branch: SessionEntry[],
): { entryId: string; checkpoint: PersistedShadowCheckpoint } | undefined {
  for (const found of newestValidCheckpoints(branch)) return found;
  return undefined;
}

export interface SkippedStaleCheckpoint {
  checkpointId: string;
  reason: CheckpointStalenessReason;
}

export interface RestorableSearch {
  /** Newest structurally valid checkpoint that is still current, if any. */
  found: { entryId: string; checkpoint: PersistedShadowCheckpoint } | undefined;
  /** Newer structurally valid checkpoints skipped as stale, newest-first. */
  skippedStale: SkippedStaleCheckpoint[];
}

/**
 * Newest *current* checkpoint wins. Walks newest-first past structurally
 * valid but stale candidates instead of rejecting the newest and stopping:
 * a native compaction (or session/cut mismatch) generally stales checkpoints
 * together, but when only the newest is stale an older checkpoint may still
 * be restorable, and stranding it would drop a usable working set.
 * Structurally corrupt entries are ignored, never reported as skipped.
 */
export function findLatestRestorableCheckpoint(
  branch: SessionEntry[],
  sessionId: string,
): RestorableSearch {
  const skippedStale: SkippedStaleCheckpoint[] = [];
  for (const { entryId, checkpoint } of newestValidCheckpoints(branch)) {
    const reason = checkpointStalenessReason(branch, sessionId, checkpoint);
    if (reason !== undefined) {
      skippedStale.push({ checkpointId: checkpoint.checkpointId, reason });
      continue;
    }
    return { found: { entryId, checkpoint }, skippedStale };
  }
  return { found: undefined, skippedStale };
}

export type CheckpointStalenessReason =
  | "session-mismatch"
  | "missing-first-kept"
  | "missing-leaf"
  | "missing-coverage-end"
  | "changed-coverage"
  | "compaction-mismatch";

/** The fields every currency check needs. */
export interface CheckpointCurrentness {
  sessionId: string;
  leafId: string;
  latestCompactionId: string | null;
  firstKeptEntryId: string;
  coverage: CheckpointCoverage;
}

/**
 * Single currency rule for in-memory swaps, restore, and native recovery:
 * the owning session, the cut ancestry, and the native compaction boundary
 * must all still hold (undefined means current). Callers that prove the cut
 * with `isCoveredPrefix` pass `requireFirstKept: false`, since that proof
 * already covers the cut entry.
 */
export function checkpointStalenessReason(
  branch: SessionEntry[],
  sessionId: string,
  checkpoint: CheckpointCurrentness,
  options: { requireFirstKept?: boolean } = {},
): CheckpointStalenessReason | undefined {
  if (checkpoint.sessionId !== sessionId) return "session-mismatch";
  if (options.requireFirstKept !== false && !branch.some((entry) => entry.id === checkpoint.firstKeptEntryId)) {
    return "missing-first-kept";
  }
  if (!branch.some((entry) => entry.id === checkpoint.leafId)) return "missing-leaf";
  if (!branch.some((entry) => entry.id === checkpoint.coverage.coverageEndEntryId)) {
    return "missing-coverage-end";
  }
  if (!coverageIsUnchanged(branch, checkpoint.coverage)) return "changed-coverage";
  if (latestCompactionId(branch) !== checkpoint.latestCompactionId) return "compaction-mismatch";
  return undefined;
}

/**
 * Newest-first Shadow summaries usable as summarizer context, oldest-first
 * out. Deliberately weaker than restore currency: swap/restore still require
 * a fully current checkpoint, but as *evidence* an older Shadow summary is
 * valuable even after a native compaction landed (compaction-mismatch) or
 * the leaf moved on (missing-leaf), as long as it belongs to this session
 * and its cut is still on the branch. Cross-session summaries are never
 * included.
 */
export function collectShadowSummaries(
  branch: SessionEntry[],
  sessionId: string,
  limit: number = SHADOW_CHAIN_LIMIT,
): string[] {
  if (limit <= 0) return [];
  const ids = new Set(branch.map((entry) => entry.id));
  const matches: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
    if (!isPersistedShadowCheckpoint(entry.data)) continue;
    if (entry.data.sessionId !== sessionId) continue;
    if (!ids.has(entry.data.firstKeptEntryId)) continue;
    matches.push(entry.data.summary);
  }
  return matches.slice(Math.max(0, matches.length - limit));
}

export function latestCompactionId(branch: SessionEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") return branch[index]!.id;
  }
  return null;
}

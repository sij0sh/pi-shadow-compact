import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_SCHEMA_VERSION, type CheckpointCoverage, type PromptVersions } from "./checkpoint.js";
import type { PreparedResult } from "./state.js";
import { coverageIsUnchanged } from "./working-context.js";
import type { Checkpoint } from "./summary.js";

/**
 * Durable Shadow checkpoints as extension state.
 *
 * Ready checkpoints install through Pi boundary drafts when safe. Completion
 * while idle persists a CustomEntry instead; it is invisible to the model.
 * Both paths preserve raw history as evidence for future checkpoints.
 */
export const CHECKPOINT_CUSTOM_TYPE = "shadow-compact.checkpoint";
/** Pre-v2 namespace: still read for restore, never written. */
export const CHECKPOINT_CUSTOM_TYPE_LEGACY = "shadow-compact.checkpoint.v1";

function isCheckpointCustomType(customType: unknown): boolean {
  return customType === CHECKPOINT_CUSTOM_TYPE || customType === CHECKPOINT_CUSTOM_TYPE_LEGACY;
}

/**
 * How many prior Shadow summaries ride along as protected evidence slots.
 * Sessions are append-only, so pre-compaction Shadow checkpoints physically
 * survive native compactions on the branch; carrying the newest two (plus
 * the native previous summary) keeps Shadow coverage visible to the next
 * checkpoint without letting protected slots crowd out raw evidence.
 */
export const SHADOW_CHAIN_LIMIT = 2;

export interface PersistedShadowCheckpointV1 {
  version: 1;
  checkpointId: string;
  sessionId: string;
  summary: string;
  /** Entry-granular legacy serving cut. */
  firstKeptEntryId: string;
  leafId: string;
  latestCompactionId: string | null;
  contextTokensBefore: number;
  usage: Usage;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  createdAt: number;
}

/**
 * V3 durable checkpoint: the structured checkpoint is the durable object,
 * the rendering is derived, and coverage states the evidence boundary
 * explicitly. No historic-turn payload: long-range continuity is the
 * verified checkpoint's job, near-term continuity the no-gap tail's.
 */
export interface PersistedShadowCheckpointV3 {
  version: 3;
  checkpointId: string;
  sessionId: string;
  summary: string;
  /** Frozen trigger overlap for fresh checkpoints; legacy serving cut on older entries. */
  firstKeptEntryId: string;
  leafId: string;
  latestCompactionId: string | null;
  contextTokensBefore: number;
  usage: Usage;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  createdAt: number;
  structured: Checkpoint;
  coverage: CheckpointCoverage;
  prompts: PromptVersions;
  generatedAt: number;
}

/**
 * Legacy v2 reader shape. Never written, never part of runtime types: v2's
 * `historicTurns` and `relevancePromptVersion` belonged to the removed
 * historic-turn subsystem and are validated structurally, then ignored on
 * restore so a good v2 checkpoint keeps serving.
 */
export interface PersistedShadowCheckpointV2Legacy {
  version: 2;
  checkpointId: string;
  sessionId: string;
  summary: string;
  /** Legacy estimated serving cut, retained conservatively on restore. */
  firstKeptEntryId: string;
  leafId: string;
  latestCompactionId: string | null;
  contextTokensBefore: number;
  usage: Usage;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  createdAt: number;
  structured: Checkpoint;
  coverage: CheckpointCoverage;
  prompts: PromptVersions & { relevancePromptVersion: number };
  historicTurns: unknown[];
  generatedAt: number;
}

export type PersistedShadowCheckpoint =
  | PersistedShadowCheckpointV1
  | PersistedShadowCheckpointV2Legacy
  | PersistedShadowCheckpointV3;

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

/** Legacy v2 prompt versions: the relevance field is validated, then ignored on restore. */
function isPromptVersionsV2Legacy(
  value: unknown,
): value is PersistedShadowCheckpointV2Legacy["prompts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prompts = value as Record<string, unknown>;
  for (const key of ["summaryPromptVersion", "verifierPromptVersion", "relevancePromptVersion"] as const) {
    if (typeof prompts[key] !== "number" || !Number.isFinite(prompts[key] as number)) return false;
  }
  return true;
}

const CHECKPOINT_SECTION_KEYS = [
  "objective",
  "constraints",
  "completedWork",
  "currentState",
  "decisions",
  "openIssues",
  "nextActions",
  "criticalContext",
  "modifiedFiles",
  "referencedFiles",
  "verificationState",
  "continuationState",
];

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
  if (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== CHECKPOINT_SCHEMA_VERSION) {
    return false;
  }
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
  if (candidate.version === 1) return true;
  if (!isStructuredCheckpoint(candidate.structured)) return false;
  if (!isCheckpointCoverage(candidate.coverage)) return false;
  if (candidate.version === 2) {
    // Legacy v2: the Jev payload must be structurally present (a corrupt v2
    // entry is skipped like any corrupt entry) but its contents are never
    // restored into runtime state.
    if (!isPromptVersionsV2Legacy(candidate.prompts)) return false;
    if (!Array.isArray(candidate.historicTurns)) return false;
  } else if (!isPromptVersions(candidate.prompts)) {
    return false;
  }
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
    if (!entry || entry.type !== "custom" || !isCheckpointCustomType(entry.customType)) continue;
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

/**
 * Capability check for the structured/coverage tail of the schema (v2 and
 * v3). Version-equality checks would silently drop old checkpoints on every
 * schema bump; this keeps them restoring with their full structure.
 */
function hasCoverage(
  checkpoint: PersistedShadowCheckpoint,
): checkpoint is PersistedShadowCheckpointV2Legacy | PersistedShadowCheckpointV3 {
  return checkpoint.version >= 2;
}

export type CheckpointStalenessReason =
  | "session-mismatch"
  | "missing-first-kept"
  | "missing-leaf"
  | "missing-coverage-end"
  | "changed-coverage"
  | "compaction-mismatch";

/**
 * The same currency rules the in-memory swap already enforces: the owning
 * session, the cut ancestry, and the native compaction boundary must all
 * still hold. A native compaction that landed after the persist invalidates
 * the projection (undefined means current).
 */
export function checkpointStalenessReason(
  branch: SessionEntry[],
  sessionId: string,
  checkpoint: PersistedShadowCheckpoint,
): CheckpointStalenessReason | undefined {
  if (checkpoint.sessionId !== sessionId) return "session-mismatch";
  if (!branch.some((entry) => entry.id === checkpoint.firstKeptEntryId)) return "missing-first-kept";
  if (!branch.some((entry) => entry.id === checkpoint.leafId)) return "missing-leaf";
  if (
    hasCoverage(checkpoint) &&
    !branch.some((entry) => entry.id === checkpoint.coverage.coverageEndEntryId)
  ) {
    return "missing-coverage-end";
  }
  if (hasCoverage(checkpoint) && !coverageIsUnchanged(branch, checkpoint.coverage)) return "changed-coverage";
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
    if (entry.type !== "custom" || !isCheckpointCustomType(entry.customType)) continue;
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

/** Restores a validated checkpoint into the serving shape. */
export function toPreparedResult(checkpoint: PersistedShadowCheckpoint): PreparedResult {
  const result: PreparedResult = {
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    leafId: checkpoint.leafId,
    latestCompactionId: checkpoint.latestCompactionId,
    firstKeptEntryId: checkpoint.firstKeptEntryId,
    summary: checkpoint.summary,
    usage: checkpoint.usage,
    details: checkpoint.details,
    contextTokensBefore: checkpoint.contextTokensBefore,
  };
  if (hasCoverage(checkpoint)) {
    result.coverage = checkpoint.coverage;
    result.structured = checkpoint.structured;
    result.generatedAt = checkpoint.generatedAt;
    // Legacy v2's historicTurns and relevancePromptVersion are dropped here:
    // a good v2 checkpoint keeps serving, minus its obsolete Jev payload.
    result.prompts = {
      summaryPromptVersion: checkpoint.prompts.summaryPromptVersion,
      verifierPromptVersion: checkpoint.prompts.verifierPromptVersion,
    };
  }
  return result;
}

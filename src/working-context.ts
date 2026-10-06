import { buildSessionProjection, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CheckpointCoverage } from "./checkpoint.js";
import { contextSwapDropCount, hasOrphanedToolResult } from "./swap.js";

/**
 * Working context builder (refactor §3, Phase 2).
 *
 * Owns swap composition: the no-gap continuity tail, the last-X-turns
 * minimum, projection safety, and tool-pair integrity.
 * The `context` handler stays thin; this module proves the invariant:
 *
 *   summary coverage ∪ continuity tail covers every turn through the
 *   present with no uncovered interval. Overlap is harmless, gaps are not.
 */

export interface WorkingContextCheckpoint {
  summary: string;
  coverage: CheckpointCoverage;
}

export interface WorkingContextInput {
  checkpoint: WorkingContextCheckpoint;
  branch: SessionEntry[];
  messages: ContextEvent["messages"];
  minimumRecentTurns: number;
  contextTokensBefore?: number;
  /**
   * Explicit tail start replacing the coverage-derived one. Used for v1
   * checkpoints, whose cut is entry-granular (possibly mid-turn): starting
   * the tail at the next complete turn would silently drop the turn head the
   * legacy summary never covered. The recent-turns minimum still applies on
   * top, and the orphan guard still fails closed on pair splits.
   */
  coverageTailOverride?: string;
}

export interface SwapPlan {
  /** Checkpoint's guaranteed evidence boundary. */
  summaryCoverageEnd: string;
  /** First complete model round containing any uncovered conversation. */
  coverageTailStart: string;
  /** First turn among the last-X-turns minimum. */
  recentTailStart: string;
  /** Earlier of the two (earlier in the transcript retains more). */
  swapStartEntryId: string;
}

export interface WorkingContextResult {
  messages: ContextEvent["messages"];
  plan: SwapPlan;
  continuityStartEntryId: string;
  droppedMessages: number;
}

export type WorkingContextSkipReason =
  | "stale-coverage"
  | "no-drop"
  | "empty-tail"
  | "orphan"
  | "projection";

export interface WorkingContextSkipped {
  skipped: WorkingContextSkipReason;
  /** Messages that would have dropped had the swap applied (orphan/empty-tail only). */
  droppedMessages?: number;
}

export function isWorkingContextSkipped(
  result: WorkingContextResult | WorkingContextSkipped,
): result is WorkingContextSkipped {
  return "skipped" in result;
}

/**
 * Computes the swap boundary from coverage and recency. Returns undefined
 * when the coverage anchor is no longer on the branch (stale checkpoint):
 * callers fail closed to full context.
 */
export function planSwap(
  branch: SessionEntry[],
  coverageEndEntryId: string,
  minimumRecentTurns: number,
  coverageTailOverride?: string,
): SwapPlan | undefined {
  if (branch.length === 0) return undefined;
  const turns = continuityTurns(branch);
  if (turns.length === 0) return undefined;

  // Empty coverageEnd means "covers nothing yet": the tail starts at the
  // first turn. Any other unknown anchor is a stale checkpoint.
  const coverageIdx = coverageEndEntryId === ""
    ? -1
    : branch.findIndex((entry) => entry.id === coverageEndEntryId);
  if (coverageIdx < -1 || (coverageEndEntryId !== "" && coverageIdx < 0)) return undefined;

  const entryIndex = new Map(branch.map((entry, index) => [entry.id, index]));
  let coverageTailStart: string;
  if (coverageTailOverride !== undefined) {
    if (!entryIndex.has(coverageTailOverride)) return undefined;
    coverageTailStart = coverageTailOverride;
  } else {
    coverageTailStart = (
      turns.find((turn) => (entryIndex.get(turn.endEntryId) ?? -1) > coverageIdx)
      ?? turns[turns.length - 1]!
    ).startEntryId;
  }
  const recentCount = Math.max(1, Math.floor(minimumRecentTurns));
  const recentTailStart = turns[Math.max(0, turns.length - recentCount)]!.startEntryId;
  const swapStartEntryId = (entryIndex.get(coverageTailStart) ?? 0) <= (entryIndex.get(recentTailStart) ?? 0)
    ? coverageTailStart
    : recentTailStart;

  return {
    summaryCoverageEnd: coverageEndEntryId,
    coverageTailStart,
    recentTailStart,
    swapStartEntryId,
  };
}

export function buildWorkingContext(
  input: WorkingContextInput,
): WorkingContextResult | WorkingContextSkipped {
  const { checkpoint, branch, messages } = input;
  const plan = planSwap(
    branch,
    checkpoint.coverage.coverageEndEntryId,
    input.minimumRecentTurns,
    input.coverageTailOverride,
  );
  if (!plan) return { skipped: "stale-coverage" };

  // Prove coverage entry-by-entry, including the uncovered end of a round
  // whose call or input is already covered by the checkpoint.
  if (!isCoveredPrefix(branch, plan.summaryCoverageEnd, plan.swapStartEntryId)) {
    return { skipped: "stale-coverage" };
  }

  // A swap at the branch head drops nothing: skip the projection lookup,
  // which cannot resolve a cut on a state-only leading entry.
  const drop = plan.swapStartEntryId === branch[0]!.id
    ? 0
    : contextSwapDropCount(branch, plan.swapStartEntryId);
  if (drop === undefined || drop > messages.length) return { skipped: "projection" };
  // A swap that drops nothing is pure overhead: the summary would ride along
  // with the full context it duplicates. Skip and let the next turns grow a
  // droppable prefix.
  if (drop === 0) return { skipped: "no-drop" };
  const kept = messages.slice(drop);
  if (kept.length === 0) return { skipped: "empty-tail", droppedMessages: drop };
  // Fail closed: a kept tool result without its tool call is a transcript
  // the provider rejects outright. Skip the swap for this request instead
  // of serving it; the checkpoint stays armed.
  if (hasOrphanedToolResult(kept)) return { skipped: "orphan", droppedMessages: drop };

  const summaryMessage = {
    role: "compactionSummary" as const,
    summary: checkpoint.summary,
    tokensBefore: input.contextTokensBefore ?? 0,
    timestamp: Date.now(),
  };
  return {
    messages: [summaryMessage, ...kept],
    plan,
    continuityStartEntryId: plan.swapStartEntryId,
    droppedMessages: drop,
  };
}

/**
 * Pi turns are assistant responses with their tool results, not whole spans
 * between user prompts. Keep the history reader's user-anchored groups for
 * evidence inspection, but count projected model rounds for the live tail.
 * New input joins its following assistant response; parallel results stay
 * with their call. Omitted attempts and prompt/state entries do not count.
 */
function continuityTurns(branch: SessionEntry[]): Array<{ startEntryId: string; endEntryId: string }> {
  const turns: Array<{ startEntryId: string; endEntryId: string }> = [];
  let hasAssistant = false;
  for (const entry of buildSessionProjection(branch).entries) {
    const messages = entry.messages.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
    if (messages.length === 0) continue;
    const assistant = messages.some((message) => message.role === "assistant");
    const input = messages.some((message) => message.role !== "assistant" && message.role !== "toolResult");
    if (turns.length === 0 || input || (assistant && hasAssistant)) {
      turns.push({ startEntryId: entry.sourceEntry.id, endEntryId: entry.sourceEntry.id });
      hasAssistant = false;
    } else {
      turns[turns.length - 1]!.endEntryId = entry.sourceEntry.id;
    }
    if (assistant) hasAssistant = true;
  }
  return turns;
}

/** Shared no-gap proof for request-local swaps and Pi compaction cuts. */
export function isCoveredPrefix(
  branch: SessionEntry[],
  coverageEndEntryId: string,
  firstKeptEntryId: string,
): boolean {
  const entryIndex = new Map(branch.map((entry, index) => [entry.id, index]));
  const coverageIdx = coverageEndEntryId === "" ? -1 : (entryIndex.get(coverageEndEntryId) ?? -2);
  if (coverageIdx < -1) return false;
  const swapIdx = entryIndex.get(firstKeptEntryId) ?? -2;
  if (swapIdx < 0) return false;
  // Check entries, not just turn starts: a partly covered round can contain
  // uncovered tool outputs even when its assistant call is already covered.
  return buildSessionProjection(branch).entries.every((entry) => {
    const index = entryIndex.get(entry.sourceEntry.id) ?? -1;
    return index <= coverageIdx || index >= swapIdx || entry.messages.every(
      (message) => message.role === "system" || message.role === "compactionSummary",
    );
  });
}

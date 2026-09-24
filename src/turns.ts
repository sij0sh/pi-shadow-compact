import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CHARS_PER_TOKEN } from "./normalize.js";

/**
 * Turn segmentation for history inspection and gap-free continuity.
 *
 * Turn boundaries exist to support the checkpoint agents' whole-session
 * reads and the no-gap continuity tail — nothing else reads this module's
 * output as a second memory pipeline.
 */

/** Shared chars/token heuristic for turn and budget estimates. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * One complete user-anchored turn: the user message plus everything that
 * followed until the next user message. Every branch entry belongs to
 * exactly one turn, so entry-range math over turns stays contiguous.
 */
export interface SessionTurn {
  id: string;
  index: number;
  startEntryId: string;
  endEntryId: string;
  entryIds: string[];
}

export function segmentTurns(branch: SessionEntry[]): SessionTurn[] {
  if (branch.length === 0) return [];
  const boundaries: number[] = [];
  for (let i = 0; i < branch.length; i++) {
    if (isUserEntry(branch[i]!)) boundaries.push(i);
  }
  // No user message at all: the whole branch is one turn.
  const starts = boundaries.length > 0 ? boundaries : [0];
  // Leading non-user entries join the first turn instead of forming a
  // content-free preamble turn that coverage math must special-case.
  const turns: SessionTurn[] = [];
  for (let t = 0; t < starts.length; t++) {
    const start = t === 0 ? 0 : starts[t]!;
    const end = (t + 1 < starts.length ? starts[t + 1]! : branch.length) - 1;
    const entryIds = branch.slice(start, end + 1).map((entry) => entry.id);
    turns.push({
      id: `turn-${t + 1}`,
      index: t,
      startEntryId: branch[start]!.id,
      endEntryId: branch[end]!.id,
      entryIds,
    });
  }
  return turns;
}

function isUserEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && (entry as { message?: { role?: unknown } }).message?.role === "user";
}

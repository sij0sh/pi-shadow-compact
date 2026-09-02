import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Entry types that contribute exactly one message to the model context. */
const CONTEXT_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

/**
 * Counts the context messages a swap replaces: everything from the previous
 * compaction's kept boundary up to the prepared cut. Counting the previous
 * compaction entry itself accounts for the old summary message; when the cut
 * lands before that entry, the summary is added separately. Returns undefined
 * when the prepared cut cannot represent a swap point on the branch.
 */
export function contextSwapDropCount(
  branch: SessionEntry[],
  firstKeptEntryId: string,
  latestCompactionId: string | null,
): number | undefined {
  const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (keptIndex < 0) return undefined;

  let start = 0;
  let compactionIndex = -1;
  if (latestCompactionId) {
    compactionIndex = branch.findIndex((entry) => entry.id === latestCompactionId);
    if (compactionIndex >= 0) {
      const previous = branch[compactionIndex];
      const previousKeptId =
        previous?.type === "compaction" ? previous.firstKeptEntryId : undefined;
      const previousKeptIndex = previousKeptId
        ? branch.findIndex((entry) => entry.id === previousKeptId)
        : -1;
      start = previousKeptIndex >= 0 ? previousKeptIndex : compactionIndex + 1;
    }
  }
  if (keptIndex < start) return undefined;

  let drop = 0;
  let countedOldSummary = compactionIndex < 0;
  for (let index = start; index < keptIndex; index++) {
    if (!CONTEXT_ENTRY_TYPES.has(branch[index]?.type ?? "")) continue;
    drop++;
    if (index === compactionIndex) countedOldSummary = true;
  }
  return countedOldSummary ? drop : drop + 1;
}

import {
  findCutPoint,
  getLatestCompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { collectShadowSummaries, SHADOW_CHAIN_LIMIT } from "./persist.js";

export interface FileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PreparedSnapshot extends FileDetails {
  latestCompactionId: string | null;
  firstKeptEntryId: string;
  previousSummary?: string;
  /** Older Shadow summaries, oldest first (see collectShadowSummaries). */
  shadowSummaries: string[];
  sourceEntries: SessionEntry[];
  turnPrefixEntries: SessionEntry[];
}

export interface PrepareOptions {
  /** Owning session: required to collect the Shadow summary chain (never cross-session). */
  sessionId?: string;
  /** How many prior Shadow summaries ride along; defaults to SHADOW_CHAIN_LIMIT. */
  shadowChainLimit?: number;
  /**
   * How far before the native compaction boundary evidence may reach.
   * Sessions are append-only, so pre-compaction raw history survives on the
   * branch; reading past the boundary (bounded here, then by the packet
   * budget) is what lets post-compaction checkpoints self-repair.
   */
  preBoundaryEntryLimit?: number;
}

/** Default backward reach past the native compaction boundary. */
export const PRE_BOUNDARY_ENTRY_LIMIT = 300;

const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);

/** Reproduces Pi's native cut-point selection with public APIs only. */
export function prepareSnapshot(
  branch: SessionEntry[],
  keepRecentTokens: number,
  options: PrepareOptions = {},
): PreparedSnapshot | undefined {
  if (branch.length === 0 || branch[branch.length - 1]?.type === "compaction") return undefined;

  let boundaryStart = 0;
  let previousSummary: string | undefined;
  const previous = getLatestCompactionEntry(branch);
  if (previous) {
    const keptIndex = branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
    boundaryStart = keptIndex >= 0 ? keptIndex : branch.indexOf(previous) + 1;
    previousSummary = previous.summary;
  }

  const cut = findCutPoint(branch, boundaryStart, branch.length, keepRecentTokens);
  const firstKept = branch[cut.firstKeptEntryIndex];
  if (!firstKept?.id) return undefined;

  // The cut policy mirrors Pi exactly; only the evidence range reaches past
  // the native boundary. The compaction entry itself normalizes to nothing,
  // so including it in the slice is harmless.
  const preLimit = options.preBoundaryEntryLimit ?? PRE_BOUNDARY_ENTRY_LIMIT;
  const evidenceStart = Math.max(0, boundaryStart - Math.max(0, preLimit));
  const turnStart = cut.isSplitTurn && cut.turnStartIndex >= 0 ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const sourceEntries = branch.slice(evidenceStart, turnStart);
  const turnPrefixEntries = cut.isSplitTurn
    ? branch.slice(turnStart, cut.firstKeptEntryIndex)
    : [];
  if (sourceEntries.length === 0 && turnPrefixEntries.length === 0) return undefined;

  const chainLimit = options.shadowChainLimit ?? SHADOW_CHAIN_LIMIT;
  const shadowSummaries = options.sessionId === undefined
    ? []
    : collectShadowSummaries(branch, options.sessionId, chainLimit);

  const details = fileDetails(sourceEntries, turnPrefixEntries);
  return {
    latestCompactionId: previous?.id ?? null,
    firstKeptEntryId: firstKept.id,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    shadowSummaries,
    sourceEntries,
    turnPrefixEntries,
    ...details,
  };
}

export function fileDetails(...entryGroups: SessionEntry[][]): FileDetails {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const part of entry.message.content) {
        if (part.type !== "toolCall") continue;
        const path = (part.arguments as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || path.length === 0) continue;
        if (part.name === "read") read.add(path);
        else if (MUTATING_TOOLS.has(part.name)) modified.add(path);
      }
    }
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

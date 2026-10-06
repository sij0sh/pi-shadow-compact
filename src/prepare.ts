import { buildSessionProjection, findCutPoint, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Prove a disposable prefix using Pi's public projection and cut helper.
 * Prompt state and a previous summary cannot make recent history compactable.
 * Recovery-only omission cuts remain Pi's responsibility; this idle preflight
 * deliberately requires a visible prefix rather than copying private rules.
 */
export function hasCompactableHistory(branch: SessionEntry[], keepRecentTokens: number): boolean {
  if (branch.at(-1)?.type === "compaction") return false;
  const projected = buildSessionProjection(branch).entries;
  const boundary = projected.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
  const conversation: SessionEntry[] = projected.slice(boundary + 1).flatMap(({ sourceEntry, messages }) =>
    sourceEntry.type === "compaction" ? [] : messages.filter((message) => message.role !== "system")
      .map((message) => ({ ...sourceEntry, type: "message" as const, message })),
  );
  const cut = findCutPoint(conversation, 0, conversation.length, keepRecentTokens);
  return cut.firstKeptEntryIndex > 0;
}

export interface FileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);

/** Separates files read from files modified across the given entry groups. */
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

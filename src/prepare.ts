import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

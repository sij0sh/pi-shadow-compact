import {
  buildSessionProjection,
  type ContextEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Counts the visible context messages a swap replaces: the projected messages
 * before the prepared cut, excluding the system messages Pi withholds from
 * context handlers since 0.87 (it restores the prompt and tool state after
 * they run). Counting raw branch entries instead over-drops by the number of
 * system entries in range, which can orphan a tool result from its tool call
 * — a transcript the provider rejects on every request.
 *
 * Pi's own projection additionally applies context edits, empty summaries,
 * and the previous compaction boundary, so the cut resolves by identity: the
 * number of visible messages owned by entries before firstKeptEntryId.
 * Returns undefined when the cut has no visible message to keep (an
 * off-branch cut, or an omitted or state-only entry).
 */
export function contextSwapDropCount(
  branch: SessionEntry[],
  firstKeptEntryId: string,
): number | undefined {
  if (branch.length === 0) return undefined;
  const projection = buildSessionProjection(branch);
  let drop = 0;
  for (const projected of projection.entries) {
    if (projected.sourceEntry.id === firstKeptEntryId) {
      return projected.messages.some((message) => message.role !== "system") ? drop : undefined;
    }
    for (const message of projected.messages) {
      if (message.role !== "system") drop += 1;
    }
  }
  return undefined;
}

/**
 * Pair-integrity guard for a swapped tail. Every kept tool result must have
 * its tool call among the kept messages; otherwise the request carries a
 * function output the provider cannot resolve and fails. Callers fail closed
 * (skip the swap) when this is true, so a misaligned cut degrades to full
 * context instead of a poisoned one.
 */
export function hasOrphanedToolResult(messages: ContextEvent["messages"]): boolean {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall") calls.add(part.id);
    }
  }
  return messages.some(
    (message) => message.role === "toolResult" && !calls.has(message.toolCallId),
  );
}

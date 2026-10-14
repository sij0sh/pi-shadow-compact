import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { redactSecretValue, sanitizeForContext } from "./normalize.js";
import { estimateTokens, segmentTurns, type SessionTurn } from "./turns.js";

/**
 * Whole-session history reader (refactor §1, §18).
 *
 * The checkpoint agent inspects the entire durable session through this
 * index: a compact manifest first, then paging (entry ranges, turn ranges,
 * single turns) and keyword search. All served text is sanitized; evidence
 * ids are stable per branch position so citations survive across tool calls.
 */

/** Evidence id for the previous-checkpoint summary slot (branch ids start at E0001). */
export const PREVIOUS_CHECKPOINT_EVIDENCE_ID = "E0000";

export function evidenceIdForEntryIndex(index: number): string {
  return `E${String(index + 1).padStart(4, "0")}`;
}

export interface TurnDigest {
  turnId: string;
  index: number;
  startEntryId: string;
  endEntryId: string;
  entryCount: number;
  userPreview: string;
  hasUserCorrection: boolean;
  hasError: boolean;
  hasQuestion: boolean;
  tokenEstimate: number;
}

export interface SessionManifest {
  sessionEntryCount: number;
  turnCount: number;
  firstEntryId: string | null;
  lastEntryId: string | null;
  previousCoverageEndEntryId: string | null;
  hasPreviousCheckpoint: boolean;
  requiredTurnIds: string[];
  turns: TurnDigest[];
  manifestTruncated: boolean;
  omittedTurnCount: number;
}

export interface ServedEntry {
  evidenceId: string;
  entryId: string;
  kind: string;
  text: string;
}

export interface ServedTurn {
  turnId: string;
  index: number;
  startEntryId: string;
  endEntryId: string;
  /** Entries in the whole turn; a partial page serves fewer. */
  entryCount: number;
  /** Turn-relative position of the first served entry, when not 0. */
  entryOffset?: number;
  /** Turn-relative position to continue from when the page stopped early. */
  nextEntryOffset?: number;
  entries: ServedEntry[];
}

export interface SearchHit {
  turnId: string;
  entryId: string;
  evidenceId: string;
  snippet: string;
}

export interface SessionHistoryIndexOptions {
  branch: SessionEntry[];
  cwd: string;
  previousCoverageEndEntryId?: string | null;
  previousCheckpointSummary?: string;
  maxPreviewChars?: number;
  maxManifestTurns?: number;
  /** Default serialized-character budget for one read page; readers may pass their own. */
  maxPageChars?: number;
}

const DEFAULT_MAX_PREVIEW_CHARS = 120;
const DEFAULT_MAX_MANIFEST_TURNS = 120;
const MAX_ENTRY_TEXT_CHARS = 4000;
/** ~12k tokens: one page stays small next to any private model's context window. */
export const DEFAULT_MAX_PAGE_CHARS = 48_000;
const MAX_SEARCH_HITS = 10;
const CORRECTION_SIGNALS =
  /\b(no\b|wrong|incorrect|instead|actually|not that|fix\b|should\b|must\b|never\b|always\b|don't\b|do not\b|require[sd]?|prefer|prohibit)/i;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text"),
    )
    .map((part) => part.text)
    .join("\n");
}

function servedSize(entries: ServedEntry[]): number {
  return entries.reduce((total, entry) => total + JSON.stringify(entry).length + 1, 0);
}

export class SessionHistoryIndex {
  readonly turns: SessionTurn[];
  readonly entryIndex = new Map<string, number>();
  readonly #branch: SessionEntry[];
  readonly #cwd: string;
  readonly #previousCoverageEndEntryId: string | null;
  readonly #previousCheckpointSummary: string | undefined;
  readonly #maxPreviewChars: number;
  readonly #maxManifestTurns: number;
  readonly #maxPageChars: number;
  readonly #inspectedEntryIds = new Set<string>();
  readonly #texts: string[];

  constructor(options: SessionHistoryIndexOptions) {
    this.#branch = options.branch;
    this.#cwd = options.cwd;
    this.#previousCoverageEndEntryId = options.previousCoverageEndEntryId ?? null;
    this.#previousCheckpointSummary = options.previousCheckpointSummary;
    this.#maxPreviewChars = options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
    this.#maxManifestTurns = options.maxManifestTurns ?? DEFAULT_MAX_MANIFEST_TURNS;
    this.#maxPageChars = Math.max(1, options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS);
    this.turns = segmentTurns(options.branch);
    options.branch.forEach((entry, index) => this.entryIndex.set(entry.id, index));
    this.#texts = options.branch.map((entry) => this.describeEntry(entry).text);
  }

  get branch(): SessionEntry[] {
    return this.#branch;
  }

  get previousCoverageEndEntryId(): string | null {
    return this.#previousCoverageEndEntryId;
  }

  /** Entry ids the agent has actually read through the paging tools. Search does not count. */
  get inspectedEntryIds(): ReadonlySet<string> {
    return this.#inspectedEntryIds;
  }

  manifest(): SessionManifest {
    const required = new Set(this.requiredTurnIds());
    const digests = this.turns.map((turn) => this.digestTurn(turn));
    // Required turns are always fully described; the remainder fills the
    // manifest budget head-first so early session context stays visible.
    const prioritized = [
      ...digests.filter((digest) => required.has(digest.turnId)),
      ...digests.filter((digest) => !required.has(digest.turnId)),
    ];
    const turns = prioritized.slice(0, this.#maxManifestTurns);
    return {
      sessionEntryCount: this.#branch.length,
      turnCount: this.turns.length,
      firstEntryId: this.#branch[0]?.id ?? null,
      lastEntryId: this.#branch[this.#branch.length - 1]?.id ?? null,
      previousCoverageEndEntryId: this.#previousCoverageEndEntryId,
      hasPreviousCheckpoint: Boolean(this.#previousCheckpointSummary?.trim()),
      requiredTurnIds: [...required],
      turns,
      manifestTruncated: prioritized.length > turns.length,
      omittedTurnCount: Math.max(0, prioritized.length - turns.length),
    };
  }

  /**
   * Completion requirements (refactor §18): before submitting, the agent
   * must have inspected the first turn, every user-correction turn, every
   * error turn, and every turn past the previous checkpoint's coverage.
   */
  requiredTurnIds(): string[] {
    const required = new Set<string>();
    const first = this.turns[0];
    if (first) required.add(first.id);
    const coverageIdx = this.#previousCoverageEndEntryId
      ? (this.entryIndex.get(this.#previousCoverageEndEntryId) ?? -1)
      : -1;
    for (const turn of this.turns) {
      const digest = this.digestTurn(turn);
      if (digest.hasUserCorrection || digest.hasError) required.add(turn.id);
      const startIdx = this.entryIndex.get(turn.startEntryId) ?? 0;
      if (startIdx > coverageIdx) required.add(turn.id);
    }
    return [...required];
  }

  /** Entry ids the completion requirements demand, for submit validation. */
  requiredEntryIds(): Set<string> {
    const requiredTurns = new Set(this.requiredTurnIds());
    const ids = new Set<string>();
    for (const turn of this.turns) {
      if (requiredTurns.has(turn.id)) {
        for (const id of turn.entryIds) ids.add(id);
      }
    }
    return ids;
  }

  missingRequiredTurnIds(): string[] {
    const required = new Set(this.requiredTurnIds());
    return this.turns
      .filter((turn) => required.has(turn.id) && !turn.entryIds.every((id) => this.#inspectedEntryIds.has(id)))
      .map((turn) => turn.id);
  }

  markInspected(entryIds: string[]): void {
    for (const id of entryIds) this.#inspectedEntryIds.add(id);
  }

  /**
   * Reads entries by branch position. The page stops early once its serialized
   * size reaches the page budget; `nextStart` then names where to continue.
   */
  readEntries(
    start: number,
    count: number,
    maxChars = this.#maxPageChars,
  ): { start: number; end: number; totalEntries: number; entries: ServedEntry[]; nextStart?: number } {
    const totalEntries = this.#branch.length;
    const clampedStart = Math.max(0, Math.min(start, totalEntries));
    const clampedCount = Math.max(1, Math.min(count, 50));
    const requestedEnd = Math.min(totalEntries, clampedStart + clampedCount);
    const indices: number[] = [];
    for (let index = clampedStart; index < requestedEnd; index++) indices.push(index);
    const entries = this.page(indices, maxChars);
    this.markInspected(entries.map((entry) => entry.entryId));
    const end = clampedStart + entries.length;
    return { start: clampedStart, end, totalEntries, entries, ...(end < requestedEnd ? { nextStart: end } : {}) };
  }

  /**
   * Reads whole turns until the page budget is spent. A first turn larger than
   * the budget is served partially with `nextEntryOffset`; continue it with
   * read_session_turn. `nextTurn` names the first requested turn not served.
   */
  readTurnRange(
    startTurn: number,
    count: number,
    maxChars = this.#maxPageChars,
  ): { startTurn: number; endTurn: number; totalTurns: number; turns: ServedTurn[]; nextTurn?: number } {
    const totalTurns = this.turns.length;
    const clampedStart = Math.max(1, Math.min(startTurn, Math.max(1, totalTurns)));
    const clampedCount = Math.max(1, Math.min(count, 25));
    const requestedEnd = Math.min(totalTurns, clampedStart + clampedCount - 1);
    const turns: ServedTurn[] = [];
    let remaining = maxChars;
    for (let number = clampedStart; number <= requestedEnd; number++) {
      const turn = this.turns[number - 1]!;
      const indices = turn.entryIds.map((id) => this.entryIndex.get(id) ?? 0);
      const entries = this.page(indices, remaining, turns.length === 0);
      if (entries.length === 0) break;
      remaining -= servedSize(entries);
      this.markInspected(entries.map((entry) => entry.entryId));
      turns.push(this.servedTurn(turn, entries, 0));
      if (entries.length < turn.entryIds.length) break;
    }
    const endTurn = clampedStart + turns.length - 1;
    return {
      startTurn: clampedStart,
      endTurn,
      totalTurns,
      turns,
      ...(endTurn < requestedEnd ? { nextTurn: endTurn + 1 } : {}),
    };
  }

  /** Reads one turn from `entryOffset`, paged by the same budget as the other readers. */
  readTurn(turnId: string, entryOffset = 0, maxChars = this.#maxPageChars): ServedTurn {
    const turn = this.turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`Unknown turn: ${turnId}`);
    const offset = Math.max(0, Math.min(Math.floor(entryOffset), Math.max(0, turn.entryIds.length - 1)));
    const indices = turn.entryIds.slice(offset).map((id) => this.entryIndex.get(id) ?? 0);
    const entries = this.page(indices, maxChars);
    this.markInspected(entries.map((entry) => entry.entryId));
    return this.servedTurn(turn, entries, offset);
  }

  private servedTurn(turn: SessionTurn, entries: ServedEntry[], offset: number): ServedTurn {
    const next = offset + entries.length;
    return {
      turnId: turn.id,
      index: turn.index,
      startEntryId: turn.startEntryId,
      endEntryId: turn.endEntryId,
      entryCount: turn.entryIds.length,
      ...(offset > 0 ? { entryOffset: offset } : {}),
      ...(next < turn.entryIds.length ? { nextEntryOffset: next } : {}),
      entries,
    };
  }

  /**
   * Serves branch positions in order until `budget` serialized characters are
   * used. A page always serves at least one entry unless `partial` is false,
   * in which case it serves all of `indices` or nothing. Does not mark inspection.
   */
  private page(indices: number[], budget: number, partial = true): ServedEntry[] {
    const entries: ServedEntry[] = [];
    let used = 0;
    for (const index of indices) {
      const entry = this.servedEntry(index);
      const size = servedSize([entry]);
      if (used + size > budget && (entries.length > 0 || !partial)) {
        return partial ? entries : [];
      }
      entries.push(entry);
      used += size;
    }
    return entries;
  }

  private servedEntry(index: number): ServedEntry {
    const entry = this.#branch[index]!;
    return {
      evidenceId: evidenceIdForEntryIndex(index),
      entryId: entry.id,
      kind: this.describeEntry(entry).kind,
      text: this.#texts[index]!,
    };
  }

  searchSessionHistory(query: string, limit = MAX_SEARCH_HITS): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (let index = 0; index < this.#branch.length && hits.length < Math.max(1, Math.min(limit, 25)); index++) {
      const text = this.#texts[index]!;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const entry = this.#branch[index]!;
      const turn = this.turns.find((candidate) => candidate.entryIds.includes(entry.id));
      const snippetStart = Math.max(0, at - 80);
      hits.push({
        turnId: turn?.id ?? "turn-?",
        entryId: entry.id,
        evidenceId: evidenceIdForEntryIndex(index),
        snippet: text.slice(snippetStart, snippetStart + 200),
      });
    }
    return hits;
  }

  previousCheckpoint(): { evidenceId: string; coverageEndEntryId: string | null; summary: string } | null {
    if (!this.#previousCheckpointSummary?.trim()) return null;
    return {
      evidenceId: PREVIOUS_CHECKPOINT_EVIDENCE_ID,
      coverageEndEntryId: this.#previousCoverageEndEntryId,
      summary: sanitizeForContext(this.#previousCheckpointSummary, this.#cwd),
    };
  }

  private digestTurn(turn: SessionTurn): TurnDigest {
    let userPreview = "";
    let hasUserCorrection = false;
    let hasError = false;
    let hasQuestion = false;
    let chars = 0;
    for (const id of turn.entryIds) {
      const index = this.entryIndex.get(id) ?? 0;
      const described = this.describeEntry(this.#branch[index]!);
      chars += described.text.length;
      if (described.kind === "user") {
        if (!userPreview) userPreview = described.text.slice(0, this.#maxPreviewChars);
        if (CORRECTION_SIGNALS.test(described.text)) hasUserCorrection = true;
        if (described.text.includes("?")) hasQuestion = true;
      }
      if (described.kind === "tool_result_error" || described.kind === "bash_error") hasError = true;
    }
    return {
      turnId: turn.id,
      index: turn.index,
      startEntryId: turn.startEntryId,
      endEntryId: turn.endEntryId,
      entryCount: turn.entryIds.length,
      userPreview,
      hasUserCorrection,
      hasError,
      hasQuestion,
      tokenEstimate: estimateTokens(this.#texts.slice(
        this.entryIndex.get(turn.startEntryId) ?? 0,
        (this.entryIndex.get(turn.endEntryId) ?? 0) + 1,
      ).join("\n")),
    };
  }

  private describeEntry(entry: SessionEntry): { kind: string; text: string } {
    if (entry.type !== "message") {
      if (entry.type === "compaction") {
        const summary = (entry as { summary?: unknown }).summary;
        return {
          kind: "native_compaction",
          text: typeof summary === "string" ? `native compaction summary:\n${this.bounded(summary)}` : "native compaction",
        };
      }
      return { kind: entry.type, text: "" };
    }
    const message = (entry as { message: Record<string, unknown> }).message;
    if (!message || typeof message !== "object") return { kind: "unknown", text: "" };
    const role = message.role;
    if (role === "user") {
      return { kind: "user", text: this.bounded(contentText(message.content)) };
    }
    if (role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const textParts: string[] = [];
      const callParts: string[] = [];
      for (const part of parts) {
        if (part?.type === "text" && part.text) textParts.push(part.text);
        else if (part?.type === "toolCall") {
          callParts.push(`tool: ${part.name}\nargs: ${JSON.stringify(redactSecretValue(part.arguments ?? {}))}`);
        }
      }
      const text = [...textParts, ...callParts].join("\n").trim();
      return { kind: callParts.length > 0 ? "assistant_tool_call" : "assistant", text: this.bounded(text) };
    }
    if (role === "toolResult") {
      const isError = message.isError === true;
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      const output = contentText(message.content);
      return {
        kind: isError ? "tool_result_error" : "tool_result",
        text: this.bounded(`tool: ${toolName}\nstatus: ${isError ? "error" : "ok"}\noutput:\n${output}`),
      };
    }
    if (role === "bashExecution") {
      if (message.excludeFromContext === true) return { kind: "bash", text: "" };
      const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return {
        kind: failed ? "bash_error" : "bash",
        text: this.bounded(`command: ${command}\nexit: ${message.exitCode ?? "unknown"}\noutput:\n${output}`),
      };
    }
    if (role === "custom" || role === "branchSummary") {
      return { kind: String(role), text: this.bounded(contentText(message.content) || String(message.summary ?? "")) };
    }
    return { kind: String(role ?? "unknown"), text: "" };
  }

  private bounded(text: string): string {
    const sanitized = sanitizeForContext(text, this.#cwd);
    if (sanitized.length <= MAX_ENTRY_TEXT_CHARS) return sanitized;
    const marker = `\n...[truncated ${sanitized.length - MAX_ENTRY_TEXT_CHARS} chars]...\n`;
    const available = MAX_ENTRY_TEXT_CHARS - marker.length;
    const head = Math.ceil(available / 2);
    return sanitized.slice(0, head) + marker + sanitized.slice(sanitized.length - (available - head));
  }
}

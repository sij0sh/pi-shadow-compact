import type { ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NORMALIZED_PACKET_MAX_CHARS = 240_000;

/**
 * Token-to-character heuristic for evidence budgets. Model context windows
 * (and therefore the budgets derived from them) are denominated in tokens,
 * while the normalized packet is measured in JSON characters. A single
 * named ratio keeps the conversion in one place; 4 chars/token is the
 * standard heuristic for mixed code-and-prose transcripts.
 */
export const CHARS_PER_TOKEN = 4;

/** Converts a token-denominated budget into the characters normalizeSnapshot enforces. */
export function tokensToChars(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens) * CHARS_PER_TOKEN;
}

const TEXT_LIMIT = 40_000;
const ARG_LIMIT = 10_000;
const OUTPUT_LIMIT = 24_000;
const DIFF_LIMIT = 32_000;
/** Head preview carried per overflow record and manifest line. */
const OVERFLOW_PREVIEW_CHARS = 120;
/** Upper bound on the rendered archive manifest embedded in summarizer prompts. */
export const MANIFEST_MAX_CHARS = 12_000;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|passwd|secret|token)/i;

/** Pseudo source-entry id for the native previous-summary checkpoint slot. */
export const NATIVE_CHECKPOINT_SOURCE_ID = "checkpoint";

/** Pseudo source-entry id prefix for Shadow-chain checkpoint slots (oldest first). */
export function shadowCheckpointSourceId(index: number): string {
  return `shadow-checkpoint-${index + 1}`;
}

export interface NormalizedEvidence {
  evidenceId: string;
  sourceEntryId: string;
  kind:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "branch_summary"
    | "custom_message"
    | "bash"
    | "previous_checkpoint";
  text: string;
}

/**
 * Evidence that did not fit the packet but remains addressable within this
 * preparation. `fullText` is the complete normalized text (the truncated
 * middle for per-item overflows, the whole item for packet evictions), keyed
 * by the same stable evidence id the packet uses, so the summarizer can
 * request it by id and cite it after it is supplied.
 */
export interface OverflowRecord {
  evidenceId: string;
  sourceEntryId: string;
  kind: NormalizedEvidence["kind"];
  reason: "evicted" | "truncated";
  preview: string;
  fullText: string;
}

export interface NormalizedPacket {
  evidence: NormalizedEvidence[];
  /**
   * Addressable overflow, oldest-evicted first. The branch remains the
   * durable store (sessions are append-only); these records travel with the
   * packet so the retrieval handshake can re-inject them by id without
   * re-reading the branch.
   */
  overflow: OverflowRecord[];
  /** Rendered archive manifest for prompt embedding (bounded by MANIFEST_MAX_CHARS). */
  manifest: string;
  /** Overflow records omitted from the rendered manifest by its char cap. */
  manifestOmitted: number;
  /**
   * Long-session eviction telemetry (fix: instrument the 240k-char budget
   * instead of changing it). rawEvidenceCount is the evidence-item count
   * before budget eviction; normalizedEvidenceCount is the retained count
   * (always evidence.length); evictedEvidenceCount is the difference, and
   * packetTruncated is whether any oldest-first eviction occurred. The
   * retained source-entry id range tells whether the summarizer is still
   * seeing the full raw history (evictedEvidenceCount = 0) or has started
   * losing the oldest evidence to the budget.
   */
  rawEvidenceCount: number;
  normalizedEvidenceCount: number;
  evictedEvidenceCount: number;
  /** Items retained but with their middle truncated by per-item caps. */
  truncatedItemCount: number;
  packetTruncated: boolean;
  oldestRetainedSourceEntryId: string | null;
  newestRetainedSourceEntryId: string | null;
}

export interface NormalizeInput {
  cwd: string;
  previousSummary?: string;
  /**
   * Shadow summary chain, oldest first (see collectShadowSummaries). Each
   * becomes its own protected leading previous_checkpoint slot behind the
   * native previousSummary, so post-compaction checkpoints still see
   * Shadow coverage instead of only the native summary.
   */
  shadowSummaries?: string[];
  /** Chronological entries to summarize, including any split-turn prefix. */
  entries: SessionEntry[];
}

interface DraftEvidence {
  sourceEntryId: string;
  kind: NormalizedEvidence["kind"];
  text: string;
}

interface CallInfo {
  name: string;
  args: Record<string, unknown>;
}

/** Full normalized text of a draft whose middle was cut by a per-item cap. */
interface TruncatedOverflow {
  draftIndex: number;
  sourceEntryId: string;
  kind: NormalizedEvidence["kind"];
  fullText: string;
}

export function normalizeSnapshot(input: NormalizeInput, maxChars = NORMALIZED_PACKET_MAX_CHARS): NormalizedPacket {
  const calls = new Map<string, CallInfo>();
  const truncated: TruncatedOverflow[] = [];
  const drafts: DraftEvidence[] = [];
  if (input.previousSummary?.trim()) {
    drafts.push(
      normalizeDraft(NATIVE_CHECKPOINT_SOURCE_ID, "previous_checkpoint", input.previousSummary, input.cwd, TEXT_LIMIT, drafts.length, truncated),
    );
  }
  let shadowSlot = 0;
  for (const summary of input.shadowSummaries ?? []) {
    if (!summary.trim()) continue;
    drafts.push(
      normalizeDraft(
        shadowCheckpointSourceId(shadowSlot++),
        "previous_checkpoint",
        summary,
        input.cwd,
        TEXT_LIMIT,
        drafts.length,
        truncated,
      ),
    );
  }
  for (const entry of input.entries) {
    for (const draft of normalizeEntry(entry, input.cwd, calls, drafts.length, truncated)) {
      drafts.push(draft);
    }
  }
  // Evidence ids are assigned once, before eviction, and never renumbered:
  // overflow records and the manifest cite these ids, so they must stay
  // stable between the packet, the manifest, and any retrieval round.
  const evidence = numberEvidence(drafts);
  const rawEvidenceCount = evidence.length;
  // Draft indices align with pre-eviction evidence positions (no renumbering),
  // so truncated middles resolve to stable ids before any eviction shifts them.
  const idByDraftIndex = evidence.map((item) => item.evidenceId);
  const truncatedById = new Map<string, TruncatedOverflow>();
  for (const record of truncated) {
    const evidenceId = idByDraftIndex[record.draftIndex];
    if (evidenceId !== undefined) truncatedById.set(evidenceId, record);
  }
  // Leading checkpoint slots (native + Shadow chain) are never evicted:
  // they are the sole carriers of pre-window context.
  let protectedCount = 0;
  while (evidence[protectedCount]?.kind === "previous_checkpoint") protectedCount++;
  const overflow: OverflowRecord[] = [];
  while (packetSize(evidence) > maxChars) {
    const victim = evictionVictim(evidence, protectedCount);
    if (victim < 0) break;
    const [removed] = evidence.splice(victim, 1);
    if (!removed) break;
    const truncatedFull = truncatedById.get(removed.evidenceId);
    if (truncatedFull) truncatedById.delete(removed.evidenceId);
    overflow.push(toOverflow(removed, truncatedFull?.fullText ?? removed.text, truncatedFull ? "truncated" : "evicted"));
  }
  // Retained-but-truncated items stay citable in the packet; their middles
  // join the overflow so the model can still address them by id.
  for (const [evidenceId, record] of truncatedById) {
    overflow.push(toOverflow(
      { evidenceId, sourceEntryId: record.sourceEntryId, kind: record.kind },
      record.fullText,
      "truncated",
    ));
  }
  const evictedEvidenceCount = overflow.filter((item) => item.reason === "evicted").length;
  const truncatedItemCount = overflow.filter((item) => item.reason === "truncated").length;
  const { manifest, omitted: manifestOmitted } = renderManifest(overflow);
  // The retained-id range covers transcript evidence only: the pinned
  // checkpoint slots carry pseudo-ids, which are not raw-history entries
  // and would mask the eviction boundary.
  const transcript = evidence.filter((item) => item.kind !== "previous_checkpoint");
  return {
    evidence,
    overflow,
    manifest,
    manifestOmitted,
    rawEvidenceCount,
    normalizedEvidenceCount: evidence.length,
    evictedEvidenceCount,
    truncatedItemCount,
    packetTruncated: evictedEvidenceCount > 0,
    oldestRetainedSourceEntryId: transcript[0]?.sourceEntryId ?? null,
    newestRetainedSourceEntryId: transcript[transcript.length - 1]?.sourceEntryId ?? null,
  };
}

/**
 * Middle-out eviction. The head (oldest transcript evidence, usually the
 * initial goal) and the tail (newest work, adjacent to the kept suffix) are
 * pinned; the middle drains oldest-first. Under extreme pressure only two
 * transcript items fit then one: the binary choice keeps the newest, and a
 * lone checkpoint is the last resort before the caller fails closed.
 */
function evictionVictim(evidence: NormalizedEvidence[], protectedCount: number): number {
  const transcript: number[] = [];
  for (let index = protectedCount; index < evidence.length; index++) {
    if (evidence[index]?.kind !== "previous_checkpoint") transcript.push(index);
  }
  if (transcript.length === 0) return -1;
  if (transcript.length <= 2) return transcript[0]!;
  return transcript[1]!;
}

function toOverflow(
  item: Pick<NormalizedEvidence, "evidenceId" | "sourceEntryId" | "kind">,
  fullText: string,
  reason: OverflowRecord["reason"],
): OverflowRecord {
  return {
    evidenceId: item.evidenceId,
    sourceEntryId: item.sourceEntryId,
    kind: item.kind,
    reason,
    preview: fullText.length > OVERFLOW_PREVIEW_CHARS ? `${fullText.slice(0, OVERFLOW_PREVIEW_CHARS)}…` : fullText,
    fullText,
  };
}

function renderManifest(overflow: OverflowRecord[]): { manifest: string; omitted: number } {
  const lines: string[] = [];
  let omitted = 0;
  for (const item of overflow) {
    const line = JSON.stringify({
      id: item.evidenceId,
      kind: item.kind,
      source: item.sourceEntryId,
      reason: item.reason,
      preview: item.preview,
    });
    lines.push(line);
  }
  let manifest = lines.length > 0 ? `[\n${lines.join(",\n")}\n]` : "";
  while (manifest.length > MANIFEST_MAX_CHARS && lines.length > 0) {
    lines.pop();
    omitted++;
    manifest = `[\n${lines.join(",\n")}\n]`;
  }
  if (lines.length === 0 && omitted > 0) manifest = "";
  return { manifest, omitted };
}

function normalizeEntry(
  entry: SessionEntry,
  cwd: string,
  calls: Map<string, CallInfo>,
  baseIndex: number,
  truncated: TruncatedOverflow[],
): DraftEvidence[] {
  if (entry.type === "branch_summary") {
    return [normalizeDraft(entry.id, "branch_summary", entry.summary, cwd, TEXT_LIMIT, baseIndex, truncated)];
  }
  if (entry.type === "custom_message") {
    const text = contentText(entry.content);
    return text ? [normalizeDraft(entry.id, "custom_message", text, cwd, TEXT_LIMIT, baseIndex, truncated)] : [];
  }
  if (entry.type !== "message") return [];

  const message = entry.message;
  if (message.role === "user") {
    const text = contentText(message.content);
    return text ? [normalizeDraft(entry.id, "user", text, cwd, TEXT_LIMIT, baseIndex, truncated)] : [];
  }
  if (message.role === "assistant") {
    const result: DraftEvidence[] = [];
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text) {
      result.push(normalizeDraft(entry.id, "assistant", text, cwd, TEXT_LIMIT, baseIndex + result.length, truncated));
    }
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      calls.set(part.id, { name: part.name, args: part.arguments });
      result.push(toolCallDraft(entry.id, part, cwd, baseIndex + result.length, truncated));
    }
    return result;
  }
  if (message.role === "toolResult") {
    const call = calls.get(message.toolCallId);
    const name = message.toolName || call?.name || "unknown";
    const output = contentText(message.content);
    const fields = [`tool: ${name}`, `status: ${message.isError ? "error" : "ok"}`];
    if (output) {
      fields.push(`output:\n${boundedField(entry.id, "tool_result", normalizeString(output, cwd), OUTPUT_LIMIT, baseIndex, truncated)}`);
    }
    const diff = getDiff(message.details);
    if (diff) {
      fields.push(`diff:\n${boundedField(entry.id, "tool_result", normalizeString(diff, cwd), DIFF_LIMIT, baseIndex, truncated)}`);
    }
    return [{ sourceEntryId: entry.id, kind: "tool_result", text: fields.join("\n") }];
  }
  if (message.role === "bashExecution") {
    if (message.excludeFromContext) return [];
    const fields = [
      `command: ${boundedField(entry.id, "bash", normalizeString(message.command, cwd), ARG_LIMIT, baseIndex, truncated)}`,
      `exit: ${message.exitCode ?? (message.cancelled ? "cancelled" : "unknown")}`,
    ];
    if (message.output) {
      fields.push(`output:\n${boundedField(entry.id, "bash", normalizeString(message.output, cwd), OUTPUT_LIMIT, baseIndex, truncated)}`);
    }
    return [{ sourceEntryId: entry.id, kind: "bash", text: fields.join("\n") }];
  }
  if (message.role === "custom") {
    const text = contentText(message.content);
    return text ? [normalizeDraft(entry.id, "custom_message", text, cwd, TEXT_LIMIT, baseIndex, truncated)] : [];
  }
  if (message.role === "branchSummary") {
    return [normalizeDraft(entry.id, "branch_summary", message.summary, cwd, TEXT_LIMIT, baseIndex, truncated)];
  }
  return [];
}

function toolCallDraft(
  sourceEntryId: string,
  call: ToolCall,
  cwd: string,
  draftIndex: number,
  truncated: TruncatedOverflow[],
): DraftEvidence {
  const args = stableValue(call.arguments, cwd);
  const fullText = `tool: ${call.name}\nargs: ${JSON.stringify(args)}`;
  const normalized = normalizeString(fullText, cwd);
  if (normalized.length > ARG_LIMIT) {
    truncated.push({ draftIndex, sourceEntryId, kind: "tool_call", fullText: normalized });
  }
  return {
    sourceEntryId,
    kind: "tool_call",
    text: `tool: ${call.name}\nargs: ${bounded(JSON.stringify(args), ARG_LIMIT)}`,
  };
}

function normalizeDraft(
  sourceEntryId: string,
  kind: DraftEvidence["kind"],
  text: string,
  cwd: string,
  limit: number,
  draftIndex: number,
  truncated: TruncatedOverflow[],
): DraftEvidence {
  const normalized = normalizeString(text, cwd);
  if (normalized.length > limit) {
    truncated.push({ draftIndex, sourceEntryId, kind, fullText: normalized });
  }
  return { sourceEntryId, kind, text: bounded(normalized, limit) };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text"),
    )
    .map((part) => part.text)
    .join("\n");
}

function stableValue(value: unknown, cwd: string, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return normalizeString(value, cwd);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, cwd, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, stableValue(child, cwd, childKey)]),
    );
  }
  return value;
}

function normalizeString(value: string, cwd: string): string {
  let result = value.replace(/\r\n?/g, "\n");
  result = result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  result = result.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  result = result.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]");
  result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]");
  result = result.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  result = result.replace(
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PASSWD|SECRET|CREDENTIALS?))(\s*[=:]\s*)(?:["'][^\r\n]*?["']|[^\s,;]+)/g,
    "$1$2[REDACTED]",
  );
  result = result.replace(
    /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|token)\b(\s*[=:]\s*)(?:["'][^\r\n]*?["']|[^\s,;]+)/gi,
    "$1$2[REDACTED]",
  );
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedCwd) {
    result = result.replace(/\\/g, "/");
    result = result.replace(new RegExp(`${escapeRegExp(normalizedCwd)}(?=\/|\\b)`, "g"), ".");
  }
  return result;
}

function getDiff(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as { diff?: unknown; patch?: unknown };
  const diff = typeof value.patch === "string" ? value.patch : value.diff;
  return typeof diff === "string" && diff ? diff : undefined;
}

/**
 * Bounds one composite field (tool output, diff, command) while registering
 * its full normalized text for the retrieval handshake when cut. draftIndex
 * is the owning draft's pre-eviction position (these roles emit one draft).
 */
function boundedField(
  sourceEntryId: string,
  kind: DraftEvidence["kind"],
  value: string,
  limit: number,
  draftIndex: number,
  truncated: TruncatedOverflow[],
): string {
  if (value.length > limit) {
    truncated.push({ draftIndex, sourceEntryId, kind, fullText: value });
  }
  return bounded(value, limit);
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n...[truncated ${value.length - limit} chars]...\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return value.slice(0, head) + marker + value.slice(value.length - (available - head));
}

function evidenceId(index: number): string {
  return `E${String(index + 1).padStart(4, "0")}`;
}

function numberEvidence(drafts: DraftEvidence[]): NormalizedEvidence[] {
  return drafts.map((draft, index) => ({ evidenceId: evidenceId(index), ...draft }));
}

function packetSize(evidence: NormalizedEvidence[]): number {
  return JSON.stringify({ evidence }).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

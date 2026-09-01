import type { ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NORMALIZED_PACKET_MAX_CHARS = 240_000;

const TEXT_LIMIT = 40_000;
const ARG_LIMIT = 10_000;
const OUTPUT_LIMIT = 24_000;
const DIFF_LIMIT = 32_000;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|passwd|secret|token)/i;

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

export interface NormalizedPacket {
  evidence: NormalizedEvidence[];
}

export interface NormalizeInput {
  cwd: string;
  previousSummary?: string;
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

export function normalizeSnapshot(input: NormalizeInput, maxChars = NORMALIZED_PACKET_MAX_CHARS): NormalizedPacket {
  const calls = new Map<string, CallInfo>();
  const drafts = input.previousSummary?.trim()
    ? [normalizeDraft("checkpoint", "previous_checkpoint", input.previousSummary, input.cwd, TEXT_LIMIT), ...input.entries.flatMap((entry) => normalizeEntry(entry, input.cwd, calls))]
    : input.entries.flatMap((entry) => normalizeEntry(entry, input.cwd, calls));
  let evidence = numberEvidence(drafts);
  // The promoted checkpoint leads the packet, so eviction must skip its slot;
  // it is the sole carrier of pre-compaction context.
  const protectedCount = evidence[0]?.kind === "previous_checkpoint" ? 1 : 0;
  while (evidence.length > protectedCount && packetSize(evidence) > maxChars) {
    evidence.splice(protectedCount, 1);
    evidence = renumber(evidence);
  }
  return { evidence };
}

function normalizeEntry(entry: SessionEntry, cwd: string, calls: Map<string, CallInfo>): DraftEvidence[] {
  if (entry.type === "branch_summary") {
    return [normalizeDraft(entry.id, "branch_summary", entry.summary, cwd, TEXT_LIMIT)];
  }
  if (entry.type === "custom_message") {
    const text = contentText(entry.content);
    return text ? [normalizeDraft(entry.id, "custom_message", text, cwd, TEXT_LIMIT)] : [];
  }
  if (entry.type !== "message") return [];

  const message = entry.message;
  if (message.role === "user") {
    const text = contentText(message.content);
    return text ? [normalizeDraft(entry.id, "user", text, cwd, TEXT_LIMIT)] : [];
  }
  if (message.role === "assistant") {
    const result: DraftEvidence[] = [];
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text) result.push(normalizeDraft(entry.id, "assistant", text, cwd, TEXT_LIMIT));
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      calls.set(part.id, { name: part.name, args: part.arguments });
      result.push(toolCallDraft(entry.id, part, cwd));
    }
    return result;
  }
  if (message.role === "toolResult") {
    const call = calls.get(message.toolCallId);
    const name = message.toolName || call?.name || "unknown";
    const output = contentText(message.content);
    const fields = [`tool: ${name}`, `status: ${message.isError ? "error" : "ok"}`];
    if (output) fields.push(`output:\n${bounded(normalizeString(output, cwd), OUTPUT_LIMIT)}`);
    const diff = getDiff(message.details);
    if (diff) fields.push(`diff:\n${bounded(normalizeString(diff, cwd), DIFF_LIMIT)}`);
    return [{ sourceEntryId: entry.id, kind: "tool_result", text: fields.join("\n") }];
  }
  if (message.role === "bashExecution") {
    if (message.excludeFromContext) return [];
    const fields = [
      `command: ${bounded(normalizeString(message.command, cwd), ARG_LIMIT)}`,
      `exit: ${message.exitCode ?? (message.cancelled ? "cancelled" : "unknown")}`,
    ];
    if (message.output) fields.push(`output:\n${bounded(normalizeString(message.output, cwd), OUTPUT_LIMIT)}`);
    return [{ sourceEntryId: entry.id, kind: "bash", text: fields.join("\n") }];
  }
  if (message.role === "custom") {
    const text = contentText(message.content);
    return text ? [normalizeDraft(entry.id, "custom_message", text, cwd, TEXT_LIMIT)] : [];
  }
  if (message.role === "branchSummary") {
    return [normalizeDraft(entry.id, "branch_summary", message.summary, cwd, TEXT_LIMIT)];
  }
  return [];
}

function toolCallDraft(sourceEntryId: string, call: ToolCall, cwd: string): DraftEvidence {
  const args = stableValue(call.arguments, cwd);
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
): DraftEvidence {
  return { sourceEntryId, kind, text: bounded(normalizeString(text, cwd), limit) };
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

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n...[truncated ${value.length - limit} chars]...\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return value.slice(0, head) + marker + value.slice(value.length - (available - head));
}

function numberEvidence(drafts: DraftEvidence[]): NormalizedEvidence[] {
  return drafts.map((draft, index) => ({ evidenceId: `E${String(index + 1).padStart(4, "0")}`, ...draft }));
}

function renumber(evidence: NormalizedEvidence[]): NormalizedEvidence[] {
  return evidence.map((item, index) => ({ ...item, evidenceId: `E${String(index + 1).padStart(4, "0")}` }));
}

function packetSize(evidence: NormalizedEvidence[]): number {
  return JSON.stringify({ evidence }).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token-to-character heuristic for context budgets. Model context windows
 * (and therefore the budgets derived from them) are denominated in tokens
 * while served text is measured in characters. A single named ratio keeps
 * the conversion in one place; 4 chars/token is the standard heuristic for
 * mixed code-and-prose transcripts.
 */
export const CHARS_PER_TOKEN = 4;

/** Converts a token-denominated budget into characters. */
export function tokensToChars(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens) * CHARS_PER_TOKEN;
}

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|passwd|secret|token)/i;

/** Redacts a structured value whose key names a secret (tool arguments, metadata). */
export function redactSecretValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeForContext(value, "");
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, redactSecretValue(child, childKey)]),
    );
  }
  return value;
}

/**
 * Canonical sanitization for any session text re-entering model context:
 * secret redaction plus cwd normalization. Agent reads are verbatim from
 * this representation, never byte-for-byte raw session JSON.
 */
export function sanitizeForContext(value: string, cwd: string): string {
  let result = value.replace(/\r\n?/g, "\n");
  result = result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  result = result.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  result = result.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]");
  result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]");
  result = result.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  // The secret keyword may sit anywhere in the variable name: SECRET_KEY,
  // AWS_SECRET_ACCESS_KEY, and SECRET_TOKEN are secrets even though they
  // end in KEY/TOKEN. Fail closed on names that merely contain the keyword
  // (TOKEN_COUNT loses its value) rather than leak a real assignment.
  result = result.replace(
    /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)(?:["'][^\r\n]*?["']|[^\s,;]+)/g,
    "$1$2[REDACTED]",
  );
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:["'][^\r\n]*?["']|[^\s,;]+)/gi,
    "$1$2[REDACTED]",
  );
  result = result.replace(
    /(["'][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token|credential)[A-Za-z0-9_-]*["']\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[REDACTED]"',
  );
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedCwd) {
    result = result.replace(/\\/g, "/");
    result = result.replace(new RegExp(`${escapeRegExp(normalizedCwd)}(?=\/|\\b)`, "g"), ".");
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { readFile } from "node:fs/promises";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, SnapshotIdentity } from "./types.js";

const LEAF_READ_ATTEMPTS = 4;
const LEAF_RETRY_DELAY_MS = 10;

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Invalid session snapshot: ${message}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonl(source: string): unknown[] {
  const finalNewline = source.lastIndexOf("\n");
  if (finalNewline < 0) fail("session file has no complete JSONL records");

  const lines = source.slice(0, finalNewline).split("\n");
  if (lines.length === 1 && lines[0] === "") fail("session file is empty");

  return lines.map((line, index) => {
    if (line.length === 0) fail(`blank JSONL record at line ${index + 1}`);
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return fail(`invalid JSON at line ${index + 1}`);
    }
  });
}

function validateHeader(value: unknown, sessionId: string): SessionHeader {
  if (!isObject(value) || value.type !== "session") fail("first record is not a session header");
  if (typeof value.id !== "string" || value.id.length === 0) fail("header has no session ID");
  if (value.id !== sessionId) fail(`header session ID ${value.id} does not match ${sessionId}`);
  if (typeof value.timestamp !== "string" || typeof value.cwd !== "string") {
    fail("header is missing timestamp or cwd");
  }
  return value as unknown as SessionHeader;
}

function validateEntries(values: readonly unknown[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();

  for (const [index, value] of values.entries()) {
    if (!isObject(value) || value.type === "session") fail(`invalid entry at record ${index + 2}`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      fail(`entry at record ${index + 2} has no ID`);
    }
    if (byId.has(value.id)) fail(`duplicate entry ID ${value.id}`);
    if (value.parentId !== null && (typeof value.parentId !== "string" || value.parentId.length === 0)) {
      fail(`entry ${value.id} has an invalid parent ID`);
    }
    if (typeof value.timestamp !== "string") fail(`entry ${value.id} has no timestamp`);

    const entry = value as unknown as SessionEntry;
    entries.push(entry);
    byId.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      fail(`entry ${entry.id} refers to missing parent ${entry.parentId}`);
    }
  }

  for (const entry of entries) {
    const seen = new Set<string>();
    let current: SessionEntry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) fail(`parent cycle contains entry ${current.id}`);
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }

  return entries;
}

function activeBranch(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  if (!current) fail(`captured leaf ${leafId} is absent`);

  const reversed: SessionEntry[] = [];
  while (current) {
    reversed.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return reversed.reverse();
}

function finishSnapshot(
  identity: SnapshotIdentity,
  cwd: string,
  entries: readonly SessionEntry[],
  source: SessionSnapshot["source"],
): SessionSnapshot {
  const branch = activeBranch(entries, identity.leafId);
  const firstKeptIndex = branch.findIndex((entry) => entry.id === identity.firstKeptEntryId);
  if (firstKeptIndex < 0) {
    fail(`first kept entry ${identity.firstKeptEntryId} is not on the captured branch`);
  }

  const sourceEntries = branch.slice(0, firstKeptIndex);
  let previousSummary: string | undefined;
  for (let index = sourceEntries.length - 1; index >= 0; index--) {
    const entry = sourceEntries[index];
    if (entry?.type === "compaction") {
      previousSummary = entry.summary;
      break;
    }
  }

  return {
    ...identity,
    cwd,
    branch,
    sourceEntries,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    source,
  };
}

function identityFor(event: SessionBeforeCompactEvent, ctx: ExtensionContext): SnapshotIdentity {
  const sessionId = ctx.sessionManager.getSessionId();
  const leafId = ctx.sessionManager.getLeafId();
  if (!sessionId) fail("session manager has no session ID");
  if (!leafId) fail("session manager has no active leaf");

  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    ...(sessionFile === undefined ? {} : { sessionFile }),
    sessionId,
    leafId,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
  };
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, LEAF_RETRY_DELAY_MS));
}

export async function captureSessionSnapshot(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<SessionSnapshot> {
  const identity = identityFor(event, ctx);
  if (!identity.sessionFile) {
    const entries = validateEntries(event.branchEntries);
    return finishSnapshot(identity, ctx.sessionManager.getCwd(), entries, "branchEntries");
  }

  for (let attempt = 1; attempt <= LEAF_READ_ATTEMPTS; attempt++) {
    let contents: string;
    try {
      contents = await readFile(identity.sessionFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const entries = validateEntries(event.branchEntries);
        return finishSnapshot(identity, ctx.sessionManager.getCwd(), entries, "branchEntries");
      }
      throw error;
    }

    const records = parseJsonl(contents);
    const header = validateHeader(records[0], identity.sessionId);
    const entries = validateEntries(records.slice(1));
    if (entries.some((entry) => entry.id === identity.leafId)) {
      return finishSnapshot(identity, header.cwd, entries, "jsonl");
    }
    if (attempt < LEAF_READ_ATTEMPTS) await pause();
  }

  return fail(`captured leaf ${identity.leafId} did not appear in the session file`);
}

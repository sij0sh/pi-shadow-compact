import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { captureSessionSnapshot } from "../src/session-snapshot.js";

function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: id, timestamp: 0 },
    ...extra,
  } as SessionEntry;
}

function event(branchEntries: SessionEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    branchEntries,
    preparation: { firstKeptEntryId } as SessionBeforeCompactEvent["preparation"],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function context(options: {
  entries: SessionEntry[];
  leafId: string;
  sessionFile?: string;
  sessionId?: string;
}): ExtensionContext {
  const sessionId = options.sessionId ?? "session-1";
  return {
    cwd: "/fallback-cwd",
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => options.leafId,
      getSessionFile: () => options.sessionFile,
      getCwd: () => "/fallback-cwd",
    },
  } as unknown as ExtensionContext;
}

async function sessionFile(records: unknown[], finalNewline = true): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-snapshot-"));
  const path = join(dir, "session.jsonl");
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (finalNewline ? "\n" : "");
  await writeFile(path, text);
  return { dir, path };
}

const header = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/recorded-cwd",
};

test("captures the selected branch and excludes firstKeptEntryId from source", async () => {
  const root = entry("root", null);
  const old = entry("old", "root");
  const kept = entry("kept", "old");
  const leaf = entry("leaf", "kept");
  const other = entry("other", "root");
  const appendedDescendant = entry("later", "leaf");
  const file = await sessionFile([header, root, old, kept, leaf, other, appendedDescendant]);

  try {
    const snapshot = await captureSessionSnapshot(
      event([root, old, kept, leaf], "kept"),
      context({ entries: [root, old, kept, leaf], leafId: "leaf", sessionFile: file.path }),
    );

    assert.equal(snapshot.source, "jsonl");
    assert.equal(snapshot.cwd, "/recorded-cwd");
    assert.deepEqual(snapshot.branch.map(({ id }) => id), ["root", "old", "kept", "leaf"]);
    assert.deepEqual(snapshot.sourceEntries.map(({ id }) => id), ["root", "old"]);
  } finally {
    await rm(file.dir, { recursive: true, force: true });
  }
});

test("falls back to branchEntries and finds the latest prior compaction", async () => {
  const root = entry("root", null);
  const first = {
    ...entry("compact-1", "root"),
    type: "compaction",
    summary: "older",
    firstKeptEntryId: "middle",
    tokensBefore: 10,
  } as SessionEntry;
  const middle = entry("middle", "compact-1");
  const latest = {
    ...entry("compact-2", "middle"),
    type: "compaction",
    summary: "latest",
    firstKeptEntryId: "kept",
    tokensBefore: 20,
  } as SessionEntry;
  const kept = entry("kept", "compact-2");
  const leaf = entry("leaf", "kept");
  const entries = [root, first, middle, latest, kept, leaf];

  const snapshot = await captureSessionSnapshot(
    event(entries, "kept"),
    context({ entries, leafId: "leaf" }),
  );

  assert.equal(snapshot.source, "branchEntries");
  assert.equal(snapshot.sessionFile, undefined);
  assert.deepEqual(snapshot.sourceEntries.map(({ id }) => id), ["root", "compact-1", "middle", "compact-2"]);
  assert.equal(snapshot.previousSummary, "latest");
});

test("retries while the captured leaf has not been persisted", async () => {
  const root = entry("root", null);
  const kept = entry("kept", "root");
  const leaf = entry("leaf", "kept");
  const file = await sessionFile([header, root, kept]);
  const update = setTimeout(() => {
    void writeFile(file.path, [header, root, kept, leaf].map((record) => JSON.stringify(record)).join("\n") + "\n");
  }, 5);

  try {
    const snapshot = await captureSessionSnapshot(
      event([root, kept, leaf], "kept"),
      context({ entries: [root, kept, leaf], leafId: "leaf", sessionFile: file.path }),
    );
    assert.equal(snapshot.leafId, "leaf");
  } finally {
    clearTimeout(update);
    await rm(file.dir, { recursive: true, force: true });
  }
});

test("ignores an unterminated trailing JSONL record", async () => {
  const root = entry("root", null);
  const kept = entry("kept", "root");
  const leaf = entry("leaf", "kept");
  const file = await sessionFile([header, root, kept, leaf]);
  await writeFile(file.path, `${[header, root, kept, leaf].map((record) => JSON.stringify(record)).join("\n")}\n{\"partial\":`);

  try {
    const snapshot = await captureSessionSnapshot(
      event([root, kept, leaf], "kept"),
      context({ entries: [root, kept, leaf], leafId: "leaf", sessionFile: file.path }),
    );
    assert.deepEqual(snapshot.sourceEntries.map(({ id }) => id), ["root"]);
  } finally {
    await rm(file.dir, { recursive: true, force: true });
  }
});

test("rejects header mismatches, duplicate IDs, missing parents, and cycles", async () => {
  const root = entry("root", null);
  const kept = entry("kept", "root");
  const file = await sessionFile([header, root, kept]);

  try {
    await assert.rejects(
      captureSessionSnapshot(
        event([root, kept], "kept"),
        context({ entries: [root, kept], leafId: "kept", sessionFile: file.path, sessionId: "wrong" }),
      ),
      /header session ID session-1 does not match wrong/,
    );
  } finally {
    await rm(file.dir, { recursive: true, force: true });
  }

  await assert.rejects(
    captureSessionSnapshot(event([root, root, kept], "kept"), context({ entries: [root, root, kept], leafId: "kept" })),
    /duplicate entry ID root/,
  );
  const orphan = entry("kept", "missing");
  await assert.rejects(
    captureSessionSnapshot(event([orphan], "kept"), context({ entries: [orphan], leafId: "kept" })),
    /missing parent missing/,
  );
  const a = entry("a", "b");
  const b = entry("b", "a");
  await assert.rejects(
    captureSessionSnapshot(event([a, b], "b"), context({ entries: [a, b], leafId: "b" })),
    /parent cycle/,
  );
});

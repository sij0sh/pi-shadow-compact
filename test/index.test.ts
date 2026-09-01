import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import shadowCompact from "../src/index.js";

type Handler = (event: any, ctx: ExtensionContext) => any;
type CompactCall = Parameters<ExtensionContext["compact"]>[0];

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, parentId: string | null, text = id): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  } as SessionEntry;
}

function textOf(message: Context["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function inventory(evidenceId: string, objective: string): string {
  return JSON.stringify({
    objective: [{ text: objective, evidenceRefs: [evidenceId] }],
    constraints: [],
    completedWork: [],
    discoveries: [],
    decisions: [],
    currentState: [],
    rejectedApproaches: [],
    openIssues: [],
    nextActions: [],
    continuityData: [],
    modifiedFiles: [],
    referencedFiles: [],
  });
}

class Registry {
  readonly activeModel = { provider: "active", id: "current", api: "test", contextWindow: 128_000, maxTokens: 8_192 } as Model<Api>;
  readonly configuredModel = { provider: "configured", id: "summary", api: "test", contextWindow: 128_000, maxTokens: 8_192 } as Model<Api>;
  readonly finds: Array<[string, string]> = [];
  readonly completionModels: Model<Api>[] = [];
  calls = 0;
  gate: Promise<void> | undefined;

  find(provider: string, id: string): Model<Api> | undefined {
    this.finds.push([provider, id]);
    if (provider === "configured" && id === "summary") return this.configuredModel;
    return undefined;
  }

  async complete(model: Model<Api>, context: Context): Promise<AssistantMessage> {
    this.calls++;
    this.completionModels.push(model);
    if (this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
    }
    const firstPrompt = textOf(context.messages[0]!);
    const evidenceId = firstPrompt.match(/"evidenceId":"([^"]+)"/)?.[1];
    assert.ok(evidenceId, "summary prompt should contain normalized evidence");
    const objective = firstPrompt.includes('explicit custom focus as a priority: "Fresh focus"')
      ? "fresh manual summary"
      : "prepared background summary";
    return {
      role: "assistant",
      content: [{ type: "text", text: inventory(evidenceId, objective) }],
      api: "test",
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }
}

interface Fixture {
  handlers: Map<string, Handler[]>;
  ctx: ExtensionContext;
  registry: Registry;
  compactCalls: CompactCall[];
  branch: SessionEntry[];
  setBranch(entries: SessionEntry[]): void;
  emit(name: string, event?: unknown): Promise<any>;
  compactEvent(options?: {
    marker?: string;
    reason?: SessionBeforeCompactEvent["reason"];
    customInstructions?: string;
  }): SessionBeforeCompactEvent;
  cleanup(): Promise<void>;
}

async function fixture(config: {
  softCompactThresholdPercent: number;
  summarizerModel: { provider: string; id: string };
}): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-index-"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "shadow-compact.json"), JSON.stringify(config));

  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  shadowCompact(pi);

  const root = entry("root", null, "Original user goal");
  const kept = entry("kept", "root", "Recent prompt");
  const leaf = entry("leaf", "kept", "Recent continuation");
  let branch = [root, kept, leaf];
  let percent: number | null = 0;
  const registry = new Registry();
  const compactCalls: CompactCall[] = [];
  const notifications: string[] = [];
  const ctx = {
    cwd,
    model: registry.activeModel,
    modelRegistry: registry,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: percent === null ? null : percent * 10, contextWindow: 1000, percent }),
    compact: (options?: CompactCall) => compactCalls.push(options),
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
      getLeafId: () => branch.at(-1)?.id,
      getCwd: () => cwd,
      getBranch: () => branch,
    },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = { type: name }) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };

  await emit("session_start", { type: "session_start", reason: "startup" });

  return {
    handlers,
    ctx,
    registry,
    compactCalls,
    get branch() { return branch; },
    setBranch(entries) { branch = entries; },
    async emit(name, event) {
      if (name === "agent_settled" && typeof event === "number") percent = event;
      return emit(name, typeof event === "number" ? { type: name } : event);
    },
    compactEvent(options = {}) {
      const customInstructions = options.marker ?? options.customInstructions;
      return {
        type: "session_before_compact",
        branchEntries: branch,
        preparation: {
          firstKeptEntryId: "kept",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 900,
          fileOps: {
            read: new Set(["src/read.ts", "src/changed.ts"]),
            written: new Set(["src/changed.ts"]),
            edited: new Set(["src/edited.ts"]),
          },
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
        },
        ...(customInstructions === undefined ? {} : { customInstructions }),
        reason: options.reason ?? "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      };
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("timed out waiting for asynchronous extension work");
}

async function prepare(f: Fixture): Promise<{ marker: string; result: any }> {
  await f.emit("agent_settled", 100);
  const probe = f.compactCalls.at(-1);
  assert.ok(probe?.customInstructions);
  const result = await f.emit(
    "session_before_compact",
    f.compactEvent({ marker: probe.customInstructions, reason: "manual" }),
  );
  probe.onError?.(new Error("Compaction cancelled"));
  await f.emit("session_compact_failed", {
    type: "session_compact_failed",
    reason: "manual",
    aborted: true,
    willRetry: false,
    fromExtension: false,
  });
  await waitFor(() => f.registry.calls >= 3);
  return { marker: probe.customInstructions, result };
}

describe("shadowCompact extension integration", () => {
  it("uses the configured threshold and validates a configured model", async () => {
    const f = await fixture({
      softCompactThresholdPercent: 75,
      summarizerModel: { provider: "configured", id: "summary" },
    });
    try {
      await f.emit("agent_settled", 74.9);
      assert.equal(f.compactCalls.length, 0);
      await f.emit("agent_settled", 75);
      assert.equal(f.compactCalls.length, 1);
      const probe = f.compactCalls[0];
      assert.ok(probe?.customInstructions);
      await f.emit(
        "session_before_compact",
        f.compactEvent({ marker: probe.customInstructions, reason: "manual" }),
      );
      await waitFor(() => f.registry.finds.length > 0);
      assert.deepEqual(f.registry.finds[0], ["configured", "summary"]);
    } finally {
      await f.cleanup();
    }
  });

  it("cancels the probe, publishes preparation in the background, and adopts on input", async () => {
    const f = await fixture({
      softCompactThresholdPercent: 60,
      summarizerModel: { provider: "", id: "" },
    });
    let release!: () => void;
    f.registry.gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await f.emit("agent_settled", 60);
      const probe = f.compactCalls[0];
      assert.ok(probe?.customInstructions);
      const before = await f.emit(
        "session_before_compact",
        f.compactEvent({ marker: probe.customInstructions, reason: "manual" }),
      );
      assert.deepEqual(before, { cancel: true });
      await waitFor(() => f.registry.calls === 1);
      const inputWhilePreparing = await f.emit("input", {
        type: "input",
        text: "work while summary is running",
        source: "interactive",
        images: [],
      });
      assert.deepEqual(inputWhilePreparing, { action: "continue" });
      assert.equal(f.compactCalls.length, 1);

      probe.onError?.(new Error("Compaction cancelled"));
      await f.emit("session_compact_failed", {
        type: "session_compact_failed",
        reason: "manual",
        aborted: true,
        willRetry: false,
        fromExtension: false,
      });
      release();
      await waitFor(() => f.registry.calls === 3);
      await f.emit("session_compact_failed", {
        type: "session_compact_failed",
        reason: "manual",
        aborted: true,
        willRetry: false,
        fromExtension: false,
      });
      assert.ok(f.registry.completionModels.every((model) => model === f.registry.activeModel));
      assert.deepEqual(f.registry.finds, []);

      const inputPromise = f.emit("input", {
        type: "input",
        text: "next request",
        source: "interactive",
        images: [],
      });
      await waitFor(() => f.compactCalls.length === 2);
      const adoption = f.compactCalls[1];
      assert.ok(adoption?.customInstructions);
      const adopted = await f.emit(
        "session_before_compact",
        f.compactEvent({ marker: adoption.customInstructions, reason: "manual" }),
      );
      assert.match(adopted.compaction.summary, /prepared background summary/);
      assert.equal(adopted.compaction.tokensBefore, 900);
      assert.deepEqual(adopted.compaction.details.readFiles, ["src/read.ts"]);
      assert.deepEqual(adopted.compaction.details.modifiedFiles, ["src/changed.ts", "src/edited.ts"]);
      adoption.onComplete?.(adopted.compaction);
      assert.deepEqual(await inputPromise, { action: "continue" });
    } finally {
      await f.cleanup();
    }
  });

  it("reuses a prepared summary for threshold compaction but generates manual compaction fresh", async () => {
    const f = await fixture({
      softCompactThresholdPercent: 60,
      summarizerModel: { provider: "", id: "" },
    });
    try {
      const probe = await prepare(f);
      assert.deepEqual(probe.result, { cancel: true });

      const threshold = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold" }),
      );
      assert.equal(f.registry.calls, 3);
      assert.match(threshold.compaction.summary, /prepared background summary/);

      const manual = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "manual", customInstructions: "Fresh focus" }),
      );
      assert.equal(f.registry.calls, 6);
      assert.match(manual.compaction.summary, /fresh manual summary/);
    } finally {
      await f.cleanup();
    }
  });

  it("invalidates prepared work when the active branch no longer contains its leaf", async () => {
    const f = await fixture({
      softCompactThresholdPercent: 60,
      summarizerModel: { provider: "", id: "" },
    });
    try {
      await prepare(f);
      const divergent = entry("divergent", "kept", "Alternate branch");
      f.setBranch([f.branch[0]!, f.branch[1]!, divergent]);

      const input = await f.emit("input", {
        type: "input",
        text: "continue elsewhere",
        source: "interactive",
        images: [],
      });
      assert.deepEqual(input, { action: "continue" });
      assert.equal(f.compactCalls.length, 1);

      const threshold = await f.emit(
        "session_before_compact",
        f.compactEvent({ reason: "threshold" }),
      );
      assert.equal(f.registry.calls, 6);
      assert.match(threshold.compaction.summary, /prepared background summary/);
    } finally {
      await f.cleanup();
    }
  });
});

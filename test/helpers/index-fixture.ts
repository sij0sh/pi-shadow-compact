import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsApiStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import shadowCompact from "../../src/index.js";



export type Handler = (event: any, ctx: ExtensionContext) => any;
export type CompactCall = Parameters<ExtensionContext["compact"]>[0];

export const USAGE: Usage = {
  input: 5,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
export const NONCE_PATTERN = /^\[shadow-compact:commit:[0-9a-f-]{36}\]$/;

function checkpointJson(evidenceId: string): string {
  return JSON.stringify({
    objective: [{ text: "Prepared continuation checkpoint", evidenceRefs: [evidenceId] }],
    constraints: [],
    completedWork: [],
    currentState: [],
    decisions: [],
    openIssues: [],
    nextActions: [],
    criticalContext: [],
    modifiedFiles: [],
    referencedFiles: [],
  });
}

function promptText(context: Context): string {
  const first = context.messages[0];
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  return first.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export class FakeRegistry {
  calls = 0;
  settled = 0;
  mode: "ok" | "error" = "ok";
  readonly pendingGates: Promise<void>[] = [];
  readonly prompts: string[] = [];
  readonly models: Model<Api>[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  readonly optionsList: Array<ModelsApiStreamOptions<Api> | undefined> = [];
  readonly finds: Array<[string, string]> = [];
  readonly summaryModel = {
    api: "openai-completions",
    provider: "configured",
    id: "summary-model",
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: true,
  } as unknown as Model<Api>;

  find(provider: string, id: string): Model<Api> | undefined {
    this.finds.push([provider, id]);
    if (provider === "configured" && id === "summary-model") return this.summaryModel;
    return undefined;
  }

  async complete(
    model: Model<Api>,
    context: Context,
    options?: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage> {
    this.calls++;
    this.models.push(model);
    this.signals.push(options?.signal);
    this.optionsList.push(options);
    this.prompts.push(promptText(context));
    if (this.pendingGates.length > 0) await this.pendingGates.shift();
    this.settled++;
    if (this.mode === "error") {
      return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: USAGE,
        stopReason: "error",
        errorMessage: "synthetic failure",
      } as unknown as AssistantMessage;
    }
    const evidenceId = this.prompts.at(-1)?.match(/"evidenceId":"([^"]+)"/)?.[1];
    assert.ok(evidenceId, "summary prompt must contain normalized evidence");
    return {
      role: "assistant",
      content: [{ type: "text", text: checkpointJson(evidenceId) }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
  }
}

export function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantToolEntry(
  id: string,
  parentId: string,
  text: string,
  tool: { name: string; path: string },
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "toolCall", id: `${id}-call`, name: tool.name, arguments: { path: tool.path } },
      ],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

export function compactionEntry(id: string, parentId: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TIMESTAMP,
    summary: "native summary",
    firstKeptEntryId: "e4",
    tokensBefore: 1234,
  } as unknown as SessionEntry;
}

/** ~46 tokens for the last user entry: keepRecentTokens=30 cuts right before it. */
function makeBranch(): SessionEntry[] {
  const e1 = userEntry("e1", null, "First user message describing the overall goal of this fixture session.");
  const e2 = assistantToolEntry("e2", "e1", "Reading the config file.", { name: "read", path: "src/read.ts" });
  const e3 = assistantToolEntry("e3", "e2", "Now editing the file.", { name: "edit", path: "src/edited.ts" });
  const e4 = userEntry("e4", "e3", `Fourth user message, deliberately long: ${"detail ".repeat(20)}`);
  return [e1, e2, e3, e4];
}

export interface Fixture {
  readonly registry: FakeRegistry;
  readonly compactCalls: CompactCall[];
  readonly notifications: string[];
  readonly branch: SessionEntry[];
  setBranch(entries: SessionEntry[]): void;
  setPercent(percent: number | undefined): void;
  gate(): void;
  release(): void;
  appendCompaction(): void;
  emit(name: string, event?: unknown): Promise<any>;
  compactEvent(options?: {
    reason?: SessionBeforeCompactEvent["reason"];
    customInstructions?: string;
    firstKeptEntryId?: string;
  }): SessionBeforeCompactEvent;
  cleanup(): Promise<void>;
}

export async function fixture(globalConfig?: Record<string, unknown>): Promise<Fixture> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "shadow-agent-"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 } }),
  );
  if (globalConfig !== undefined) {
    await writeFile(join(agentDir, "shadow-compact.json"), JSON.stringify(globalConfig));
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = await mkdtemp(join(tmpdir(), "shadow-cwd-"));

  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  shadowCompact(pi);

  let branch = makeBranch();
  let percent: number | undefined = 60;
  const releases: Array<() => void> = [];
  const registry = new FakeRegistry();
  const compactCalls: CompactCall[] = [];
  const notifications: string[] = [];

  const ctx = {
    cwd,
    model: registry.summaryModel,
    modelRegistry: registry,
    isProjectTrusted: () => true,
    getContextUsage: () =>
      percent === undefined ? undefined : { tokens: percent * 10, contextWindow: 1000, percent },
    compact: (options?: CompactCall) => {
      compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getLeafId: () => branch.at(-1)?.id,
      getBranch: () => branch,
    },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;

  return {
    registry,
    compactCalls,
    notifications,
    get branch() {
      return branch;
    },
    setBranch(entries) {
      branch = entries;
    },
    setPercent(next) {
      percent = next;
    },
    gate() {
      let releaseGate!: () => void;
      registry.pendingGates.push(new Promise<void>((resolve) => {
        releaseGate = resolve;
      }));
      releases.push(releaseGate);
    },
    release() {
      releases.shift()?.();
    },
    appendCompaction() {
      branch = [...branch, compactionEntry("c1", branch.at(-1)?.id ?? "e4")];
    },
    async emit(name, event = { type: name }) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
    compactEvent(options = {}) {
      return {
        type: "session_before_compact",
        branchEntries: branch,
        preparation: {
          firstKeptEntryId: options.firstKeptEntryId ?? "e4",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 777,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
        },
        ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
        reason: options.reason ?? "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      };
    },
    async cleanup() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("timed out waiting for asynchronous extension work");
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

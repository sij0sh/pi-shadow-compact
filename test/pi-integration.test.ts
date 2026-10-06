import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  Type,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CompactionEntry,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import shadowCompact from "../src/index.js";
import { CHECKPOINT_CUSTOM_TYPE, type PersistedShadowCheckpoint } from "../src/persist.js";
import { FakeRegistry, USAGE, waitFor, tick } from "./helpers/index-fixture.js";

async function integrationFixture(extraExtensions: ExtensionFactory[] = [], config: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-pi-integration-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "shadow-compact.json"), JSON.stringify({
    recentTurns: 10,
    idleCompact: { enabled: false },
    ...config,
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 2000, reserveTokens: 1000 },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const provider = fauxProvider({ provider: "shadow-integration", models: [{ id: "model", contextWindow: 200_000, maxTokens: 8192 }] });
  modelRuntime.registerNativeProvider(provider.provider);
  const registry = new FakeRegistry();
  const actingReplies: AssistantMessage[] = [];
  const actingRequests: TranscriptContext[] = [];
  const actingGates: Promise<void>[] = [];
  const errors: string[] = [];
  let nativeCalls = 0;
  // Drive all calls through Pi's real stream/auth/transcript pipeline, but
  // never call a remote model. Nested agents use the existing scripted model.
  provider.setResponses(Array.from({ length: 100 }, () => async (context, options, _state, model) => {
    const tools = getCurrentTools(context.messages);
    if (tools.some((tool) => tool.name === "submit_checkpoint" || tool.name === "submit_verdict")) {
      return registry.complete(model, {
        messages: context.messages.filter((message) => message.role !== "system"),
        tools,
      }, options);
    }
    if (tools.length === 0) {
      nativeCalls++;
      return fauxAssistantMessage("Native continuation summary for newly summarized history.");
    }
    actingRequests.push(context);
    if (actingGates.length) await actingGates.shift();
    return actingReplies.shift() ?? fauxAssistantMessage("ready");
  }));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: "Preserve this system prompt and the probe tool across compaction.",
    extensionFactories: [shadowCompact, ...extraExtensions],
  });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(cwd);
  for (let i = 0; i < 14; i++) {
    manager.appendMessage({ role: "user", content: `task ${i}: ${"old detail ".repeat(1000)}`, timestamp: i });
    manager.appendMessage(fauxAssistantMessage(`completed historical round ${i}`));
  }
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: provider.getModel(),
    thinkingLevel: "off",
    resourceLoader,
    sessionManager: manager,
    settingsManager,
    tools: ["probe"],
    customTools: [{
      name: "probe", label: "Probe", description: "An inert test tool.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "tool output ".repeat(1000) }], details: undefined }),
    }],
  });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({ onError: (error) => errors.push(error.error) });
  return {
    session, manager, provider, settingsManager, registry, actingReplies, actingRequests, actingGates, errors,
    get nativeCalls() { return nativeCalls; },
    async cleanup() {
      session.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

const estimatedConversationTokens = (manager: SessionManager) => manager.buildSessionProjection().messages
  .filter((message) => message.role !== "system")
  .reduce((total, message) => total + estimateTokens(message), 0);

const assertPromptAndTools = (messages: TranscriptContext["messages"]) => {
  assert.match(getCurrentSystemPrompt(messages), /Preserve this system prompt/);
  assert.deepEqual(getCurrentTools(messages).map((tool) => tool.name), ["probe"]);
};

describe("Pi 1.0.4 integration", () => {
  it("continues tools and steering during command generation, then installs before the next request", async () => {
    const f = await integrationFixture();
    let releaseSummary!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    try {
      const before = estimatedConversationTokens(f.manager);
      f.registry.pendingGates.push(new Promise<void>((resolve) => { releaseSummary = resolve; }));
      f.actingGates.push(
        new Promise<void>((resolve) => { releaseFirst = resolve; }),
        new Promise<void>((resolve) => { releaseSecond = resolve; }),
      );
      const lifecycle: string[] = [];
      f.session.subscribe((event) => {
        if (event.type === "entry_appended" && event.entry.type === "compaction") lifecycle.push("installed");
        else lifecycle.push(event.type);
      });
      f.actingReplies.push(
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "async-first" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "async-second" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("finished without restarting"),
      );
      const run = f.session.prompt("keep acting while checkpoint builds");
      await waitFor(() => f.actingRequests.length === 1);
      await f.session.prompt("/shadow-compact Preserve migration state");
      await waitFor(() => f.registry.calls === 1);
      assert.equal(f.registry.calls, 1, `command resolves while builder is gated: ${JSON.stringify(f.errors)}`);
      assert.equal(f.session.isStreaming, true);
      await f.session.steer("queued steering survives checkpoint installation");
      releaseFirst();
      await waitFor(() => f.actingRequests.length === 2);
      assert.equal(f.registry.settled, 0, "acting loop advances while summary remains blocked");
      assert.ok(f.actingRequests[1]!.messages.some((message) => message.role === "toolResult" && message.toolCallId === "async-first"));
      assert.match(JSON.stringify(f.actingRequests[1]!.messages), /queued steering survives/);
      releaseSummary();
      await waitFor(() => f.registry.settled === 4);
      await tick();
      assert.equal(lifecycle.filter((type) => type === "installed").length, 0, "cannot change the second request already sent");
      releaseSecond();
      await run;
      assert.equal(f.actingRequests.length, 3, "no forced continuation or restarted run");
      assert.equal(lifecycle.filter((type) => type === "installed").length, 1);
      assert.equal(lifecycle.includes("compaction_start"), false, "no manual compaction path");
      const latest = f.actingRequests.at(-1)!;
      assertPromptAndTools(latest.messages);
      assert.match(JSON.stringify(latest.messages), /Continuation Checkpoint/);
      assert.match(JSON.stringify(latest.messages), /queued steering survives/);
      assert.ok(latest.messages.some((message) => message.role === "toolResult" && message.toolCallId === "async-second"));
      assert.ok(estimatedConversationTokens(f.manager) < before);
      assert.equal(f.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 16, "raw history and steering remain stored");
      f.settingsManager.setCompactionEnabled(true);
      await f.session.prompt("continue on canonical checkpoint");
      assert.equal(f.nativeCalls, 0);
      assert.deepEqual(f.errors, []);
    } finally {
      releaseSummary?.(); releaseFirst?.(); releaseSecond?.();
      await f.cleanup();
    }
  });

  it("automatic preparation does not delay another acting tool round", async () => {
    const f = await integrationFixture([], { prepareThresholdPercent: 1 });
    let releaseSummary!: () => void;
    let releaseActing!: () => void;
    try {
      f.registry.pendingGates.push(new Promise<void>((resolve) => { releaseSummary = resolve; }));
      f.actingGates.push(Promise.resolve(), new Promise<void>((resolve) => { releaseActing = resolve; }));
      f.actingReplies.push(
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "auto-first" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      );
      const run = f.session.prompt("automatic background preparation");
      await waitFor(() => f.registry.calls === 1 && f.actingRequests.length === 2);
      assert.equal(f.registry.settled, 0, "automatic trigger returns while builder remains gated");
      assert.equal(f.session.isStreaming, true);
      releaseSummary();
      await waitFor(() => f.registry.settled === 4);
      releaseActing();
      await run;
      assert.ok(f.manager.getBranch().some((entry) => entry.type === "compaction"));
      assert.deepEqual(f.errors, []);
    } finally {
      releaseSummary?.(); releaseActing?.();
      await f.cleanup();
    }
  });

  it("commits boundary compaction without abort, continuation, or ordinary compaction lifecycle", async () => {
    let commits = 0;
    let ordinaryCompactions = 0;
    const f = await integrationFixture([(pi) => {
      pi.on("session_compact", () => { ordinaryCompactions++; });
      pi.on("turn_end", (event) => {
        if (commits++ > 0) return;
        const firstKeptEntryId = event.context.contextEntries.find((entry) =>
          entry.messages.some((message) => message.role === "user"))!.sourceEntry.id;
        // The first entry remains retained; this test isolates the runtime lifecycle.
        return { entries: [{ type: "compaction", summary: "boundary checkpoint", firstKeptEntryId }] };
      });
    }]);
    try {
      const lifecycle: string[] = [];
      f.session.subscribe((event) => {
        if (event.type === "entry_appended" && event.entry.type === "compaction") lifecycle.push("boundary_compaction");
        else lifecycle.push(event.type);
      });
      f.actingReplies.push(
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "boundary-tool" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("finished"),
      );
      await f.session.prompt("test boundary");
      assert.equal(ordinaryCompactions, 0);
      assert.equal(f.actingRequests.length, 2, "no invented response or restarted run");
      assert.ok(lifecycle.indexOf("boundary_compaction") < lifecycle.lastIndexOf("turn_start"));
      const entry = f.manager.getBranch().find((entry) => entry.type === "compaction") as CompactionEntry;
      assert.equal(entry.fromHook, true);
      assert.ok(entry.systemMessage);
      assertPromptAndTools(f.actingRequests.at(-1)!.messages);
      assert.ok(f.actingRequests.at(-1)!.messages.some((message) => message.role === "toolResult" && message.toolCallId === "boundary-tool"));
      assert.deepEqual(f.errors, []);
    } finally {
      await f.cleanup();
    }
  });

  it("applies a verified manual compaction, preserves prompt/tools, and resumes with smaller context", async () => {
    const f = await integrationFixture();
    try {
      // Declare a real prompt/tool baseline in session history before compacting.
      await f.session.prompt("prepare for compaction");
      const before = estimatedConversationTokens(f.manager);
      const result = await f.session.compact();
      assert.equal(f.registry.calls, 4, "builder and verifier use the real configured provider");
      assert.equal(f.nativeCalls, 0);
      assert.ok(result.estimatedTokensAfter! < before / 2);
      const compaction = f.manager.getLeafEntry() as CompactionEntry;
      assert.equal(compaction.fromHook, true);
      assert.match(compaction.summary, /Continuation Checkpoint/);
      assert.ok(compaction.systemMessage, "Pi persists a complete prompt/tool checkpoint");
      assertPromptAndTools(compaction.systemMessage ? [compaction.systemMessage] : []);
      assert.equal(f.session.getContextUsage()?.tokens, null, "pre-compaction usage is unknown until a new response");

      f.actingReplies.push(
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "probe-after-compact" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("resumed"),
      );
      await f.session.prompt("continue after compaction");
      const resumedContext = f.actingRequests.at(-1)!;
      assert.ok(resumedContext.messages.reduce((total, message) => total + estimateTokens(message), 0) < before / 2);
      assertPromptAndTools(resumedContext.messages);
      assert.ok(resumedContext.messages.some((message) => message.role === "toolResult" && message.toolCallId === "probe-after-compact"));
      assert.deepEqual(f.errors, []);
    } finally {
      await f.cleanup();
    }
  });

  it("falls back natively for uncovered cached history between tool execution and the next response", async () => {
    const f = await integrationFixture();
    try {
      await f.session.prompt("prepare for compaction");
      await f.session.compact();
      const previous = f.manager.getLeafEntry() as CompactionEntry;
      const checkpoint: PersistedShadowCheckpoint = {
        version: 1, checkpointId: "cached", sessionId: f.manager.getSessionId(),
        summary: previous.summary, firstKeptEntryId: previous.firstKeptEntryId,
        leafId: previous.id, latestCompactionId: previous.id,
        contextTokensBefore: 100_000, usage: USAGE,
        details: { readFiles: [], modifiedFiles: [] }, createdAt: Date.now(),
      };
      f.manager.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, checkpoint);
      await f.session.bindExtensions({});
      const rawInputId = f.manager.appendMessage({ role: "user", content: "new uncached work ".repeat(50_000), timestamp: Date.now() });
      const baselineCalls = f.registry.calls;
      const tokensBefore = estimatedConversationTokens(f.manager);
      f.settingsManager.setCompactionEnabled(true);
      const lifecycle: string[] = [];
      f.session.subscribe((event) => { lifecycle.push(event.type); });
      f.actingReplies.push(
        fauxAssistantMessage([fauxToolCall("probe", {}, { id: "probe-before-auto-compact" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("resumed after native compaction"),
      );
      await f.session.prompt("execute probe, then continue");
      const compaction = f.manager.getBranch().reverse().find((entry) => entry.type === "compaction") as CompactionEntry;
      assert.equal(compaction.fromHook, false, "uncovered cached history must use Pi's native summary");
      assert.ok(f.nativeCalls >= 1, "Pi can summarize history and a split-turn prefix separately");
      assert.equal(f.registry.calls, baselineCalls, "automatic compaction must not block on a fresh background audit");
      assert.ok(estimatedConversationTokens(f.manager) < tokensBefore / 2);
      assert.ok(lifecycle.indexOf("tool_execution_end") < lifecycle.indexOf("compaction_start"));
      assert.ok(lifecycle.indexOf("compaction_end") < lifecycle.lastIndexOf("turn_start"));
      assert.ok(f.manager.getBranch().some((entry) => entry.id === rawInputId), "raw evidence survives compaction");
      assertPromptAndTools(f.actingRequests.at(-1)!.messages);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.cleanup();
    }
  });
});

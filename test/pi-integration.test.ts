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
} from "@earendil-works/pi-coding-agent";
import shadowCompact from "../src/index.js";
import { CHECKPOINT_CUSTOM_TYPE, type PersistedShadowCheckpoint } from "../src/persist.js";
import { FakeRegistry, USAGE } from "./helpers/index-fixture.js";

async function integrationFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-pi-integration-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "shadow-compact.json"), JSON.stringify({
    recentTurns: 10,
    idleCompact: { enabled: false },
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
    extensionFactories: [shadowCompact],
  });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(cwd);
  for (let i = 0; i < 14; i++) {
    manager.appendMessage({ role: "user", content: `task ${i}: ${"old detail ".repeat(1000)}`, timestamp: i });
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
    session, manager, provider, settingsManager, registry, actingReplies, actingRequests, errors,
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

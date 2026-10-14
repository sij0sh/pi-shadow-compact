import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  registerActingRequestObserver,
  usageInvalidatedByEdit,
  usageTrustingEstimate,
} from "../src/request-trace.js";

const SECRET = "private-transcript-and-credentials";

function usage(totalTokens: number, output = 10, reasoning = 0) {
  return { input: totalTokens - output, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistant(totalTokens: number, timestamp: number, stopReason = "stop", content: unknown[] = [{ type: "text", text: "done" }]) {
  return { role: "assistant", content, api: "azure-openai-responses", provider: "azure", model: "m", usage: usage(totalTokens), stopReason, timestamp };
}

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });

function entry(id: string, value: Record<string, unknown>): SessionEntry {
  return { id, parentId: null, timestamp: "2026-10-14T00:00:00.000Z", ...value } as unknown as SessionEntry;
}

/** Branch where a failed response was omitted by a context edit after older high usage. */
const editedBranch = [
  entry("u1", { type: "message", message: user("task", 1) }),
  entry("a1", { type: "message", message: assistant(390_000, 2) }),
  entry("a2", { type: "message", message: assistant(390_100, 3, "length") }),
  entry("x1", { type: "context_edit" }),
  entry("u2", { type: "message", message: user("follow up", 4) }),
];

function harness(branch: SessionEntry[] = editedBranch) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const notices: Array<{ message: string; type: string | undefined }> = [];
  const pi = { on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const ctx = {
    model: { provider: "azure-gateway-responses", id: "gpt-test", contextWindow: 400_000, maxTokens: 64_000 },
    getContextUsage: () => ({ tokens: 285_000, contextWindow: 400_000, percent: 71.25 }),
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
  } as unknown as ExtensionContext;
  registerActingRequestObserver(pi);
  const emit = (name: string, event: Record<string, unknown>) => handlers.get(name)?.({ type: name, ...event }, ctx);
  return { emit, notices };
}

async function withTrace(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "request-trace-"));
  const previous = process.env.SHADOW_COMPACT_TRACE;
  const path = join(dir, "trace.jsonl");
  process.env.SHADOW_COMPACT_TRACE = path;
  try {
    await run(path);
  } finally {
    if (previous === undefined) delete process.env.SHADOW_COMPACT_TRACE;
    else process.env.SHADOW_COMPACT_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("acting request accounting", () => {
  it("keeps older high usage after an omitted response, as the provider-side estimator does", () => {
    const messages = [user("task", 1), assistant(390_000, 2), user("follow up", 4)] as never[];
    const estimate = usageTrustingEstimate(messages);
    assert.equal(estimate.retainedUsageTokens, 390_000);
    assert.ok(estimate.tokens > 390_000);
    assert.equal(usageInvalidatedByEdit(editedBranch), true);
    assert.equal(usageInvalidatedByEdit(editedBranch.filter((item) => item.type !== "context_edit")), false);
  });

  it("ignores usage from before a newer prefix message and from failed responses", () => {
    const messages = [user("summary", 10), assistant(390_000, 2), assistant(1000, 11, "error")] as never[];
    assert.equal(usageTrustingEstimate(messages).retainedUsageTokens, null);
  });
});

describe("registerActingRequestObserver", () => {
  it("records allow-listed budget fields and reports a clamped length stop", async () => {
    await withTrace(async (path) => {
      const { emit, notices } = harness();
      emit("context_with_system", { messages: [user("task", 1), assistant(390_000, 2), user(SECRET, 4)] });
      emit("before_provider_request", { payload: { max_output_tokens: 16, reasoning: { effort: "xhigh" }, input: SECRET } });
      emit("before_provider_request", { payload: { max_output_tokens: 1, input: SECRET } });
      emit("after_provider_response", { status: 200, headers: { authorization: SECRET } });
      emit("provider_stream_event", { data: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: SECRET } } });
      emit("message_end", { message: { ...assistant(400_016, 5, "length", [{ type: "thinking", thinking: SECRET }]), usage: usage(400_016, 16, 16) } });
      const text = await readFile(path, "utf8");
      assert.ok(!text.includes(SECRET));
      const record = JSON.parse(text.trim());
      assert.equal(record.event, "acting_request");
      assert.equal(record.provider, "azure-gateway-responses");
      assert.equal(record.contextWindow, 400_000);
      assert.equal(record.canonicalTokens, 285_000);
      assert.equal(record.retainedUsageTokens, 390_000);
      assert.ok(record.providerEstimateTokens > record.canonicalTokens);
      assert.equal(record.usageInvalidatedByEdit, true);
      assert.equal(record.requestedMaxTokens, 64_000);
      assert.equal(record.payloadMaxTokens, 16, "cache-warming payloads do not overwrite the request's own");
      assert.equal(record.payloadReasoning, "xhigh");
      assert.equal(record.outputClamped, true);
      assert.equal(record.providerReason, "max_output_tokens");
      assert.equal(record.outcome, "length");
      assert.equal(record.outputTokens, 16);
      assert.equal(record.reasoningTokens, 16);
      assert.equal(record.textChars, 0);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.type, "warning");
      assert.match(notices[0]!.message, /16-token output allowance.*unfinished/);
    });
  });

  it("does not report length stops at the model's full allowance or record without tracing", async () => {
    const file = process.env.SHADOW_COMPACT_TRACE, stderr = process.env.SHADOW_COMPACT_TRACE_STDERR;
    delete process.env.SHADOW_COMPACT_TRACE; delete process.env.SHADOW_COMPACT_TRACE_STDERR;
    try {
      const { emit, notices } = harness();
      emit("context_with_system", { messages: [user("task", 1)] });
      emit("before_provider_request", { payload: { max_output_tokens: 64_000 } });
      emit("message_end", { message: { ...assistant(70_000, 2, "length"), usage: usage(70_000, 64_000) } });
      assert.equal(notices.length, 0);
      emit("context_with_system", { messages: [user("task", 1)] });
      emit("before_provider_request", { payload: { max_output_tokens: 16 } });
      emit("message_end", { message: { ...assistant(400_000, 2, "length"), usage: usage(400_000, 16) } });
      assert.equal(notices.length, 1, "the diagnostic does not depend on tracing");
      emit("message_end", { message: { ...assistant(400_000, 2, "length"), usage: usage(400_000, 16) } });
      assert.equal(notices.length, 1, "an assistant message without a fresh request is not attributed");
    } finally {
      if (file !== undefined) process.env.SHADOW_COMPACT_TRACE = file;
      if (stderr !== undefined) process.env.SHADOW_COMPACT_TRACE_STDERR = stderr;
    }
  });
});

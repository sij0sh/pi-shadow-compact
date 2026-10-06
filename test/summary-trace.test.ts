import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, type Api, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeWithSummaryTrace } from "../src/summary-trace.js";

it("records only safe budget and termination fields while preserving provider callbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summary-trace-"));
  const previous = process.env.SHADOW_COMPACT_TRACE;
  const path = join(dir, "trace.jsonl");
  process.env.SHADOW_COMPACT_TRACE = path;
  const model = { api: "openai-responses", provider: "test", id: "model", maxTokens: 64000 } as Model<Api>;
  let payloadCalls = 0, eventCalls = 0, responseCalls = 0;
  const secret = "private-draft-and-credentials";
  try {
    const response = await completeWithSummaryTrace({
      complete: async (_model, _context, options) => {
        const payload = { max_output_tokens: 100, reasoning: { effort: "high" }, input: secret, headers: { authorization: secret } };
        const replacement = await options?.onPayload?.(payload, model);
        assert.equal((replacement as typeof payload).max_output_tokens, 80);
        await options?.onResponse?.({ status: 200, headers: { secret } }, model);
        await options?.onProviderStreamEvent?.({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens", secret }, output: secret } }, model);
        return { ...fauxAssistantMessage(secret, { stopReason: "length" }), usage: { input: 12, output: 80, reasoning: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 92, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      },
    }, model, { messages: [] }, {
      maxTokens: 200, reasoning: "max",
      onPayload: (payload) => { payloadCalls++; return { ...(payload as object), max_output_tokens: 80 }; },
      onResponse: () => { responseCalls++; },
      onProviderStreamEvent: () => { eventCalls++; },
    }, { attemptId: "attempt", stage: "native-history", round: 1 });
    assert.equal(response.stopReason, "length");
    assert.equal(payloadCalls, 1); assert.equal(responseCalls, 1); assert.equal(eventCalls, 1);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(secret));
    const record = JSON.parse(text);
    assert.equal(record.requestedMaxTokens, 200);
    assert.equal(record.payloadMaxTokens, 80);
    assert.equal(record.requestedReasoning, "max");
    assert.equal(record.payloadReasoning, "high");
    assert.equal(record.providerStatus, "incomplete");
    assert.equal(record.providerReason, "max_output_tokens");
    assert.equal(record.httpStatus, 200);
    assert.equal(record.outputTokens, 80); assert.equal(record.reasoningTokens, 60);
    assert.equal(record.outcome, "length");
    assert.equal(record.textChars, secret.length);
  } finally {
    if (previous === undefined) delete process.env.SHADOW_COMPACT_TRACE;
    else process.env.SHADOW_COMPACT_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps instrumentation absent when diagnostics are disabled", async () => {
  const file = process.env.SHADOW_COMPACT_TRACE, stderr = process.env.SHADOW_COMPACT_TRACE_STDERR;
  delete process.env.SHADOW_COMPACT_TRACE; delete process.env.SHADOW_COMPACT_TRACE_STDERR;
  try {
    const options: ModelsSimpleStreamOptions = { maxTokens: 100 };
    await completeWithSummaryTrace({ complete: async (_model, _context, received) => {
      assert.equal(received, options);
      return fauxAssistantMessage("complete");
    } }, {} as Model<Api>, { messages: [] }, options, { attemptId: "attempt", stage: "builder", round: 1 });
  } finally {
    if (file !== undefined) process.env.SHADOW_COMPACT_TRACE = file;
    if (stderr !== undefined) process.env.SHADOW_COMPACT_TRACE_STDERR = stderr;
  }
});

it("classifies unsafe termination labels and request failures without logging raw values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summary-trace-"));
  const previous = process.env.SHADOW_COMPACT_TRACE;
  const path = join(dir, "trace.jsonl");
  process.env.SHADOW_COMPACT_TRACE = path;
  const model = { maxTokens: 100 } as Model<Api>;
  const secret = "secret-quota-error";
  try {
    await completeWithSummaryTrace({ complete: async (_model, _context, options) => {
      await options?.onPayload?.({ max_tokens: 20, reasoning_effort: secret }, model);
      await options?.onProviderStreamEvent?.({ type: "response.failed", response: { status: secret, incomplete_details: { reason: secret } } }, model);
      return { ...fauxAssistantMessage(secret, { stopReason: "error", errorMessage: secret }), providerThinkingLevel: secret };
    } }, model, { messages: [] }, {}, { attemptId: "attempt", stage: "verifier", round: 1 });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(completeWithSummaryTrace({ complete: async () => { throw new Error(secret); } }, model, { messages: [] }, {
      signal: controller.signal,
    }, { attemptId: "attempt", stage: "builder", round: 2 }), /secret-quota-error/);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(secret));
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].providerStatus, "other"); assert.equal(records[0].providerReason, "other");
    assert.equal(records[0].payloadReasoning, "other"); assert.equal(records[0].providerReasoning, "other");
    assert.equal(records[1].outcome, "aborted");
    assert.equal(records[1].payloadMaxTokens, null, "absent adapter callback is not an effective cap");
  } finally {
    if (previous === undefined) delete process.env.SHADOW_COMPACT_TRACE;
    else process.env.SHADOW_COMPACT_TRACE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

import {
  calculateContextTokens,
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { label, numeric, OUTCOMES, payloadBudget, terminalStatus } from "./summary-trace.js";
import { isStderrTraceEnabled, traceEvent } from "./trace.js";

/**
 * Acting-request observation (global failure analysis 2026-10-14, P0).
 *
 * The acting model's own requests bypass the private summary telemetry, yet
 * they are where context pressure starves output: Pi clamps the allowance to
 * what its provider-side estimate leaves, and a reasoning model can spend all
 * of it before answering. This records allow-listed numbers per request:
 * Pi's provenance-aware estimate, a usage-trusting estimate of the final
 * transformed context, requested and payload output allowances, and the
 * outcome. Never prompts, transcripts, headers, URLs, credentials, encrypted
 * reasoning, or raw provider errors.
 *
 * Independent of tracing, a `length` stop whose payload allowance was below
 * the model's requested allowance is reported to the user, because the turn
 * is unfinished for a reason compaction can address.
 */

type AgentMessage = Parameters<typeof estimateTokens>[0];

interface PendingRequest {
  fields: Record<string, unknown>;
  payloadSeen: boolean;
  requestedMaxTokens: number | null;
  payloadMaxTokens: number | null;
}

function traceEnabled(): boolean {
  return Boolean(process.env.SHADOW_COMPACT_TRACE) || isStderrTraceEnabled();
}

function safeTokens(message: AgentMessage): number {
  try {
    return estimateTokens(message);
  } catch {
    return 0;
  }
}

function usageTokens(message: AgentMessage): number {
  const usage = (message as { usage?: Parameters<typeof calculateContextTokens>[0] }).usage;
  if (!usage) return 0;
  try {
    return calculateContextTokens(usage);
  } catch {
    return 0;
  }
}

/**
 * Mirrors the provider-side estimator: trust the last applicable assistant
 * usage, then estimate trailing messages. It sees no context-edit provenance,
 * so after an omitted response it can keep an older, larger usage.
 */
export function usageTrustingEstimate(messages: readonly AgentMessage[]): { tokens: number; retainedUsageTokens: number | null } {
  let latestPrefix = Number.NEGATIVE_INFINITY;
  let usageIndex = -1;
  messages.forEach((message, index) => {
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Number.NEGATIVE_INFINITY;
    if (message.role === "assistant") {
      const stop = (message as { stopReason?: string }).stopReason;
      if (timestamp >= latestPrefix && stop !== "aborted" && stop !== "error" && usageTokens(message) > 0) usageIndex = index;
    }
    latestPrefix = Math.max(latestPrefix, timestamp);
  });
  if (usageIndex < 0) {
    return { tokens: messages.reduce((total, message) => total + safeTokens(message), 0), retainedUsageTokens: null };
  }
  const retained = usageTokens(messages[usageIndex]!);
  const trailing = messages.slice(usageIndex + 1).reduce((total, message) => total + safeTokens(message), 0);
  return { tokens: retained + trailing, retainedUsageTokens: retained };
}

/**
 * Whether Pi's canonical accounting rejects the branch's latest usable
 * assistant usage because a context edit or compaction came after it.
 */
export function usageInvalidatedByEdit(branch: readonly SessionEntry[]): boolean {
  let lastUsage = -1;
  let lastInvalidating = -1;
  branch.forEach((entry, index) => {
    if (entry.type === "context_edit" || entry.type === "compaction") lastInvalidating = index;
    if (entry.type !== "message") return;
    const message = (entry as { message?: AgentMessage }).message;
    const stop = (message as { stopReason?: string } | undefined)?.stopReason;
    if (message?.role === "assistant" && stop !== "aborted" && stop !== "error" && usageTokens(message) > 0) lastUsage = index;
  });
  return lastUsage >= 0 && lastInvalidating > lastUsage;
}

function textChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((size: number, block: { type?: string; text?: unknown }) =>
    size + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
}

function toolCalls(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((block: { type?: string }) => block?.type === "toolCall").length : 0;
}

export function registerActingRequestObserver(pi: ExtensionAPI): void {
  let pending: PendingRequest | undefined;
  let sequence = 0;

  pi.on("context_with_system", (event, ctx: ExtensionContext) => {
    const model = ctx.model;
    const requestedMaxTokens = numeric(model?.maxTokens);
    pending = { fields: {}, payloadSeen: false, requestedMaxTokens, payloadMaxTokens: null };
    if (!traceEnabled()) return undefined;
    try {
      const usage = ctx.getContextUsage();
      const estimate = usageTrustingEstimate(event.messages);
      const transformed = event.messages.reduce((total, message) => total + safeTokens(message), 0);
      pending.fields = {
        request: ++sequence,
        provider: typeof model?.provider === "string" ? model.provider : null,
        modelId: typeof model?.id === "string" ? model.id : null,
        contextWindow: numeric(model?.contextWindow),
        requestedMaxTokens,
        canonicalTokens: numeric(usage?.tokens),
        transformedContextTokens: transformed,
        providerEstimateTokens: estimate.tokens,
        retainedUsageTokens: estimate.retainedUsageTokens,
        usageInvalidatedByEdit: usageInvalidatedByEdit(ctx.sessionManager.getBranch()),
      };
    } catch {
      // Telemetry must never perturb the request it measures.
    }
    return undefined;
  });

  pi.on("before_provider_request", (event) => {
    // The first payload after a context belongs to it; later ones (cache
    // warming) do not.
    if (!pending || pending.payloadSeen) return undefined;
    pending.payloadSeen = true;
    const budget = payloadBudget(event.payload);
    pending.payloadMaxTokens = budget.payloadMaxTokens;
    Object.assign(pending.fields, budget);
    return undefined;
  });

  pi.on("after_provider_response", (event) => {
    if (pending) pending.fields.httpStatus = numeric(event.status);
  });

  pi.on("provider_stream_event", (event) => {
    const status = pending ? terminalStatus(event.data) : null;
    if (pending && status) Object.assign(pending.fields, status);
  });

  pi.on("message_end", (event, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant" || !pending) return;
    const request = pending;
    pending = undefined;
    const stopReason = message.stopReason;
    const usage: Partial<typeof message.usage> = message.usage ?? {};
    const outputTokens = numeric(usage.output);
    const clamped = request.payloadMaxTokens !== null && request.requestedMaxTokens !== null
      && request.payloadMaxTokens < request.requestedMaxTokens;
    if (traceEnabled()) {
      traceEvent("acting_request", {
        ...request.fields,
        outputClamped: clamped,
        outcome: label(stopReason, OUTCOMES),
        inputTokens: numeric(usage.input), outputTokens,
        reasoningTokens: numeric(usage.reasoning), cacheReadTokens: numeric(usage.cacheRead),
        cacheWriteTokens: numeric(usage.cacheWrite), totalTokens: numeric(usage.totalTokens),
        textChars: textChars(message), toolCalls: toolCalls(message),
      });
    }
    if (stopReason === "length" && clamped) {
      ctx.ui.notify(
        `shadow-compact: the response stopped after ${outputTokens ?? "?"} output tokens because the context left only a ${request.payloadMaxTokens}-token output allowance (model allows ${request.requestedMaxTokens}). The turn is unfinished; compact (/compact) before continuing.`,
        "warning",
      );
    }
  });
}

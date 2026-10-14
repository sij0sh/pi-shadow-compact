import { type Api, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CompletionInterface } from "./summary.js";
import { isStderrTraceEnabled, traceEvent } from "./trace.js";

export interface SummaryCallTrace {
  attemptId: string;
  stage: "native-history" | "native-prefix" | "builder" | "verifier";
  round: number;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function label(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" ? (allowed.includes(value) ? value : "other") : null;
}

export const REASONING = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const STATUS = ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"];
export const REASONS = ["max_output_tokens", "content_filter"];

export const TERMINAL_EVENTS = ["response.completed", "response.incomplete", "response.failed", "response.cancelled"];
export const OUTCOMES = ["stop", "toolUse", "length", "error", "aborted"];

/** Output allowance and reasoning effort from a provider payload; nothing else is read. */
export function payloadBudget(payload: unknown): { payloadMaxTokens: number | null; payloadReasoning: string | null } {
  const body = record(payload);
  return {
    payloadMaxTokens: numeric(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? record(body.generationConfig).maxOutputTokens),
    payloadReasoning: label(record(body.reasoning).effort ?? body.reasoning_effort, REASONING),
  };
}

/** Terminal status and incomplete reason from a provider stream event, or null for other events. */
export function terminalStatus(event: unknown): { providerStatus: string | null; providerReason: string | null } | null {
  const data = record(event);
  if (!TERMINAL_EVENTS.includes(typeof data.type === "string" ? data.type : "")) return null;
  const response = record(data.response);
  return {
    providerStatus: label(response.status, STATUS),
    providerReason: label(record(response.incomplete_details).reason, REASONS),
  };
}

/** Observe named safe fields only. Never retain raw payloads, events or errors. */
export async function completeWithSummaryTrace(
  completion: CompletionInterface,
  model: Model<Api>,
  context: Parameters<CompletionInterface["complete"]>[1],
  options: ModelsSimpleStreamOptions,
  call: SummaryCallTrace,
): ReturnType<CompletionInterface["complete"]> {
  if (!process.env.SHADOW_COMPACT_TRACE && !isStderrTraceEnabled()) {
    return completion.complete(model, context, options);
  }
  const fields: Record<string, unknown> = {
    ...call,
    requestedMaxTokens: numeric(options.maxTokens ?? model.maxTokens),
    requestedReasoning: label(options.reasoning, REASONING),
    payloadMaxTokens: null, payloadReasoning: null, httpStatus: null,
    providerStatus: null, providerReason: null,
  };
  const instrumented: ModelsSimpleStreamOptions = {
    ...options,
    onPayload: async (payload, requestModel) => {
      const replacement = await options.onPayload?.(payload, requestModel);
      Object.assign(fields, payloadBudget(replacement === undefined ? payload : replacement));
      return replacement;
    },
    onResponse: async (response, requestModel) => {
      fields.httpStatus = numeric(response.status);
      await options.onResponse?.(response, requestModel);
    },
    onProviderStreamEvent: async (event, requestModel) => {
      const status = terminalStatus(event);
      if (status) Object.assign(fields, status);
      await options.onProviderStreamEvent?.(event, requestModel);
    },
  };
  try {
    const response = await completion.complete(model, context, instrumented);
    traceEvent("summary_call", {
      ...fields,
      providerReasoning: label(response.providerThinkingLevel, REASONING),
      outcome: label(response.stopReason, OUTCOMES),
      inputTokens: numeric(response.usage.input), outputTokens: numeric(response.usage.output),
      reasoningTokens: numeric(response.usage.reasoning), cacheReadTokens: numeric(response.usage.cacheRead),
      cacheWriteTokens: numeric(response.usage.cacheWrite), totalTokens: numeric(response.usage.totalTokens),
      textChars: response.content.reduce((size, block) => size + (block.type === "text" ? block.text.length : 0), 0),
    });
    return response;
  } catch (error) {
    traceEvent("summary_call", { ...fields, outcome: options.signal?.aborted ? "aborted" : "request-failed" });
    throw error;
  }
}

import { type Api, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CompletionInterface } from "./summary.js";
import { isStderrTraceEnabled, traceEvent } from "./trace.js";

export interface SummaryCallTrace {
  attemptId: string;
  stage: "native-history" | "native-prefix" | "builder" | "verifier";
  round: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function label(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" ? (allowed.includes(value) ? value : "other") : null;
}

const REASONING = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const STATUS = ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"];
const REASONS = ["max_output_tokens", "content_filter"];

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
      const body = record(replacement === undefined ? payload : replacement);
      fields.payloadMaxTokens = numeric(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? record(body.generationConfig).maxOutputTokens);
      fields.payloadReasoning = label(record(body.reasoning).effort ?? body.reasoning_effort, REASONING);
      return replacement;
    },
    onResponse: async (response, requestModel) => {
      fields.httpStatus = numeric(response.status);
      await options.onResponse?.(response, requestModel);
    },
    onProviderStreamEvent: async (event, requestModel) => {
      const data = record(event);
      if (["response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(typeof data.type === "string" ? data.type : "")) {
        const response = record(data.response);
        fields.providerStatus = label(response.status, STATUS);
        fields.providerReason = label(record(response.incomplete_details).reason, REASONS);
      }
      await options.onProviderStreamEvent?.(event, requestModel);
    },
  };
  try {
    const response = await completion.complete(model, context, instrumented);
    traceEvent("summary_call", {
      ...fields,
      providerReasoning: label(response.providerThinkingLevel, REASONING),
      outcome: label(response.stopReason, ["stop", "toolUse", "length", "error", "aborted"]),
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

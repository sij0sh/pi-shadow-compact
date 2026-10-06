import { contentText, uuidv7, type Usage } from "@earendil-works/pi-ai";
import {
  compact,
  SettingsManager,
  getLatestCompactionEntry,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { buildCoverage } from "./checkpoint.js";
import { checkpointSummaryTarget, runCheckpointBuilderAgent, runCheckpointVerifierAgent } from "./checkpoint-agent.js";
import type { ShadowCompactConfig } from "./config.js";
import { sanitizeForContext } from "./normalize.js";
import { SessionHistoryIndex } from "./session-reader.js";
import { combineUsage, resolveSummarizerModel, resolveVerificationModel } from "./summary.js";
import { coverageIsUnchanged, isCoveredPrefix } from "./working-context.js";
import { latestCompactionId } from "./persist.js";
import { completeWithSummaryTrace } from "./summary-trace.js";
import { traceEvent } from "./trace.js";

class IncompleteNativeSummary extends Error {
  constructor(readonly draft: string, readonly maxTokens: number) {
    super("Native summary hit the token cap");
  }
}

/** Run Pi's original method, then allow one evidence-backed compression on length only. */
export async function compactWithRecovery(
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  config: ShadowCompactConfig,
  attemptId = uuidv7(),
): Promise<CompactionResult | undefined> {
  const model = ctx.model;
  const { preparation, signal } = event;
  // Empty synthetic preparations have no evidence to summarize. Virtual models
  // must remain with Pi, whose runtime routes before computing summary budgets.
  if (!model || model.api === "pi-virtual" ||
      (!preparation.messagesToSummarize.length && !preparation.turnPrefixMessages.length)) return;
  const branch = event.branchEntries.slice();
  const leafId = branch.at(-1)?.id ?? "";
  const sessionId = ctx.sessionManager.getSessionId();
  const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
  const nativeUsages: Usage[] = [];
  let nativeStage: "native-history" | "native-prefix" = preparation.messagesToSummarize.length ? "native-history" : "native-prefix";
  // Pi skips extension-owned details on the next compaction. Carry our file
  // lists explicitly so wrapping a successful native call does not lose them.
  const previous = getLatestCompactionEntry(branch);
  const fileOps = {
    read: new Set(preparation.fileOps.read),
    written: new Set(preparation.fileOps.written),
    edited: new Set(preparation.fileOps.edited),
  };
  if (previous?.fromHook && previous.details && typeof previous.details === "object") {
    const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
    for (const path of Array.isArray(details.readFiles) ? details.readFiles : []) {
      if (typeof path === "string") fileOps.read.add(path);
    }
    for (const path of Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) {
      if (typeof path === "string") fileOps.edited.add(path);
    }
  }
  try {
    return await compact(
      { ...preparation, fileOps }, model, undefined, undefined, event.customInstructions, signal,
      config.thinkingLevel ?? "low",
      async (requestModel, context, options) => {
        signal.throwIfAborted();
        let stream!: ReturnType<typeof ctx.modelRegistry.streamSimple>;
        const response = await completeWithSummaryTrace({ complete: (model, context, options) => {
          stream = ctx.modelRegistry.streamSimple(model, context, options);
          return stream.result();
        } }, requestModel, context, { ...settings.getProviderRetrySettings(), ...options }, {
          attemptId, stage: nativeStage, round: nativeUsages.length + 1,
        });
        nativeUsages.push(response.usage);
        signal.throwIfAborted();
        if (response.stopReason === "length") {
          // Capture visible prose only. Never execute partial calls or forward
          // thinking, provider metadata, response bodies, or error payloads.
          throw new IncompleteNativeSummary(
            sanitizeForContext(contentText(response.content), ctx.cwd), options?.maxTokens ?? 0,
          );
        }
        if (response.stopReason === "stop" && preparation.isSplitTurn) nativeStage = "native-prefix";
        return stream;
      },
      undefined, settings.getRetrySettings(),
    );
  } catch (error) {
    if (!(error instanceof IncompleteNativeSummary)) throw error;
    signal.throwIfAborted();
    const summaryModel = resolveSummarizerModel(ctx, config);
    const verifierModel = resolveVerificationModel(ctx, config);
    const maxTokens = Math.min(
      error.maxTokens, config.summaryMaxTokens ?? Infinity,
      summaryModel.maxTokens > 0 ? summaryModel.maxTokens : Infinity,
      verifierModel.maxTokens > 0 ? verifierModel.maxTokens : Infinity,
    );
    if (maxTokens < 1) throw new Error("Native summary recovery has no output allowance");
    const targetSummaryChars = checkpointSummaryTarget(summaryModel, maxTokens);
    const previousSummary = preparation.previousSummary;
    const makeIndex = () => new SessionHistoryIndex({
      branch, cwd: ctx.cwd,
      ...(previousSummary ? { previousCheckpointSummary: previousSummary } : {}),
    });
    const request = {
      signal, maxTokens, targetSummaryChars, attemptId,
      // Lower only private summary reasoning; do not mutate acting settings.
      thinkingLevel: "low" as const,
      ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
    };
    traceEvent("summary_recovery", { attemptId, stage: "started", reason: "length", maxTokens, targetSummaryChars });
    let stage = "builder";
    try {
      const built = await runCheckpointBuilderAgent(ctx, makeIndex(), config, {
        ...request, model: summaryModel, incompleteDraft: error.draft,
      });
      const coverage = buildCoverage({
        sourceStartEntryId: null, coverageEndEntryId: built.coverageEndEntryId,
        preparedAtLeafId: leafId, publishedAtLeafId: leafId,
      });
      stage = "verifier";
      const verified = await runCheckpointVerifierAgent(ctx, makeIndex(), built.checkpoint, coverage, config, {
        ...request, model: verifierModel,
      });
      stage = "freshness";
      signal.throwIfAborted();
      const current = ctx.sessionManager.getBranch();
      const finalCoverage = { ...coverage, coverageEndEntryId: verified.coverageEndEntryId };
      if (ctx.sessionManager.getSessionId() !== sessionId ||
          !current.some((entry) => entry.id === leafId) ||
          latestCompactionId(current) !== latestCompactionId(branch) ||
          !coverageIsUnchanged(current, finalCoverage) ||
          !isCoveredPrefix(current, verified.coverageEndEntryId, preparation.firstKeptEntryId)) {
        throw new Error("Native summary recovery does not cover the current compaction prefix");
      }
      const modifiedFiles = [...new Set([...fileOps.written, ...fileOps.edited])].sort();
      const readFiles = [...fileOps.read].filter((path) => !modifiedFiles.includes(path)).sort();
      const usage = nativeUsages.reduce((total, item) => combineUsage(total, item), combineUsage(built.usage, verified.usage));
      traceEvent("summary_recovery", { attemptId, stage: "completed", reason: "length", maxTokens, summaryChars: verified.summary.length });
      return {
        summary: verified.summary, firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore, usage, details: { readFiles, modifiedFiles },
      };
    } catch (failure) {
      traceEvent("summary_recovery", { attemptId, stage: "failed", reason: signal.aborted ? "cancelled" : stage, maxTokens });
      throw failure;
    }
  }
}

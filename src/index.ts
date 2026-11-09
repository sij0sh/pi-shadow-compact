import {
  buildSessionProjection,
  estimateTokens as estimateMessageTokens,
  getLatestCompactionEntry,
  SettingsManager,
  type ContextEvent,
  type BoundaryState,
  type BoundaryResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  checkpointSummaryTarget,
  runCheckpointBuilderAgent,
  runCheckpointVerifierAgent,
} from "./checkpoint-agent.js";
import {
  buildCoverage,
  CHECKPOINT_SCHEMA_VERSION,
  currentPromptVersions,
} from "./summary.js";
import {
  DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT,
  DEFAULT_RECENT_TURNS,
  isBelowPrepare,
  isObserveMode,
  isRollingEnabled,
  loadConfig,
  type ShadowCompactConfig,
} from "./config.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  collectShadowSummaries,
  checkpointStalenessReason,
  findLatestRestorableCheckpoint,
  latestCompactionId,
  type PreparedResult,
} from "./persist.js";
import { compactWithRecovery } from "./native-compaction.js";
import { sanitizeForContext } from "./normalize.js";
import { fileDetails, hasCompactableHistory } from "./working-context.js";
import { SessionHistoryIndex } from "./session-reader.js";
import { ShadowCompactStateController } from "./state.js";
import {
  combineUsage,
  resolveSummarizerModel,
  resolveVerificationModel,
} from "./summary.js";
import { COMPACTION_CAPABILITY, traceEvent } from "./trace.js";
import { estimateTokens } from "./turns.js";
import { contextSwapDropCount, hasOrphanedToolResult } from "./swap.js";
import {
  buildWorkingContext,
  coverageIsUnchanged,
  triggerOverlapStart,
  isCoveredPrefix,
  isWorkingContextSkipped,
  planSwap,
} from "./working-context.js";
import { randomUUID } from "node:crypto";

const READY_MESSAGE = "shadow-compact: checkpoint ready; next safe request will use it";
const DEFERRED_MESSAGE =
  "shadow-compact: checkpoint still preparing in background";
const MANUAL_PREPARE_MESSAGE = "shadow-compact: preparing a fresh checkpoint for /compact";

/**
 * Pi invalidates a captured ctx after session replacement or reload, and every
 * use of it then throws. Background completions (a summary finishing, a
 * commit settling) routinely outlive their session, so they must probe before
 * touching ctx — an escaped throw here is an unhandled rejection that takes
 * down the whole agent process.
 */
function isContextStale(ctx: ExtensionContext): boolean {
  try {
    ctx.isIdle();
  } catch (error) {
    if (error instanceof Error && error.message.includes("is stale after session replacement")) {
      return true;
    }
    throw error;
  }
  return false;
}

export default function shadowCompact(pi: ExtensionAPI): void {
  const state = new ShadowCompactStateController();
  let configPromise: Promise<ShadowCompactConfig> | undefined;
  let reportedError: string | undefined;
  let configErrorReported = false;
  // One native-compaction request at a time: "escape" is the explicit
  // /compact-native command (pure Pi), "fallback" is the in-hook emergency or
  // recovery path (wrapped, with token-cap recovery). Any compaction outcome,
  // branch change, or session reset clears the slot.
  let nativeMode: "none" | "escape" | "fallback" = "none";
  let compactTrace: { attemptId: string; sessionId: string | null; route: string } | undefined;
  let turnCount = 0;

  const canCompact = (ctx: ExtensionContext): boolean => {
    if (!ctx.model) return false;
    // Use Pi's live effective settings, including SDK overrides and project trust.
    const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
    return hasCompactableHistory(ctx.sessionManager.getBranch(), settings.keepRecentTokens);
  };

  pi.registerCommand("compact-native", {
    description: "Run pure Pi compaction; Shadow token-cap recovery is disabled",
    handler: async (_args, cmdCtx) => {
      if (!canCompact(cmdCtx)) {
        cmdCtx.ui.notify("shadow-compact: nothing to compact; recent history is still within Pi's retained tail", "info");
        return;
      }
      nativeMode = "escape";
      cmdCtx.compact({});
    },
  });

  const runNativeFallback = (ctx: ExtensionContext): boolean => {
    // Manual compaction aborts an active agent run, so only start it while Pi is idle.
    if (nativeMode === "fallback" || !ctx.isIdle()) return false;
    nativeMode = "fallback";
    ctx.compact({});
    return true;
  };

  const resultIsCurrent = (ctx: ExtensionContext, result: PreparedResult): boolean =>
    checkpointStalenessReason(
      ctx.sessionManager.getBranch(),
      ctx.sessionManager.getSessionId(),
      result,
    ) === undefined;

  /**
   * The one staleness sync. A checkpoint whose session, cut, coverage, or
   * native-compaction ancestry moved can never serve or install again, so it
   * is dropped (which re-arms the next crossing) rather than left latched.
   * Every hook that can act on the serving checkpoint calls this first.
   */
  const dropStalePublishedCheckpoint = (ctx: ExtensionContext): void => {
    if (state.published && !resultIsCurrent(ctx, state.published)) state.discardPublished();
  };

  // Shared durability path: a published, still-current checkpoint is appended
  // as extension state (a CustomEntry, invisible to the model) once the agent
  // is idle when no boundary installation has landed. Raw history remains
  // evidence; this CustomEntry does not change canonical context.
  const persistReadyCheckpoint = (ctx: ExtensionContext): void => {
    if (!ctx.isIdle()) return;
    const result = state.published;
    if (!result) return;
    if (!resultIsCurrent(ctx, result)) {
      // A native compaction landed under the checkpoint (or the branch moved
      // on): drop the projection and re-arm so the next crossing prepares
      // fresh. Validation on restore rejects the persisted twin the same way.
      dropStalePublishedCheckpoint(ctx);
      return;
    }
    if (result.checkpointId === state.persistedCheckpointId) return;
    try {
      pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, result);
    } catch (error) {
      // An append can fail when the idle point races teardown. The checkpoint
      // keeps serving and the next settle retries; nothing crashes the agent.
      traceEvent("checkpoint_persisted", {
        turn: turnCount,
        generation: state.generation,
        action: "failed",
        checkpointId: result.checkpointId,
        error: sanitizeForContext(error instanceof Error ? error.message : String(error), "").slice(0, 1400),
      });
      return;
    }
    state.markPersisted(result.checkpointId);
    traceEvent("checkpoint_persisted", {
      turn: turnCount,
      generation: state.generation,
      version: result.version,
      checkpointId: result.checkpointId,
      firstKeptEntryId: result.firstKeptEntryId,
      leafId: result.leafId,
      coverageEnd: result.coverage?.coverageEndEntryId ?? null,
      summaryChars: result.summary.length,
      contextTokensBefore: result.contextTokensBefore ?? null,
    });
  };

  // Restores the latest valid persisted checkpoint into service. Runs on every
  // session_start (initial load, reload, resume): raw history is the evidence,
  // the checkpoint is the replaceable projection over it.
  const restorePersistedCheckpoint = (ctx: ExtensionContext): void => {
    if (isObserveMode()) return;
    let branch: SessionEntry[];
    let sessionId: string;
    try {
      branch = ctx.sessionManager.getBranch();
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      // No readable session to restore from; start cold.
      return;
    }
    const { found, skippedStale } = findLatestRestorableCheckpoint(branch, sessionId);
    for (const skipped of skippedStale) {
      traceEvent("checkpoint_restore_rejected", {
        checkpointId: skipped.checkpointId,
        reason: skipped.reason,
        latestCompactionId: latestCompactionId(branch),
      });
    }
    if (!found) return;
    state.restorePublished(found.checkpoint);
    traceEvent("checkpoint_restored", {
      version: found.checkpoint.version,
      checkpointId: found.checkpoint.checkpointId,
      firstKeptEntryId: found.checkpoint.firstKeptEntryId,
      leafId: found.checkpoint.leafId,
      coverageEnd: found.checkpoint.coverage.coverageEndEntryId,
      summaryChars: found.checkpoint.summary.length,
    });
  };

  // Idle-point actions shared by agent_settled and post-settle preparation outcomes.
  // A failure-queued fallback compacts when Pi has a disposable prefix.
  // An emergency-queued fallback recompacts only while
  // the spike is still present: context may have recovered while the run
  // drained, and a stale hatch must not compact a healthy working set.
  const settle = (ctx: ExtensionContext, deferredNotice: boolean, nativeThreshold?: number): void => {
    if (!ctx.isIdle()) return;
    if (state.preparing) {
      // A replacement is still being built. Its completion persists once Pi
      // stays idle; persisting the older checkpoint now would be immediately
      // superseded, so wait for the replacement.
      if (deferredNotice) ctx.ui.notify(DEFERRED_MESSAGE, "info");
      return;
    }
    const pendingReason = state.pendingFallbackReason;
    if (pendingReason !== undefined && state.clearPendingNativeFallback()) {
      if (pendingReason === "emergency" && nativeThreshold !== undefined) {
        const idleUsage = ctx.getContextUsage();
        const idlePercent = idleUsage?.percent;
        if (idlePercent !== undefined && idlePercent !== null && idlePercent < nativeThreshold) {
          traceEvent("native_fallback", {
            turn: turnCount,
            generation: state.generation,
            reason: "emergency",
            action: "skipped-recovered",
            contextTokens: idleUsage?.tokens ?? null,
            contextPercent: idlePercent,
          });
          persistReadyCheckpoint(ctx);
          return;
        }
      }
      if (!canCompact(ctx)) {
        traceEvent("native_fallback", {
          turn: turnCount, generation: state.generation, reason: pendingReason,
          action: "skipped-no-prefix",
        });
        // Skipping replaces the failure event that would otherwise re-arm an
        // aborted preparation. Preserve a valid checkpoint if one is serving.
        if (!state.published) state.reset();
        persistReadyCheckpoint(ctx);
        return;
      }
      if (!runNativeFallback(ctx)) state.requestNativeFallback(pendingReason);
      return;
    }
    persistReadyCheckpoint(ctx);
  };

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = sanitizeForContext(error instanceof Error ? error.message : String(error), "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1400);
    if (reportedError === message) return;
    reportedError = message;
    ctx.ui.notify(`shadow-compact: ${message}`, "error");
  };

  const configFor = async (ctx: ExtensionContext): Promise<ShadowCompactConfig> => {
    configPromise ??= loadConfig(ctx).then(
      (config) => {
        // A failed load must not stay memoized: the next turn retries the read.
        if (configErrorReported) {
          configErrorReported = false;
          ctx.ui.notify("shadow-compact: config recovered", "info");
        }
        reportedError = undefined;
        return config;
      },
      (error: unknown) => {
        configPromise = undefined;
        throw error;
      },
    );
    return configPromise;
  };

  const prepare = async (
    ctx: ExtensionContext,
    config: ShadowCompactConfig,
    branch: SessionEntry[],
    controller: AbortController,
    generation: number,
    retainedAnchor?: string,
    customInstructions?: string,
    attemptId = randomUUID(),
  ): Promise<void> => {
    const startedWallMs = Date.now();
    // Releases a preparation whose session died underneath it (replacement or
    // reload while the summary ran). True means the ctx is dead: callers must
    // return without settle/notify/compact, which would all throw on it.
    // fail() mirrors the abort path and self-heals (a later session_start or
    // settle consumes or clears whatever it queues).
    const bailIfStale = (): boolean => {
      if (!isContextStale(ctx)) return false;
      if (state.fail(generation)) {
        traceEvent("prepare_failed", {
          turn: turnCount,
          generation,
          reason: "stale-context",
        });
      }
      return true;
    };
    const failPrepare = (reason: string, extra: Record<string, unknown> = {}): void => {
      if (state.fail(generation)) {
        traceEvent("prepare_failed", {
          turn: turnCount,
          generation,
          reason,
          ...extra,
        });
      }
      // A preparation can finish after the settle point it missed; act now if idle.
      settle(ctx, false, config.nativeFallbackThresholdPercent);
    };
    try {
      const contextUsage = ctx.getContextUsage();
      const tokensAtStart = contextUsage?.tokens ?? undefined;
      const leafIdAtStart = branch[branch.length - 1]?.id ?? "";
      const sessionIdAtStart = ctx.sessionManager.getSessionId();
      // Degenerate branches carry nothing to summarize. Suppress without
      // queuing a native fallback instead of churning every turn; the
      // recorded size re-arms once the working set grows meaningfully.
      const lastEntry = branch[branch.length - 1];
      const hypothetical = branch.length > 0 && lastEntry
        ? planSwap(branch, lastEntry.id, config.recentTurns)
        : undefined;
      if (
        branch.length === 0 ||
        lastEntry?.type === "compaction" ||
        !hypothetical ||
        (contextSwapDropCount(branch, hypothetical.swapStartEntryId) ?? 0) === 0
      ) {
        if (state.skipPreparation(generation, tokensAtStart)) {
          traceEvent("prepare_failed", {
            turn: turnCount,
            generation,
            reason: "empty-snapshot",
            action: "suppressed-until-growth",
            branchEntries: branch.length,
          });
        }
        settle(ctx, false, config.nativeFallbackThresholdPercent);
        return;
      }

      // Previous-checkpoint context for the agent: the serving checkpoint
      // when present, else the newest Shadow summary on the branch, else the
      // native compaction summary. Raw history stays the primary evidence in
      // every case; this orients the agent, it never substitutes for reads.
      const serving = state.published;
      let previousSummary: string | undefined;
      let previousCoverageEnd: string | null = null;
      if (serving) {
        previousSummary = serving.summary;
        previousCoverageEnd = serving.coverage?.coverageEndEntryId ?? null;
      } else {
        const shadow = collectShadowSummaries(branch, ctx.sessionManager.getSessionId(), 1);
        previousSummary = shadow[0];
        if (!previousSummary) {
          previousSummary = getLatestCompactionEntry(branch)?.summary;
        }
      }

      const model = resolveSummarizerModel(ctx, config);
      const maxTokens = config.summaryMaxTokens;
      const verifierModel = resolveVerificationModel(ctx, config);
      const targetSummaryChars = Math.min(checkpointSummaryTarget(model, maxTokens), checkpointSummaryTarget(verifierModel, maxTokens));
      const makeIndex = () => new SessionHistoryIndex({
        branch,
        cwd: ctx.cwd,
        previousCoverageEndEntryId: previousCoverageEnd,
        ...(previousSummary ? { previousCheckpointSummary: previousSummary } : {}),
      });
      const builderIndex = makeIndex();
      const outcome = await runCheckpointBuilderAgent(ctx, builderIndex, config, {
        signal: controller.signal,
        ...(customInstructions ? { customInstructions } : {}),
        model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        targetSummaryChars, attemptId,
        thinkingLevel: config.thinkingLevel ?? "low",
      });
      if (bailIfStale()) return;
      const summaryWallMs = Date.now() - startedWallMs;

      // Second-pass verification gate with independent history access: the
      // verifier audits the draft against the session it reads itself, so a
      // shared blind spot cannot hide an omission from both passes.
      const verifierThinking = config.verificationThinkingLevel ?? config.thinkingLevel ?? "low";
      const verifierStartedWallMs = Date.now();
      const draftCoverage = buildCoverage({
        sourceStartEntryId: null,
        coverageEndEntryId: outcome.coverageEndEntryId,
        preparedAtLeafId: leafIdAtStart,
        publishedAtLeafId: leafIdAtStart,
      });
      const verified = await runCheckpointVerifierAgent(ctx, makeIndex(), outcome.checkpoint, draftCoverage, config, {
        signal: controller.signal,
        ...(customInstructions ? { customInstructions } : {}),
        model: verifierModel,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        targetSummaryChars, attemptId,
        thinkingLevel: verifierThinking,
      });
      if (bailIfStale()) return;
      const verifierWallMs = Date.now() - verifierStartedWallMs;

      const usage = combineUsage(outcome.usage, verified.usage);

      const current = ctx.sessionManager.getBranch();
      const publishedLeaf = ctx.sessionManager.getLeafId() ?? (current[current.length - 1]?.id ?? "");
      const coverage = buildCoverage({
        sourceStartEntryId: null,
        coverageEndEntryId: verified.coverageEndEntryId,
        preparedAtLeafId: leafIdAtStart,
        publishedAtLeafId: publishedLeaf,
      });
      const estimate = planSwap(branch, coverage.coverageEndEntryId, config.recentTurns);
      const result: PreparedResult = {
        version: CHECKPOINT_SCHEMA_VERSION,
        checkpointId: randomUUID(),
        sessionId: sessionIdAtStart,
        leafId: publishedLeaf,
        latestCompactionId: latestCompactionId(branch),
        firstKeptEntryId: retainedAnchor ?? estimate?.swapStartEntryId ?? branch[0]!.id,
        summary: verified.summary,
        usage,
        details: fileDetails(branch),
        contextTokensBefore: ctx.getContextUsage()?.tokens ?? 0,
        createdAt: Date.now(),
        coverage,
        structured: verified.checkpoint,
        generatedAt: Date.now(),
        prompts: currentPromptVersions(),
      };
      traceEvent("prepare_completed", {
        attemptId, targetSummaryChars,
        turn: turnCount,
        generation,
        summaryChars: verified.summary.length,
        summaryInput: outcome.usage.input,
        summaryOutput: outcome.usage.output,
        summaryCacheRead: outcome.usage.cacheRead,
        summaryCacheWrite: outcome.usage.cacheWrite,
        summaryModel: `${model.provider}/${model.id}`,
        summaryThinking: config.thinkingLevel ?? "low",
        verifierInput: verified.usage.input,
        verifierOutput: verified.usage.output,
        verifierCacheRead: verified.usage.cacheRead,
        verifierCacheWrite: verified.usage.cacheWrite,
        verifierModel: `${verifierModel.provider}/${verifierModel.id}`,
        verifierThinking: verifierThinking ?? null,
        verifierWallMs,
        verifierVerdict: verified.verdict,
        summaryWallMs,
        inspectedEntries: builderIndex.inspectedEntryIds.size,
        builderRounds: outcome.toolRounds,
        verifierRounds: verified.toolRounds,
        hasPreviousCheckpoint: previousSummary !== undefined,
        coverageEnd: coverage.coverageEndEntryId,
        preparedAtLeaf: coverage.preparedAtLeafId,
        publishedAtLeaf: coverage.publishedAtLeafId,
        firstKeptEntryId: result.firstKeptEntryId,
        leafId: result.leafId,
      });
      const valid =
        ctx.sessionManager.getSessionId() === result.sessionId &&
        current.some((entry) => entry.id === result.leafId) &&
        current.some((entry) => entry.id === coverage.coverageEndEntryId) &&
        latestCompactionId(current) === result.latestCompactionId &&
        coverageIsUnchanged(current, coverage) &&
        current.some((entry) => entry.id === result.firstKeptEntryId);
      // Ownership-checked: a superseded completion no-ops instead of aborting a newer prepare.
      const replaced = Boolean(state.published);
      if (!valid || !state.publish(generation, result)) {
        failPrepare(valid ? "superseded" : "stale-branch", { coverageEnd: coverage.coverageEndEntryId });
        return;
      }
      traceEvent("checkpoint_published", {
        turn: turnCount,
        generation,
        firstKeptEntryId: result.firstKeptEntryId,
        leafId: result.leafId,
        coverageEnd: coverage.coverageEndEntryId,
        summaryChars: result.summary.length,
        contextTokensBefore: result.contextTokensBefore ?? null,
        replaced,
      });
      ctx.ui.notify(READY_MESSAGE, "info");
      persistReadyCheckpoint(ctx);
    } catch (error) {
      // The summary itself may throw the stale error (or anything after it
      // may run on a dead session): never notify/settle on a dead ctx.
      if (bailIfStale()) return;
      if (state.preparing?.generation !== generation) return;
      if (!controller.signal.aborted) reportError(ctx, error);
      else {
        traceEvent("prepare_failed", {
          turn: turnCount,
          generation,
          reason: "aborted",
        });
      }
      if (state.fail(generation)) {
        traceEvent("prepare_failed", { generation, reason: controller.signal.aborted ? "aborted" : "model-error", error: sanitizeForContext(error instanceof Error ? error.message : String(error), "").slice(0, 1400) });
      }
      settle(ctx, false, config.nativeFallbackThresholdPercent);
    }
  };

  /**
   * The single preparation entry point (spec §24E): threshold crossings,
   * idle settles, and manual requests all funnel through here instead of
   * owning independent compaction logic.
   */
  const requestCheckpoint = (
    ctx: ExtensionContext,
    config: ShadowCompactConfig,
    branch: SessionEntry[],
    reason: string,
    customInstructions?: string,
    triggerEntryId?: string,
  ): boolean => {
    const manual = reason === "command";
    if (!manual && !isRollingEnabled() && state.published) return false;
    if (state.preparing || state.pendingNativeFallback) return false;
    const usage = ctx.getContextUsage();
    if (!manual && !state.refreshArmed) {
      // Still above the trigger after a refresh cycle without an observed
      // swap + shrink: the checkpoint/tail policy is not achieving the
      // target. Log, don't spin.
      traceEvent("threshold_crossed", {
        turn: turnCount,
        generation: state.generation,
        action: "suppressed",
        reason,
        contextTokens: usage?.tokens ?? null,
        contextPercent: usage?.percent ?? null,
        prepareThreshold: config.prepareThresholdPercent,
        prepareThresholdTokens: config.softCompactThresholdTokens ?? null,
      });
      return false;
    }
    branch = branch.slice();
    const retainedAnchor = triggerOverlapStart(branch);
    const prepared = state.startPreparing();
    if (!prepared) return false;
    traceEvent("threshold_crossed", {
      turn: turnCount,
      generation: prepared.generation,
      action: "started",
      reason,
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      prepareThreshold: config.prepareThresholdPercent,
      prepareThresholdTokens: config.softCompactThresholdTokens ?? null,
    });
    traceEvent("prepare_started", {
      turn: turnCount,
      generation: prepared.generation,
      reason,
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      prepareThreshold: config.prepareThresholdPercent,
      prepareThresholdTokens: config.softCompactThresholdTokens ?? null,
      branchEntries: branch.length,
      leafId: branch.at(-1)?.id ?? null,
      overlapStart: retainedAnchor ?? null,
      triggerEntryId: triggerEntryId ?? branch.at(-1)?.id ?? null,
    });
    if (manual) ctx.ui.notify("shadow-compact: checkpoint preparing in background", "info");
    // Fire and forget: the live agent run continues immediately.
    void prepare(ctx, config, branch, prepared.controller, prepared.generation, retainedAnchor, customInstructions);
    return true;
  };

  pi.registerCommand("shadow-compact", {
    description: "Prepare a verified checkpoint in background without interrupting acting work",
    handler: async (args, ctx) => {
      if (isObserveMode()) {
        ctx.ui.notify("shadow-compact: disabled in observe mode", "info");
        return;
      }
      const branch = ctx.sessionManager.getBranch().slice();
      const config = await configFor(ctx).catch((error: unknown) => { reportError(ctx, error); return undefined; });
      if (!config || isContextStale(ctx)) return;
      if (state.preparing) {
        ctx.ui.notify("shadow-compact: already preparing; existing attempt and instructions unchanged. Run /shadow-compact again after completion to refresh.", "info");
        return;
      }
      if (!requestCheckpoint(ctx, config, branch, "command", args.trim())) {
        ctx.ui.notify("shadow-compact: native recovery pending; checkpoint not started", "info");
      }
    },
  });

  // Mid-run swap: a published, current summary replaces the stale prefix in the
  // next request. This touches only the request's message list, so the agent run
  // never aborts. A safe boundary can install canonical context; idle completion
  // persists a CustomEntry instead. The
  // serving checkpoint keeps swapping before and after it lands, and while its
  // replacement prepares; publishing the replacement swaps future requests to it.
  const swapSummaryIntoContext = async (
    ctx: ExtensionContext,
    event: ContextEvent,
    config: ShadowCompactConfig | undefined,
  ) => {
    const result = state.published;
    if (!result) return undefined;
    let branch: SessionEntry[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return undefined;
    }
    if (!resultIsCurrent(ctx, result)) return undefined;
    const coverage = result.coverage;
    const built = buildWorkingContext({
      checkpoint: { summary: result.summary, coverage },
      branch,
      messages: event.messages,
      minimumRecentTurns: config?.recentTurns ?? DEFAULT_RECENT_TURNS,
      contextTokensBefore: result.contextTokensBefore,
      retainedAnchor: result.firstKeptEntryId,
    });
    if (isWorkingContextSkipped(built)) {
      traceEvent("swap_applied", {
        turn: turnCount,
        generation: state.generation,
        action: `skipped-${built.skipped}`,
        messagesBefore: event.messages.length,
        ...(built.droppedMessages !== undefined ? { messagesDropped: built.droppedMessages } : {}),
        firstKeptEntryId: result.firstKeptEntryId,
        leafId: result.leafId,
        coverageEnd: coverage.coverageEndEntryId,
      });
      return undefined;
    }
    const firstSwap = state.markSwapped(turnCount);
    const usage = ctx.getContextUsage();
    const checkpointTokens = estimateTokens(result.summary);
    const continuityTokens = estimateTokens(JSON.stringify(built.messages.slice(1)));
    traceEvent("swap_applied", {
      turn: turnCount,
      generation: state.generation,
      firstSwap,
      swapCount: state.swapCount,
      messagesBefore: event.messages.length,
      messagesAfter: built.messages.length,
      messagesDropped: built.droppedMessages,
      contextTokensBefore: result.contextTokensBefore ?? null,
      contextTokensAtSwap: usage?.tokens ?? null,
      contextPercentAtSwap: usage?.percent ?? null,
      firstKeptEntryId: result.firstKeptEntryId,
      leafId: result.leafId,
      coverageEnd: coverage.coverageEndEntryId,
      swapStart: built.plan.swapStartEntryId,
      checkpointTokens,
      continuityTokens,
      totalInjectedTokens: checkpointTokens + continuityTokens,
    });
    return { messages: built.messages };
  };

  const workingMessagesBeforeCompaction = (
    ctx: ExtensionContext,
    recentTurns: number,
  ): ContextEvent["messages"] => {
    const branch = ctx.sessionManager.getBranch();
    const messages = buildSessionProjection(branch).messages.filter((message) => message.role !== "system");
    const result = state.published;
    if (!result || !resultIsCurrent(ctx, result)) return messages;
    const built = buildWorkingContext({
      checkpoint: { summary: result.summary, coverage: result.coverage },
      branch,
      messages,
      minimumRecentTurns: recentTurns,
      retainedAnchor: result.firstKeptEntryId,
    });
    return isWorkingContextSkipped(built) ? messages : built.messages;
  };

  // Pi's prepared cut owns real compaction. A checkpoint may replace its
  // prefix only when it covers every visible entry Pi will discard. Ignore
  // recovery omissions and state-only suffixes when proving coverage.
  const coversCompactionPrefix = (
    ctx: ExtensionContext,
    result: PreparedResult,
    firstKeptEntryId: string,
  ): boolean => {
    const branch = ctx.sessionManager.getBranch();
    return isCoveredPrefix(branch, result.coverage.coverageEndEntryId, firstKeptEntryId);
  };

  const serveCompaction = (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
    result: PreparedResult,
    messagesBefore: ContextEvent["messages"],
  ) => {
    const firstKeptEntryId = event.preparation.firstKeptEntryId;
    if (!coversCompactionPrefix(ctx, result, firstKeptEntryId)) return undefined;
    const branch = ctx.sessionManager.getBranch();
    const candidate = projectCheckpoint(branch, result.summary, firstKeptEntryId, event.preparation.tokensBefore);
    if (hasOrphanedToolResult(candidate)) return undefined;
    const before = estimatedTokens(messagesBefore);
    const after = estimatedTokens(candidate);
    // Committing the checkpoint and tail already being served is a no-op,
    // even when it drops entries from canonical history. Let Pi summarize
    // natively rather than reporting another successful non-reduction.
    if (after >= before) {
      traceEvent("compaction_fallback", { reason: "no-reduction", firstKeptEntryId, estimatedTokensBefore: before, estimatedTokensAfter: after });
      return undefined;
    }
    traceEvent("compaction_served", { reason: event.reason, firstKeptEntryId, estimatedTokensBefore: before, estimatedTokensAfter: after });
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: result.usage,
        details: result.details,
      },
    };
  };

  // Boundary drafts do not emit session_compact in Pi 1.0.4. Only observed
  // committed ancestry releases serving state; proposing a draft is not success.
  const observeInstalledCheckpoint = (ctx: ExtensionContext): void => {
    const result = state.published;
    if (!result) return;
    const latest = getLatestCompactionEntry(ctx.sessionManager.getBranch());
    const details = latest?.details as { shadowCheckpoint?: { checkpointId?: string } } | undefined;
    if (latest && details?.shadowCheckpoint?.checkpointId === result.checkpointId) {
      traceEvent("checkpoint_installed", { checkpointId: result.checkpointId, compactionId: latest.id, firstKeptEntryId: latest.firstKeptEntryId });
      state.reset();
      nativeMode = "none";
      ctx.ui.notify("shadow-compact: checkpoint installed", "info");
    }
  };

  /**
   * Projects a branch as if `summary` were committed at `firstKeptEntryId`.
   * Pi's own projector is authoritative: recovery can put the cut on an
   * invisible omission/state entry, so slicing at a visible message would
   * reject valid cuts or retain an abandoned attempt.
   */
  const projectCheckpoint = (
    branch: SessionEntry[],
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): ContextEvent["messages"] => buildSessionProjection([...branch, {
    type: "compaction",
    id: randomUUID(),
    parentId: branch[branch.length - 1]?.id ?? null,
    timestamp: new Date().toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore,
  }]).messages.filter((message) => message.role !== "system");

  const estimatedTokens = (messages: ContextEvent["messages"]): number =>
    messages.reduce((total, message) => total + estimateMessageTokens(message), 0);

  const installAtBoundary = (
    event: BoundaryState,
    ctx: ExtensionContext,
    recentTurns: number,
  ): BoundaryResult | undefined => {
    observeInstalledCheckpoint(ctx);
    if (!event.context || event.outcome !== "completed") return;
    const result = state.published;
    if (!result || !resultIsCurrent(ctx, result)) return;
    // Replay earlier handlers' drafts on a private branch. Never mutate Pi's
    // manager, and never ignore an earlier handler's compaction/context edits.
    const branch = ctx.sessionManager.getBranch().slice();
    for (const draft of event.entries ?? []) {
      branch.push({
        ...draft,
        id: randomUUID(),
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        ...(draft.type === "compaction" ? { tokensBefore: 0 } : {}),
      } as SessionEntry);
    }
    if (latestCompactionId(branch) !== result.latestCompactionId) return;
    const coverage = result.coverage;
    // The replayed drafts must still cover the checkpoint's evidence boundary.
    if (!branch.some((entry) => entry.id === coverage.coverageEndEntryId)) return;
    if (!coverageIsUnchanged(branch, coverage)) return;
    const beforeMessages = event.context.contextMessages;
    const before = beforeMessages.filter((message) => message.role !== "system");
    const built = buildWorkingContext({
      checkpoint: { summary: result.summary, coverage }, branch, messages: before,
      minimumRecentTurns: recentTurns,
      retainedAnchor: result.firstKeptEntryId,
    });
    if (isWorkingContextSkipped(built)) return;
    const firstKeptEntryId = built.plan.swapStartEntryId;
    const candidate = projectCheckpoint(branch, result.summary, firstKeptEntryId, 0);
    // Compare canonical context, not the request-local context already served.
    if (hasOrphanedToolResult(candidate) || estimatedTokens(candidate) >= estimatedTokens(before)) return;
    // Pi's projector must produce precisely the proved summary + suffix.
    if (JSON.stringify(candidate.slice(1)) !== JSON.stringify(built.messages.slice(1))) return;
    traceEvent("checkpoint_install_proposed", { checkpointId: result.checkpointId, firstKeptEntryId, overlapStart: result.firstKeptEntryId, coverageEnd: coverage.coverageEndEntryId });
    return { entries: [{
      type: "compaction", summary: result.summary, firstKeptEntryId, usage: result.usage,
      details: { ...result.details, shadowCheckpoint: { checkpointId: result.checkpointId, coverage, retainedAnchor: result.firstKeptEntryId } },
    }] };
  };

  pi.on("session_start", (_event, ctx) => {
    state.reset();
    configPromise = undefined;
    reportedError = undefined;
    configErrorReported = false;
    nativeMode = "none";
    turnCount = 0;
    restorePersistedCheckpoint(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!isObserveMode()) observeInstalledCheckpoint(ctx);
    turnCount += 1;
    const triggerBranch = ctx.sessionManager.getBranch().slice();
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    // swapCount / firstSwapTurn / postSwapModelTurns make the useful served
    // checkpoint rate directly readable per trial: the last turn_usage row
    // says whether the checkpoint served at all and with how much exposure.
    const firstSwapTurn = state.firstSwapTurn;
    traceEvent("turn_usage", {
      turn: turnCount,
      generation: state.generation,
      phase: state.phase,
      contextTokens: usage?.tokens ?? null,
      contextPercent: percent ?? null,
      published: Boolean(state.published),
      publishedSwapped: state.publishedSwapped,
      swapCount: state.swapCount,
      ...(firstSwapTurn !== undefined
        ? { firstSwapTurn, postSwapModelTurns: turnCount - firstSwapTurn }
        : {}),
      preparing: Boolean(state.preparing),
      refreshArmed: state.refreshArmed,
    });
    // Observe-only instrumented control: the turn_usage series above is the
    // whole point; summaries, swaps, and compactions stay disabled.
    if (isObserveMode()) return;
    const config = await configFor(ctx).catch((error: unknown) => {
      configErrorReported = true;
      reportError(ctx, error);
      return undefined;
    });
    const installation = installAtBoundary(event, ctx, config?.recentTurns ?? DEFAULT_RECENT_TURNS);
    if (installation) return installation;
    if ((percent === null || percent === undefined) && typeof usage?.tokens !== "number") return;
    const nativeThreshold =
      config?.nativeFallbackThresholdPercent ?? DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT;

    // Never invoke manual compaction here. A ready checkpoint can install
    // through the boundary draft above; otherwise this event only prepares.
    // Single-shot mode keeps one checkpoint per run: while anything is
    // published, no refresh starts (rolling replaces it instead).
    if (!isRollingEnabled() && state.published) return;

    dropStalePublishedCheckpoint(ctx);

    if (
      isRollingEnabled() &&
      config &&
      isBelowPrepare({ tokens: usage?.tokens, percent }, config) &&
      state.published &&
      state.publishedSwapped
    ) {
      // The served checkpoint demonstrably shrank the working set: the swap
      // fired and context is back below the prepare threshold. Re-arm for
      // the next crossing.
      if (state.rearm()) {
        traceEvent("checkpoint_rearmed", {
          turn: turnCount,
          generation: state.generation,
          contextTokens: usage?.tokens ?? null,
          contextPercent: percent,
          firstKeptEntryId: state.published.firstKeptEntryId,
        });
      }
    }

    // Emergency hatch: near the provider limit, abort any replacement
    // preparation and compact once at the next safe idle point. A published
    // checkpoint keeps serving meanwhile. Queued as an emergency fallback
    // so the idle point rechecks the spike first.
    if (percent !== null && percent !== undefined && percent >= nativeThreshold) {
      if (state.requestNativeFallback("emergency")) {
        traceEvent("native_fallback", {
          turn: turnCount,
          generation: state.generation,
          reason: "emergency",
          contextTokens: usage?.tokens ?? null,
          contextPercent: percent,
        });
        ctx.ui.notify(
          `shadow-compact: ${Math.round(percent)}% context - native compaction queued until idle`,
          "info",
        );
      }
      return;
    }

    if (state.preparing) return;

    // A queued native fallback owns the next idle point: never start another
    // background preparation on top of it.
    if (state.pendingNativeFallback) return;

    // An empty-snapshot suppression retries once the working set grew
    // meaningfully past the suppression point — not on every turn, and never
    // while a preparation is in flight (startPreparing clears it anyway).
    // Evaluated below the trigger too: the gate only matters at the next
    // crossing.
    if (
      config &&
      !state.refreshArmed &&
      state.emptySuppressedAtTokens !== undefined &&
      typeof usage?.tokens === "number"
    ) {
      // Heuristic growth scale (~2k tokens per retained turn): the exact
      // number only sets how patient the suppression is.
      if (state.rearmAfterGrowth(usage.tokens, config.recentTurns * 2000)) {
        traceEvent("checkpoint_rearmed", {
          turn: turnCount,
          generation: state.generation,
          reason: "growth-after-empty",
          contextTokens: usage.tokens,
          contextPercent: percent,
        });
      }
    }

    if (!config || isBelowPrepare({ tokens: usage?.tokens, percent }, config)) {
      return;
    }

    requestCheckpoint(ctx, config, triggerBranch, "threshold", undefined, event.messageEntryId);
  });

  // Idle compaction: once the agent settles with enough context to matter,
  // ensure a fresh extension checkpoint exists; it activates for the next
  // context request. Freshness is coverage-anchored (leaf vs coverage end),
  // and the shared refresh gate keeps consecutive settles from churning.
  const maybeIdleCompact = (ctx: ExtensionContext, config: ShadowCompactConfig | undefined): void => {
    if (!config?.idleCompact.enabled) return;
    if (!ctx.isIdle()) return;
    if (state.preparing || state.pendingNativeFallback) return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (typeof tokens !== "number" || tokens < config.idleCompact.minimumTokens) return;
    dropStalePublishedCheckpoint(ctx);
    const published = state.published;
    if (published) {
      const branch = ctx.sessionManager.getBranch();
      const leafId = ctx.sessionManager.getLeafId() ?? branch[branch.length - 1]?.id;
      if (published.coverage.coverageEndEntryId === leafId) return;
    }
    requestCheckpoint(ctx, config, ctx.sessionManager.getBranch(), "idle");
  };

  pi.on("agent_before_settle", async (event, ctx) => {
    if (isObserveMode()) return;
    const config = await configFor(ctx).catch(() => undefined);
    return installAtBoundary(event, ctx, config?.recentTurns ?? DEFAULT_RECENT_TURNS);
  });

  pi.on("turn_start", (_event, ctx) => {
    if (isObserveMode()) return;
    observeInstalledCheckpoint(ctx);
    dropStalePublishedCheckpoint(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (isObserveMode()) return;
    observeInstalledCheckpoint(ctx);
    // A broken config must not block the idle path: fall back to the default
    // emergency threshold for the staleness recheck (turn_end already reports it).
    const config = await configFor(ctx).catch(() => undefined);
    settle(ctx, true, config?.nativeFallbackThresholdPercent ?? DEFAULT_NATIVE_FALLBACK_THRESHOLD_PERCENT);
    maybeIdleCompact(ctx, config);
  });

  pi.on("context", async (event, ctx) => {
    if (isObserveMode()) return undefined;
    observeInstalledCheckpoint(ctx);
    dropStalePublishedCheckpoint(ctx);
    const config = await configFor(ctx).catch(() => undefined);
    return swapSummaryIntoContext(ctx, event, config);
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    const attemptId = randomUUID();
    let sessionId: string | null = null;
    let route = "entered";
    let ownedPreparation = false;
    const requestedNative = nativeMode;
    const trigger = requestedNative === "fallback" ? "emergency" : requestedNative === "escape" ? "escape" : event.reason;
    const recordRoute = (selected: string): void => {
      route = selected;
      compactTrace = { attemptId, sessionId, route };
      traceEvent("compaction_route", { capability: COMPACTION_CAPABILITY, attemptId, sessionId, reason: event.reason, trigger, route });
    };
    // Diagnostics and notification failures must never release an owned request
    // to Pi's ignored-hook-exception fall-through.
    const notify = (message: string): void => {
      try { ctx.ui.notify(message, "warning"); }
      catch { traceEvent("compaction_outcome", { attemptId, sessionId, stage: "notification", outcome: "failed" }); }
    };
    recordRoute("entered");
    try {
      sessionId = ctx.sessionManager.getSessionId();
      if (isObserveMode()) { recordRoute("observe"); return; }
      if (requestedNative === "escape") {
        // Escape is single-shot; fallback stays armed until an outcome event.
        nativeMode = "none";
        recordRoute("pure-native");
        notify("shadow-compact: pure Pi compaction; token-cap recovery is disabled");
        return;
      }
      const config = await configFor(ctx).catch(() => undefined);
      if (!config) {
        recordRoute("invalid-config");
        notify("shadow-compact: configuration unavailable; using pure Pi compaction without token-cap recovery");
        return;
      }
      if (!ctx.model || ctx.model.api === "pi-virtual") {
        recordRoute(ctx.model ? "virtual-model" : "no-model");
        return;
      }
      const nativeCompaction = async (): Promise<SessionBeforeCompactResult | undefined> => {
        if (!event.preparation.messagesToSummarize.length && !event.preparation.turnPrefixMessages.length) {
          recordRoute("no-evidence");
          return;
        }
        recordRoute("wrapped-native");
        const compaction = await compactWithRecovery(ctx, event, config, attemptId);
        traceEvent("compaction_outcome", { attemptId, sessionId, route, outcome: "ready", summaryChars: compaction?.summary.length ?? 0 });
        return compaction ? { compaction } : undefined;
      };
      const servedResult = (served: SessionBeforeCompactResult): SessionBeforeCompactResult => {
        recordRoute("checkpoint");
        traceEvent("compaction_outcome", { attemptId, sessionId, route, outcome: "ready", summaryChars: served.compaction?.summary.length ?? 0 });
        return served;
      };
      if (requestedNative !== "none" || (event.reason === "manual" && config.manualCompactMode === "native")) {
        state.abortPreparing();
        return await nativeCompaction();
      }
      const recentTurns = config.recentTurns;
      const messagesBefore = workingMessagesBeforeCompaction(ctx, recentTurns);
      const published = state.published;
      if (published && resultIsCurrent(ctx, published)) {
        if (coversCompactionPrefix(ctx, published, event.preparation.firstKeptEntryId)) {
          const served = serveCompaction(ctx, event, published, messagesBefore);
          return served ? servedResult(served) : await nativeCompaction();
        }
        traceEvent("compaction_fallback", { reason: "uncovered-prefix", firstKeptEntryId: event.preparation.firstKeptEntryId, coverageEnd: published.coverage?.coverageEndEntryId ?? null });
      }

      // Manual /compact with nothing ready: Shadow becomes the compaction
      // provider. Prepare fresh, await it (a hook signal abort cancels the
      // preparation), and serve the result; on failure fall through to native.
      if (event.reason === "manual") {
        recordRoute("preparing");
        ctx.ui.notify(MANUAL_PREPARE_MESSAGE, "info");
        state.abortPreparing();
        const prepared = state.startPreparing();
        if (!prepared) return await nativeCompaction();
        ownedPreparation = true;
        const branch = ctx.sessionManager.getBranch();
        traceEvent("threshold_crossed", {
          turn: turnCount,
          generation: prepared.generation,
          action: "started",
          reason: "manual",
          contextTokens: ctx.getContextUsage()?.tokens ?? null,
          contextPercent: ctx.getContextUsage()?.percent ?? null,
          prepareThreshold: config.prepareThresholdPercent,
          prepareThresholdTokens: config.softCompactThresholdTokens ?? null,
        });
        traceEvent("prepare_started", {
          turn: turnCount,
          generation: prepared.generation,
          reason: "manual",
          contextTokens: ctx.getContextUsage()?.tokens ?? null,
          contextPercent: ctx.getContextUsage()?.percent ?? null,
          prepareThreshold: config.prepareThresholdPercent,
          prepareThresholdTokens: config.softCompactThresholdTokens ?? null,
          branchEntries: branch.length,
          leafId: ctx.sessionManager.getLeafId() ?? null,
        });
        // A hook abort releases the preparation like a takeover: the aborted
        // completion no-ops on its stale generation instead of failing.
        const onAbort = (): void => {
          state.abortPreparing();
        };
        event.signal.addEventListener("abort", onAbort, { once: true });
        try {
          await prepare(ctx, config, branch.slice(), prepared.controller, prepared.generation, undefined, event.customInstructions, attemptId);
        } finally {
          event.signal.removeEventListener("abort", onAbort);
        }
        ownedPreparation = false;
        const fresh = state.published;
        if (fresh && resultIsCurrent(ctx, fresh)) {
          const served = serveCompaction(ctx, event, fresh, messagesBefore);
          return served ? servedResult(served) : await nativeCompaction();
        }
        return await nativeCompaction();
      }

      // A native compaction moots the preparation, but keep a valid serving
      // checkpoint until success: failure does not change compaction ancestry.
      state.abortPreparing();
      return await nativeCompaction();
    } catch (error) {
      if (ownedPreparation) state.abortPreparing();
      traceEvent("compaction_outcome", { attemptId, sessionId, route, outcome: event.signal.aborted ? "cancelled" : "failed" });
      try {
        if (!event.signal.aborted && !isContextStale(ctx)) reportError(ctx, error);
      } catch {
        traceEvent("compaction_outcome", { attemptId, sessionId, stage: "notification", outcome: "failed" });
      }
      return { cancel: true };
    }
  });

  // Every successful compaction changes ancestry, regardless of its source.
  // Failure only releases the native escape/fallback markers; the old working
  // checkpoint remains valid and can keep serving.
  const clearNativeCompactMarkers = (): void => {
    nativeMode = "none";
  };
  pi.on("session_compact", () => {
    traceEvent("compaction_outcome", { ...compactTrace, outcome: "installed" });
    compactTrace = undefined;
    clearNativeCompactMarkers();
    state.reset();
  });
  pi.on("session_compact_failed", (event) => {
    traceEvent("compaction_outcome", { ...compactTrace, outcome: event.aborted ? "cancelled" : "failed" });
    compactTrace = undefined;
    const hadNativeFallback = nativeMode === "fallback";
    clearNativeCompactMarkers();
    // The emergency hatch aborted a prepare. With nothing left to serve,
    // failure must release its disarmed refresh gate for a later attempt.
    if (hadNativeFallback && !state.published) state.reset();
  });
  pi.on("session_tree", () => {
    compactTrace = undefined;
    clearNativeCompactMarkers();
    state.reset();
  });
  pi.on("session_shutdown", () => {
    compactTrace = undefined;
    clearNativeCompactMarkers();
    state.reset();
  });
}

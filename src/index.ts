import {
  getAgentDir,
  SettingsManager,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
  isBelowSoft,
  isObserveMode,
  isRollingEnabled,
  loadConfig,
  resolveKeepRecentTokens,
  type ShadowCompactConfig,
} from "./config.js";
import { normalizeSnapshot, tokensToChars } from "./normalize.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  findLatestRestorableCheckpoint,
  latestCompactionId,
  toPreparedResult,
  type PersistedShadowCheckpoint,
} from "./persist.js";
import { prepareSnapshot } from "./prepare.js";
import { contextSwapDropCount, hasOrphanedToolResult } from "./swap.js";
import { ShadowCompactStateController, type PreparedResult } from "./state.js";
import {
  combineUsage,
  isActionFirstEnabled,
  resolveSummarizerModel,
  resolveVerificationModel,
  runSummaryAgent,
  runVerificationAgent,
} from "./summary.js";
import { traceEvent } from "./trace.js";
import { randomUUID } from "node:crypto";

const READY_MESSAGE = "shadow-compact: summary ready - swaps in at the next turn";
const DEFERRED_MESSAGE =
  "shadow-compact: summary still preparing - swap deferred until the agent is idle";

function isValidBranchAncestry(branch: SessionEntry[], result: PreparedResult): boolean {
  return (
    branch.some((entry) => entry.id === result.leafId) &&
    branch.some((entry) => entry.id === result.firstKeptEntryId)
  );
}

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
  let nativeFallbackInFlight = false;
  let turnCount = 0;

  const runNativeFallback = (ctx: ExtensionContext): boolean => {
    // Manual compaction aborts an active agent run, so only start it while Pi is idle.
    if (nativeFallbackInFlight || !ctx.isIdle()) return false;
    nativeFallbackInFlight = true;
    ctx.compact({});
    return true;
  };

  // Shared durability path: a published, still-current checkpoint is appended
  // as extension state (a CustomEntry, invisible to the model) once the agent
  // is idle. Raw history stays on the branch; the serving checkpoint keeps
  // swapping while and after it lands. There is no callback that must survive
  // a session replacement, and no native compaction on the soft path.
  const persistReadyCheckpoint = (ctx: ExtensionContext): void => {
    if (!ctx.isIdle()) return;
    const result = state.published;
    if (!result) return;
    if (!resultIsCurrent(ctx, result)) {
      // A native compaction landed under the checkpoint (or the branch moved
      // on): drop the projection and re-arm so the next crossing prepares
      // fresh. Validation on restore rejects the persisted twin the same way.
      state.discardPublished();
      return;
    }
    if (result.checkpointId === state.persistedCheckpointId) return;
    const checkpoint: PersistedShadowCheckpoint = {
      version: 1,
      checkpointId: result.checkpointId,
      sessionId: result.sessionId,
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      leafId: result.leafId,
      latestCompactionId: result.latestCompactionId,
      contextTokensBefore: result.contextTokensBefore ?? 0,
      usage: result.usage,
      details: result.details,
      createdAt: Date.now(),
    };
    try {
      pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, checkpoint);
    } catch (error) {
      // An append can fail when the idle point races teardown. The checkpoint
      // keeps serving and the next settle retries; nothing crashes the agent.
      traceEvent("checkpoint_persisted", {
        turn: turnCount,
        generation: state.generation,
        action: "failed",
        checkpointId: result.checkpointId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    state.markPersisted(result.checkpointId);
    traceEvent("checkpoint_persisted", {
      turn: turnCount,
      generation: state.generation,
      checkpointId: result.checkpointId,
      firstKeptEntryId: result.firstKeptEntryId,
      leafId: result.leafId,
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
    state.restorePublished(toPreparedResult(found.checkpoint));
    traceEvent("checkpoint_restored", {
      checkpointId: found.checkpoint.checkpointId,
      firstKeptEntryId: found.checkpoint.firstKeptEntryId,
      leafId: found.checkpoint.leafId,
      summaryChars: found.checkpoint.summary.length,
    });
  };

  // Idle-point actions shared by agent_settled and post-settle preparation outcomes.
  // A failure-queued fallback always compacts: with nothing serving it is the
  // only safe recovery. A hard-threshold-queued fallback recompacts only while
  // the spike is still present: context may have recovered while the run
  // drained, and a stale hatch must not compact a healthy working set.
  const settle = (ctx: ExtensionContext, deferredNotice: boolean, hardThreshold?: number): void => {
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
      if (pendingReason === "hard-threshold" && hardThreshold !== undefined) {
        const idleUsage = ctx.getContextUsage();
        const idlePercent = idleUsage?.percent;
        if (idlePercent !== undefined && idlePercent !== null && idlePercent < hardThreshold) {
          traceEvent("native_fallback", {
            turn: turnCount,
            generation: state.generation,
            reason: "hard-threshold",
            action: "skipped-recovered",
            contextTokens: idleUsage?.tokens ?? null,
            contextPercent: idlePercent,
          });
          persistReadyCheckpoint(ctx);
          return;
        }
      }
      if (!runNativeFallback(ctx)) state.requestNativeFallback(pendingReason);
      return;
    }
    persistReadyCheckpoint(ctx);
  };

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
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
      settle(ctx, false, config.hardCompactThresholdPercent);
    };
    try {
      // Shadow owns its cut boundary: the experimental tail knob keeps roughly
      // that share of the context window as verbatim history, capped at Pi's
      // keepRecentTokens so unset/oversized targets change nothing.
      const contextUsage = ctx.getContextUsage();
      const tokensAtStart = contextUsage?.tokens ?? undefined;
      const piKeepRecentTokens = SettingsManager.create(ctx.cwd, getAgentDir())
        .getCompactionSettings().keepRecentTokens;
      const keepRecentTokens = resolveKeepRecentTokens(
        piKeepRecentTokens,
        config.targetTailPercent,
        contextUsage?.contextWindow,
      );
      const snapshot = prepareSnapshot(branch, keepRecentTokens, {
        sessionId: ctx.sessionManager.getSessionId(),
      });
      // "Nothing to summarize" at the soft boundary is not a failure: there is
      // not yet enough disposable history under this cut policy. Suppress
      // without queuing a native fallback instead of churning every turn; the
      // recorded size re-arms once the working set grows meaningfully.
      if (!snapshot) {
        if (state.skipPreparation(generation, tokensAtStart)) {
          traceEvent("prepare_failed", {
            turn: turnCount,
            generation,
            reason: "empty-snapshot",
            action: "suppressed-until-growth",
            branchEntries: branch.length,
          });
        }
        // A preparation can finish after the settle point it missed; act now if idle.
        settle(ctx, false, config.hardCompactThresholdPercent);
        return;
      }

      const model = resolveSummarizerModel(ctx, config);
      // An explicit override remains available, but the default request uses the
      // model/provider output limit instead of imposing Shadow's old 4096-token cap.
      const maxTokens = config.summaryMaxTokens;
      // The override decouples the summarizer budget from models.json: Pi keeps its own
      // context accounting while the summary request uses the deployment's real capacity.
      const contextWindow = config.summarizerContextTokens ?? model.contextWindow;
      // Budget against the output capacity even when no request cap is sent. This keeps
      // enough context available for generation while allowing the provider to use the
      // model's full registered output limit.
      const outputBudget = maxTokens ?? model.maxTokens;
      const reservedTokens = Math.min(
        outputBudget * 2 + 8192,
        Math.floor(contextWindow / 2),
      );
      // Unit fix: context windows and reservations are tokens, but the
      // normalized packet is measured in JSON characters. Passing tokens
      // straight through capped evidence at ~1/4 of the intended budget
      // (e.g. 183,616 tokens of budget became 183,616 characters).
      const budgetChars = tokensToChars(contextWindow - reservedTokens);
      const packet = normalizeSnapshot(
        {
          cwd: ctx.cwd,
          ...(snapshot.previousSummary === undefined ? {} : { previousSummary: snapshot.previousSummary }),
          ...(snapshot.shadowSummaries.length > 0 ? { shadowSummaries: snapshot.shadowSummaries } : {}),
          entries: [...snapshot.sourceEntries, ...snapshot.turnPrefixEntries],
        },
        budgetChars,
      );
      if (packet.evidence.length === 0) throw new Error("No evidence is available to summarize");
      const packetChars = JSON.stringify(packet).length;
      const sourceEntries = snapshot.sourceEntries.length + snapshot.turnPrefixEntries.length;

      const outcome = await runSummaryAgent(ctx, packet, config, {
        signal: controller.signal,
        model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      });
      if (bailIfStale()) return;
      const summaryWallMs = Date.now() - startedWallMs;

      // Second-pass verification gate: the draft is audited against the same
      // evidence packet before anything is published. A verifier failure
      // throws into the shared catch below, which fails closed (keeps the
      // serving checkpoint, or queues one native fallback with nothing
      // serving) instead of publishing an untrusted checkpoint.
      const verifierModel = resolveVerificationModel(ctx, config);
      const verifierThinking = config.verificationThinkingLevel ?? config.thinkingLevel;
      const verifierStartedWallMs = Date.now();
      const verified = await runVerificationAgent(ctx, packet, outcome.checkpoint, config, {
        signal: controller.signal,
        model: verifierModel,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(verifierThinking ? { thinkingLevel: verifierThinking } : {}),
      });
      if (bailIfStale()) return;
      const verifierWallMs = Date.now() - verifierStartedWallMs;
      const usage = combineUsage(outcome.usage, verified.usage);

      const current = ctx.sessionManager.getBranch();
      const result: PreparedResult = {
        checkpointId: randomUUID(),
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId() ?? (current[current.length - 1]?.id ?? ""),
        latestCompactionId: snapshot.latestCompactionId,
        firstKeptEntryId: snapshot.firstKeptEntryId,
        summary: verified.summary,
        usage,
        details: {
          readFiles: snapshot.readFiles,
          modifiedFiles: snapshot.modifiedFiles,
        },
        contextTokensBefore: ctx.getContextUsage()?.tokens ?? 0,
      };
      traceEvent("prepare_completed", {
        turn: turnCount,
        generation,
        summaryChars: verified.summary.length,
        summaryInput: outcome.usage.input,
        summaryOutput: outcome.usage.output,
        summaryCacheRead: outcome.usage.cacheRead,
        summaryCacheWrite: outcome.usage.cacheWrite,
        summaryModel: `${model.provider}/${model.id}`,
        summaryThinking: config.thinkingLevel ?? null,
        verifierInput: verified.usage.input,
        verifierOutput: verified.usage.output,
        verifierCacheRead: verified.usage.cacheRead,
        verifierCacheWrite: verified.usage.cacheWrite,
        verifierModel: `${verifierModel.provider}/${verifierModel.id}`,
        verifierThinking: verifierThinking ?? null,
        verifierWallMs,
        renderOrder: isActionFirstEnabled() ? "action-first" : "legacy",
        summaryWallMs,
        packetChars,
        sourceEntries,
        packetRawEvidence: packet.rawEvidenceCount,
        packetEvidence: packet.normalizedEvidenceCount,
        packetEvicted: packet.evictedEvidenceCount,
        packetTruncated: packet.packetTruncated,
        packetOverflow: packet.overflow.length,
        packetTruncatedItems: packet.truncatedItemCount,
        packetManifestChars: packet.manifest.length,
        packetManifestOmitted: packet.manifestOmitted,
        shadowChain: snapshot.shadowSummaries.length,
        summaryRetrievals: outcome.retrievalRounds,
        verifierRetrievals: verified.retrievalRounds,
        packetOldestRetained: packet.oldestRetainedSourceEntryId,
        packetNewestRetained: packet.newestRetainedSourceEntryId,
        firstKeptEntryId: snapshot.firstKeptEntryId,
        leafId: result.leafId,
      });
      const valid =
        ctx.sessionManager.getSessionId() === result.sessionId &&
        isValidBranchAncestry(current, result) &&
        latestCompactionId(current) === result.latestCompactionId;
      // Ownership-checked: a superseded completion no-ops instead of aborting a newer prepare.
      const replaced = Boolean(state.published);
      if (!valid || !state.publish(generation, result)) {
        failPrepare(valid ? "superseded" : "stale-branch", { firstKeptEntryId: result.firstKeptEntryId });
        return;
      }
      traceEvent("checkpoint_published", {
        turn: turnCount,
        generation,
        firstKeptEntryId: result.firstKeptEntryId,
        leafId: result.leafId,
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
      if (!controller.signal.aborted) reportError(ctx, error);
      else {
        traceEvent("prepare_failed", {
          turn: turnCount,
          generation,
          reason: "aborted",
        });
      }
      state.fail(generation);
      settle(ctx, false, config.hardCompactThresholdPercent);
    }
  };

  const resultIsCurrent = (ctx: ExtensionContext, result: PreparedResult): boolean =>
    ctx.sessionManager.getSessionId() === result.sessionId &&
    isValidBranchAncestry(ctx.sessionManager.getBranch(), result) &&
    latestCompactionId(ctx.sessionManager.getBranch()) === result.latestCompactionId;

  const earliestCut = (ctx: ExtensionContext, ours: string, theirs: string): string => {
    const branch = ctx.sessionManager.getBranch();
    const ourIndex = branch.findIndex((entry) => entry.id === ours);
    const theirIndex = branch.findIndex((entry) => entry.id === theirs);
    if (ourIndex < 0) return theirs;
    if (theirIndex < 0) return ours;
    return ourIndex <= theirIndex ? ours : theirs;
  };

  // Mid-run swap: a published, current summary replaces the stale prefix in the
  // next request. This touches only the request's message list, so the agent run
  // never aborts. Durability lands separately as a CustomEntry at idle; the
  // serving checkpoint keeps swapping before and after it lands, and while its
  // replacement prepares; publishing the replacement swaps future requests to it.
  const swapSummaryIntoContext = (ctx: ExtensionContext, event: ContextEvent) => {
    const result = state.published;
    if (!result) return undefined;
    if (!resultIsCurrent(ctx, result)) return undefined;
    const drop = contextSwapDropCount(
      ctx.sessionManager.getBranch(),
      result.firstKeptEntryId,
    );
    if (drop === undefined || drop > event.messages.length) return undefined;
    const kept = event.messages.slice(drop);
    if (kept.length === 0) return undefined;
    // Fail closed: a kept tool result without its tool call is a transcript
    // the provider rejects outright. Skip the swap for this request instead
    // of serving it; Pi sends the full context and the checkpoint stays armed.
    if (hasOrphanedToolResult(kept)) {
      traceEvent("swap_applied", {
        turn: turnCount,
        generation: state.generation,
        action: "skipped-orphan",
        messagesBefore: event.messages.length,
        messagesDropped: drop,
        firstKeptEntryId: result.firstKeptEntryId,
        leafId: result.leafId,
      });
      return undefined;
    }
    const firstSwap = state.markSwapped(turnCount);
    const usage = ctx.getContextUsage();
    traceEvent("swap_applied", {
      turn: turnCount,
      generation: state.generation,
      firstSwap,
      swapCount: state.swapCount,
      messagesBefore: event.messages.length,
      messagesAfter: kept.length + 1,
      messagesDropped: drop,
      contextTokensBefore: result.contextTokensBefore ?? null,
      contextTokensAtSwap: usage?.tokens ?? null,
      contextPercentAtSwap: usage?.percent ?? null,
      firstKeptEntryId: result.firstKeptEntryId,
      leafId: result.leafId,
    });
    const summaryMessage = {
      role: "compactionSummary" as const,
      summary: result.summary,
      tokensBefore: result.contextTokensBefore ?? 0,
      timestamp: Date.now(),
    };
    const messages: ContextEvent["messages"] = [summaryMessage, ...kept];
    return { messages };
  };

  pi.on("session_start", (_event, ctx) => {
    state.reset();
    configPromise = undefined;
    reportedError = undefined;
    configErrorReported = false;
    nativeFallbackInFlight = false;
    turnCount = 0;
    restorePersistedCheckpoint(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    turnCount += 1;
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
    // Without any size signal there is nothing to compare against the soft
    // trigger (percent or absolute tokens).
    if ((percent === null || percent === undefined) && typeof usage?.tokens !== "number") return;

    const config = await configFor(ctx).catch((error: unknown) => {
      configErrorReported = true;
      reportError(ctx, error);
      return undefined;
    });
    const hardThreshold =
      config?.hardCompactThresholdPercent ?? DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT;
    const softThreshold = config?.softCompactThresholdPercent;
    const softThresholdTokens = config?.softCompactThresholdTokens;

    // ctx.compact() is a manual compaction and aborts an active agent run, so
    // this event only prepares. The context event swaps mid-run; agent_settled
    // and the ready completion persist the CustomEntry checkpoint while idle.
    // Single-shot mode keeps one checkpoint per run: while anything is
    // published, no refresh starts (rolling replaces it instead).
    if (!isRollingEnabled() && state.published) return;

    if (
      isRollingEnabled() &&
      config &&
      isBelowSoft({ tokens: usage?.tokens, percent }, config) &&
      state.published &&
      state.publishedSwapped
    ) {
      // The served checkpoint demonstrably shrank the working set: the swap
      // fired and context is back below soft. Re-arm for the next crossing.
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

    // No absolute hard-token knob yet (fix.md): the deadline hatch stays
    // percent-only and is skipped when the runtime reports no percent.
    if (percent !== null && percent !== undefined && percent >= hardThreshold) {
      // Deadline hatch: abort any replacement preparation and compact at the
      // next safe idle point. A published checkpoint keeps serving meanwhile —
      // a stale but valid checkpoint must not disable the emergency path when
      // the served working set is already too large despite it. Queued as a
      // hard-threshold fallback so the idle point rechecks the spike first.
      if (state.requestNativeFallback("hard-threshold")) {
        traceEvent("native_fallback", {
          turn: turnCount,
          generation: state.generation,
          reason: "hard-threshold",
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
    // Evaluated below soft too: the gate only matters at the next crossing.
    if (
      config &&
      !state.refreshArmed &&
      state.emptySuppressedAtTokens !== undefined &&
      typeof usage?.tokens === "number" &&
      usage?.contextWindow != null
    ) {
      const suppressedTailBudget = resolveKeepRecentTokens(
        SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings().keepRecentTokens,
        config.targetTailPercent,
        usage.contextWindow ?? undefined,
      );
      if (state.rearmAfterGrowth(usage.tokens, suppressedTailBudget)) {
        traceEvent("checkpoint_rearmed", {
          turn: turnCount,
          generation: state.generation,
          reason: "growth-after-empty",
          contextTokens: usage.tokens,
          contextPercent: percent,
        });
      }
    }

    if (!config || isBelowSoft({ tokens: usage?.tokens, percent }, config)) {
      return;
    }

    if (!state.refreshArmed) {
      // Still above soft after a refresh cycle without an observed swap + shrink:
      // the checkpoint/tail policy is not achieving the target. Log, don't spin.
      traceEvent("threshold_crossed", {
        turn: turnCount,
        generation: state.generation,
        action: "suppressed",
        contextTokens: usage?.tokens ?? null,
        contextPercent: percent,
        softThreshold,
        softThresholdTokens: softThresholdTokens ?? null,
      });
      return;
    }

    const prepared = state.startPreparing();
    if (!prepared) return;
    const branch = ctx.sessionManager.getBranch();
    traceEvent("threshold_crossed", {
      turn: turnCount,
      generation: prepared.generation,
      action: "started",
      contextTokens: usage?.tokens ?? null,
      contextPercent: percent,
      softThreshold,
      softThresholdTokens: softThresholdTokens ?? null,
    });
    traceEvent("prepare_started", {
      turn: turnCount,
      generation: prepared.generation,
      contextTokens: usage?.tokens ?? null,
      contextPercent: percent,
      softThreshold,
      softThresholdTokens: softThresholdTokens ?? null,
      branchEntries: branch.length,
      leafId: ctx.sessionManager.getLeafId() ?? null,
    });
    // Fire and forget: the live agent run continues immediately.
    void prepare(ctx, config, branch, prepared.controller, prepared.generation);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (isObserveMode()) return;
    // A broken config must not block the idle path: fall back to the default
    // hard threshold for the staleness recheck (turn_end already reports it).
    const config = await configFor(ctx).catch(() => undefined);
    settle(ctx, true, config?.hardCompactThresholdPercent ?? DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT);
  });

  pi.on("context", (event, ctx) => {
    if (isObserveMode()) return undefined;
    return swapSummaryIntoContext(ctx, event);
  });

  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx) => {
    if (isObserveMode()) return;
    // Shadow never compacts proactively; but when Pi compacts natively anyway
    // (hard hatch, overflow), the verified checkpoint covers strictly more
    // than a fresh native summary: it was audited against the raw history.
    // Offer it whenever it is still current, even when Pi's cut lands
    // elsewhere — the hook's summary and cut are honored verbatim, so a
    // boundary mismatch no longer silently supersedes Shadow coverage.
    const published = state.published;
    if (event.reason !== "manual" && published && resultIsCurrent(ctx, published)) {
      const exact = published.firstKeptEntryId === event.preparation.firstKeptEntryId;
      // On a mismatch keep whichever cut drops less: the earliest cut on the
      // branch. Shadow's summary covers everything before its own cut, so an
      // earlier cut only overlaps verbatim context — coverage is never lost
      // from either side.
      const firstKeptEntryId = exact
        ? published.firstKeptEntryId
        : earliestCut(ctx, published.firstKeptEntryId, event.preparation.firstKeptEntryId);
      return {
        compaction: {
          summary: published.summary,
          firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: published.usage,
          details: published.details,
        },
      };
    }

    // Manual compaction invalidates the cached checkpoint in any phase. A threshold
    // boundary mismatch leaves the cache intact for a later matching request.
    if (event.reason === "manual" || state.preparing) state.reset();
    return;
  });

  // Native compaction (or its failure) observed after the fact carries no
  // usable checkpoint either way: clear any in-flight fallback marker, and
  // drop the serving checkpoint only when the compaction came from us.
  const handleNativeCompactEvent = (event: { fromExtension: boolean }): void => {
    nativeFallbackInFlight = false;
    if (event.fromExtension) state.reset();
  };
  pi.on("session_compact", handleNativeCompactEvent);
  pi.on("session_compact_failed", handleNativeCompactEvent);
  pi.on("session_tree", () => {
    nativeFallbackInFlight = false;
    state.reset();
  });
  pi.on("session_shutdown", () => {
    nativeFallbackInFlight = false;
    state.reset();
  });
}

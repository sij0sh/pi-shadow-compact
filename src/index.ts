import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT,
  loadConfig,
  type ShadowCompactConfig,
} from "./config.js";
import { normalizeSnapshot } from "./normalize.js";
import { prepareSnapshot } from "./prepare.js";
import { ShadowCompactStateController, type PreparedResult } from "./state.js";
import {
  SUMMARY_MAX_TOKENS,
  resolveSummarizerModel,
  runSummaryAgent,
} from "./summary.js";
import { randomUUID } from "node:crypto";

const COMMIT_NONCE_PREFIX = "[shadow-compact:commit:";
const READY_MESSAGE = "shadow-compact: summary ready - will swap in when the agent is idle";
const DEFERRED_MESSAGE =
  "shadow-compact: summary still preparing - swap deferred until the agent is idle";

function isCommitNonce(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(COMMIT_NONCE_PREFIX) && value.endsWith("]");
}

function isValidBranchAncestry(branch: SessionEntry[], result: PreparedResult): boolean {
  return (
    branch.some((entry) => entry.id === result.leafId) &&
    branch.some((entry) => entry.id === result.firstKeptEntryId)
  );
}

export default function shadowCompact(pi: ExtensionAPI): void {
  const state = new ShadowCompactStateController();
  let configPromise: Promise<ShadowCompactConfig> | undefined;
  let reportedError: string | undefined;
  let configErrorReported = false;
  let nativeFallbackInFlight = false;

  const runNativeFallback = (ctx: ExtensionContext): boolean => {
    // Manual compaction aborts an active agent run, so only start it while Pi is idle.
    if (nativeFallbackInFlight || !ctx.isIdle()) return false;
    nativeFallbackInFlight = true;
    ctx.compact({});
    return true;
  };

  // Shared commit path: a ready, still-current result swaps in via the nonce compaction.
  const commitReadySummary = (ctx: ExtensionContext): void => {
    if (!ctx.isIdle()) return;
    const current = state.current;
    if (current.phase !== "ready") return;
    if (!resultIsCurrent(ctx, current.result)) {
      state.reset();
      return;
    }
    const commit = state.beginCommit(`${COMMIT_NONCE_PREFIX}${randomUUID()}]`);
    if (!commit) return;
    ctx.compact({
      customInstructions: commit.nonce,
      onComplete: () => state.reset(),
      onError: () => {
        // The cached result failed; let Pi's native summarizer run once instead.
        state.reset();
        if (!runNativeFallback(ctx)) state.requestNativeFallback();
      },
    });
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
  ): Promise<void> => {
    const generation = state.current.generation;
    try {
      const keepRecentTokens = SettingsManager.create(ctx.cwd, getAgentDir())
        .getCompactionSettings().keepRecentTokens;
      const snapshot = prepareSnapshot(branch, keepRecentTokens);
      // "Nothing to summarize" is terminal: fail() releases the claimed phase so a
      // later turn can retry instead of latching the extension in preparing forever.
      if (!snapshot) {
        state.fail(generation);
        return;
      }

      const model = resolveSummarizerModel(ctx, config);
      const maxTokens =
        config.summaryMaxTokens ?? Math.min(SUMMARY_MAX_TOKENS, model.maxTokens ?? SUMMARY_MAX_TOKENS);
      // The override decouples the summarizer budget from models.json: Pi keeps its own
      // context accounting while the summary request uses the deployment's real capacity.
      const contextWindow = config.summarizerContextTokens ?? model.contextWindow;
      // Keep evidence usable when a large override is budgeted: never reserve more than
      // half the context window, so the input side always retains room to work with.
      const reservedTokens = Math.min(
        maxTokens * 2 + 8192,
        Math.floor(contextWindow / 2),
      );
      const budget = contextWindow - reservedTokens;
      const packet = normalizeSnapshot(
        {
          cwd: ctx.cwd,
          ...(snapshot.previousSummary === undefined ? {} : { previousSummary: snapshot.previousSummary }),
          entries: [...snapshot.sourceEntries, ...snapshot.turnPrefixEntries],
        },
        budget,
      );
      if (packet.evidence.length === 0) throw new Error("No evidence is available to summarize");

      const outcome = await runSummaryAgent(ctx, packet, config, {
        signal: controller.signal,
        model,
        maxTokens,
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      });

      const current = ctx.sessionManager.getBranch();
      const result: PreparedResult = {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId() ?? (current[current.length - 1]?.id ?? ""),
        latestCompactionId: snapshot.latestCompactionId,
        firstKeptEntryId: snapshot.firstKeptEntryId,
        summary: outcome.summary,
        usage: outcome.usage,
        details: {
          readFiles: snapshot.readFiles,
          modifiedFiles: snapshot.modifiedFiles,
        },
      };
      const valid =
        ctx.sessionManager.getSessionId() === result.sessionId &&
        isValidBranchAncestry(current, result) &&
        latestCompactionId(current) === result.latestCompactionId;
      // Ownership-checked: a superseded completion no-ops instead of aborting a newer prepare.
      if (!valid || !state.publish(generation, result)) {
        state.fail(generation);
        return;
      }
      ctx.ui.notify(READY_MESSAGE, "info");
      commitReadySummary(ctx);
    } catch (error) {
      if (!controller.signal.aborted) reportError(ctx, error);
      state.fail(generation);
    }
  };

  const resultIsCurrent = (ctx: ExtensionContext, result: PreparedResult): boolean =>
    ctx.sessionManager.getSessionId() === result.sessionId &&
    isValidBranchAncestry(ctx.sessionManager.getBranch(), result) &&
    latestCompactionId(ctx.sessionManager.getBranch()) === result.latestCompactionId;

  pi.on("session_start", () => {
    state.reset();
    configPromise = undefined;
    reportedError = undefined;
    configErrorReported = false;
    nativeFallbackInFlight = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    const percent = ctx.getContextUsage()?.percent;
    if (percent === null || percent === undefined) return;

    // ctx.compact() is a manual compaction and aborts an active agent run. This
    // event only prepares work; agent_settled performs the durable swap.
    if (state.current.phase === "ready" || state.current.phase === "committing") return;

    const config = await configFor(ctx).catch((error: unknown) => {
      configErrorReported = true;
      reportError(ctx, error);
      return undefined;
    });
    const hardThreshold =
      config?.hardCompactThresholdPercent ?? DEFAULT_HARD_COMPACT_THRESHOLD_PERCENT;
    if (percent >= hardThreshold) {
      // Deadline hatch: cancel detached work and compact at the next safe idle point.
      if (state.requestNativeFallback()) {
        ctx.ui.notify(
          `shadow-compact: ${Math.round(percent)}% context - native compaction queued until idle`,
          "info",
        );
      }
      return;
    }
    if (!config || percent < config.softCompactThresholdPercent || state.current.phase !== "idle") {
      return;
    }

    const prepared = state.startPreparing();
    if (!prepared) return;
    const branch = ctx.sessionManager.getBranch();
    // Fire and forget: the live agent run continues immediately.
    void prepare(ctx, config, branch, prepared.controller);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    if (state.clearPendingNativeFallback()) {
      if (!runNativeFallback(ctx)) state.requestNativeFallback();
      return;
    }

    if (state.current.phase === "preparing") {
      // The summary missed this idle point. Its completion commits once Pi stays idle.
      ctx.ui.notify(DEFERRED_MESSAGE, "info");
      return;
    }
    commitReadySummary(ctx);
  });

  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx) => {
    if (isCommitNonce(event.customInstructions)) {
      const current = state.current;
      if (current.phase !== "committing" || current.nonce !== event.customInstructions) return;
      return {
        compaction: {
          summary: current.result.summary,
          firstKeptEntryId: current.result.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: current.result.usage,
          details: current.result.details,
        },
      };
    }

    const current = state.current;
    if (
      event.reason !== "manual" &&
      current.phase === "ready" &&
      current.result.firstKeptEntryId === event.preparation.firstKeptEntryId &&
      resultIsCurrent(ctx, current.result)
    ) {
      return {
        compaction: {
          summary: current.result.summary,
          firstKeptEntryId: current.result.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: current.result.usage,
          details: current.result.details,
        },
      };
    }

    // Manual compaction invalidates the cached checkpoint in any phase. A threshold
    // boundary mismatch leaves the cache intact for a later matching request.
    if (event.reason === "manual" || current.phase === "preparing") state.reset();
    return;
  });

  pi.on("session_compact", (event) => {
    nativeFallbackInFlight = false;
    if (event.fromExtension) state.reset();
  });
  pi.on("session_compact_failed", (event) => {
    nativeFallbackInFlight = false;
    if (event.fromExtension) state.reset();
  });
  pi.on("session_tree", () => {
    nativeFallbackInFlight = false;
    state.reset();
  });
  pi.on("session_shutdown", () => {
    nativeFallbackInFlight = false;
    state.reset();
  });
}

function latestCompactionId(branch: SessionEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "compaction") return entry.id;
  }
  return null;
}

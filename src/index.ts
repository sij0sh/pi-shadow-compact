import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ShadowCompactConfig } from "./config.js";
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

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (reportedError === message) return;
    reportedError = message;
    ctx.ui.notify(`shadow-compact: ${message}`, "error");
  };

  const configFor = async (ctx: ExtensionContext): Promise<ShadowCompactConfig> => {
    configPromise ??= loadConfig(ctx).then((config) => {
      reportedError = undefined;
      return config;
    });
    return configPromise;
  };

  const prepare = async (
    ctx: ExtensionContext,
    config: ShadowCompactConfig,
    branch: SessionEntry[],
    controller: AbortController,
  ): Promise<void> => {
    const generation = state.current.generation;
    const keepRecentTokens = SettingsManager.create(ctx.cwd, getAgentDir())
      .getCompactionSettings().keepRecentTokens;
    const snapshot = prepareSnapshot(branch, keepRecentTokens);
    if (!snapshot) return;

    try {
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
      if (!valid || !state.publish(generation, result)) state.fail(generation);
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
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (state.current.phase !== "idle") return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent === null || percent === undefined) return;

    let config: ShadowCompactConfig;
    try {
      config = await configFor(ctx);
    } catch (error) {
      reportError(ctx, error);
      return;
    }
    if (percent < config.softCompactThresholdPercent || state.current.phase !== "idle") return;

    const prepared = state.startPreparing();
    if (!prepared) return;
    const branch = ctx.sessionManager.getBranch();
    // Fire and forget: the live agent run continues immediately.
    void prepare(ctx, config, branch, prepared.controller);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (state.clearPendingNativeFallback()) {
      ctx.compact({});
      return;
    }

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
        ctx.compact({});
      },
    });
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
    if (event.fromExtension) state.reset();
  });
  pi.on("session_compact_failed", (event) => {
    if (event.fromExtension) state.reset();
  });
  pi.on("session_tree", () => state.reset());
  pi.on("session_shutdown", () => state.reset());
}

function latestCompactionId(branch: SessionEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "compaction") return entry.id;
  }
  return null;
}

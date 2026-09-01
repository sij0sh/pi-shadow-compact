import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ShadowCompactConfig } from "./config.js";
import { NORMALIZED_PACKET_MAX_CHARS, SUMMARY_MAX_TOKENS } from "./constants.js";
import { normalizeSnapshot } from "./normalize.js";
import { captureSessionSnapshot } from "./session-snapshot.js";
import {
  ShadowCompactStateController,
  type PreparedFileDetails,
  type PreparedSummary,
} from "./state.js";
import { resolveSummarizerModel, runSummaryAgent } from "./summary-agent.js";
import type { SessionSnapshot } from "./types.js";

function fileDetails(
  event: SessionBeforeCompactEvent,
  snapshot: SessionSnapshot,
): PreparedFileDetails {
  const read = new Set(event.preparation.fileOps.read);
  const modified = new Set([
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);

  for (const entry of snapshot.sourceEntries) {
    if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") continue;
    const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown };
    if (Array.isArray(details.readFiles)) {
      for (const path of details.readFiles) if (typeof path === "string") read.add(path);
    }
    if (Array.isArray(details.modifiedFiles)) {
      for (const path of details.modifiedFiles) if (typeof path === "string") modified.add(path);
    }
  }

  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function packetBudget(contextWindow: number, maxTokens: number): number {
  const reservedTokens = maxTokens * 7 + 8192;
  const availableTokens = contextWindow - reservedTokens;
  if (availableTokens < 4096) throw new Error("Summarizer model context window is too small");
  return Math.min(NORMALIZED_PACKET_MAX_CHARS, availableTokens);
}

function isPreparedValid(ctx: ExtensionContext, prepared: PreparedSummary): boolean {
  const snapshot = prepared.snapshot;
  if (ctx.sessionManager.getSessionId() !== snapshot.sessionId) return false;
  if (ctx.sessionManager.getSessionFile() !== snapshot.sessionFile) return false;

  const branch = ctx.sessionManager.getBranch();
  const cutIndex = branch.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
  const leafIndex = branch.findIndex((entry) => entry.id === snapshot.leafId);
  return cutIndex >= 0 && leafIndex >= cutIndex;
}

function compactionResult(prepared: PreparedSummary, event: SessionBeforeCompactEvent) {
  return {
    summary: prepared.summary,
    firstKeptEntryId: prepared.snapshot.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage: prepared.usage,
    details: prepared.details,
  };
}

async function prepareSummary(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  config: ShadowCompactConfig,
  signal: AbortSignal,
  customFocus?: string,
): Promise<PreparedSummary> {
  const snapshot = await captureSessionSnapshot(event, ctx);
  if (signal.aborted) throw signal.reason ?? new Error("Summary preparation aborted");

  const model = resolveSummarizerModel(ctx, config);
  const maxTokens = Math.min(SUMMARY_MAX_TOKENS, model.maxTokens ?? SUMMARY_MAX_TOKENS);
  const packet = normalizeSnapshot(snapshot, packetBudget(model.contextWindow, maxTokens));
  if (packet.evidence.length === 0) throw new Error("No normalized evidence to summarize");

  const result = await runSummaryAgent(ctx, packet, config, {
    signal,
    model,
    maxTokens,
    ...(customFocus?.trim() ? { customFocus } : {}),
  });

  return {
    snapshot: {
      ...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
      sessionId: snapshot.sessionId,
      leafId: snapshot.leafId,
      firstKeptEntryId: snapshot.firstKeptEntryId,
    },
    summary: result.summary,
    usage: result.usage,
    details: {
      ...fileDetails(event, snapshot),
      provenance: {
        digest: packet.digest,
        evidenceCount: packet.evidence.length,
        truncated: packet.truncated,
        usedPreviousCheckpointFallback: packet.usedPreviousCheckpointFallback,
        evidenceRefs: result.evidenceRefs,
      },
    },
  };
}

export default function shadowCompact(pi: ExtensionAPI): void {
  const state = new ShadowCompactStateController();
  let configPromise: Promise<ShadowCompactConfig> | undefined;
  let reportedConfigError: string | undefined;

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (reportedConfigError === message) return;
    reportedConfigError = message;
    ctx.ui.notify(`shadow-compact: ${message}`, "error");
  };

  const configFor = async (ctx: ExtensionContext): Promise<ShadowCompactConfig> => {
    configPromise ??= loadConfig(ctx).then((config) => {
      reportedConfigError = undefined;
      return config;
    });
    return configPromise;
  };

  const resetConfig = (ctx: ExtensionContext) => {
    configPromise = undefined;
    reportedConfigError = undefined;
    void configFor(ctx).catch((error) => reportError(ctx, error));
  };

  pi.on("session_start", (_event, ctx) => {
    state.reset();
    resetConfig(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
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

    const probe = state.beginProbe();
    if (!probe) return;
    ctx.compact({
      customInstructions: probe.marker,
      onComplete: () => {
        if (state.matchesProbe(probe.marker)) state.reset();
      },
      onError: () => {
        if (state.current.phase === "probing" && state.matchesProbe(probe.marker)) state.reset();
      },
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (state.matchesProbe(event.customInstructions)) {
      const marker = event.customInstructions;
      if (!marker) return { cancel: true };
      const preparing = state.beginPreparation(marker);
      if (!preparing) return { cancel: true };

      void (async () => {
        try {
          const config = await configFor(ctx);
          const prepared = await prepareSummary(
            event,
            ctx,
            config,
            preparing.controller.signal,
          );
          if (!state.isCurrent(preparing.epoch) || !isPreparedValid(ctx, prepared)) {
            state.failPreparation(preparing.epoch);
            return;
          }
          state.publish(preparing.epoch, prepared);
        } catch (error) {
          if (!preparing.controller.signal.aborted) reportError(ctx, error);
          state.failPreparation(preparing.epoch);
        }
      })();

      return { cancel: true };
    }

    if (state.matchesAdoption(event.customInstructions)) {
      const current = state.current;
      if (current.phase !== "adopting" || !isPreparedValid(ctx, current.prepared)) return;
      return { compaction: compactionResult(current.prepared, event) };
    }

    const current = state.current;
    if (
      event.reason !== "manual" &&
      current.phase === "ready" &&
      isPreparedValid(ctx, current.prepared)
    ) {
      return { compaction: compactionResult(current.prepared, event) };
    }

    state.reset();
    try {
      const config = await configFor(ctx);
      const prepared = await prepareSummary(
        event,
        ctx,
        config,
        event.signal,
        event.reason === "manual" ? event.customInstructions : undefined,
      );
      return { compaction: compactionResult(prepared, event) };
    } catch {
      return;
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const current = state.current;
    if (current.phase === "adopting") {
      await current.promise.catch(() => undefined);
      return { action: "continue" };
    }
    if (current.phase !== "ready") return { action: "continue" };
    if (!isPreparedValid(ctx, current.prepared)) {
      state.reset();
      return { action: "continue" };
    }

    const promise = state.beginAdoption(
      (marker) =>
        new Promise<void>((resolve) => {
          ctx.compact({
            customInstructions: marker,
            onComplete: () => {
              state.reset();
              resolve();
            },
            onError: () => {
              state.reset();
              resolve();
            },
          });
        }),
    );
    await promise?.catch(() => undefined);
    return { action: "continue" };
  });

  pi.on("session_compact", () => state.reset());
  pi.on("session_compact_failed", () => {
    // Attempt callbacks own terminal state. The event has no marker, so it cannot
    // safely distinguish an expected cancelled probe from a real compaction.
  });
  pi.on("session_tree", () => state.reset());
  pi.on("session_shutdown", () => state.dispose());
}

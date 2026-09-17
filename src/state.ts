import type { Usage } from "@earendil-works/pi-ai";
import type { FileDetails } from "./prepare.js";

// Single definition lives in prepare.ts alongside fileDetails(); re-exported
// here so existing `.../state.js` import sites keep working.
export type { FileDetails } from "./prepare.js";

export interface PreparedResult {
  /** Stable identity across persist/restore so an idle settle persists once. */
  checkpointId: string;
  sessionId: string;
  leafId: string;
  latestCompactionId: string | null;
  firstKeptEntryId: string;
  summary: string;
  usage: Usage;
  details: FileDetails;
  /** Context size observed at publish; metadata for the mid-run swap message. */
  contextTokensBefore?: number;
}

export interface PreparingInfo {
  generation: number;
  controller: AbortController;
}

/**
 * Why a native fallback is queued for the next idle point.
 *
 * - `"failure"`: the background summary failed with nothing serving, so one
 *   ordinary native compaction is the only safe recovery. Unconditional.
 * - `"hard-threshold"`: context spiked past the hard threshold. Conditional:
 *   the idle point rechecks the threshold first, because the spike may have
 *   recovered while the run drained (a stale hatch must not compact a
 *   healthy working set).
 */
export type PendingFallbackReason = "failure" | "hard-threshold";

/**
 * Rolling working-set maintenance state.
 *
 * The checkpoint currently being served (`published`) is separate from the
 * checkpoint currently being built (`preparing`): a published summary keeps
 * swapping into requests while its replacement prepares, then the replacement
 * takes over. Durability is a persisted CustomEntry projection, not a native
 * compaction, so there is no commit phase: `published` keeps serving across
 * idle settles, and `persistedCheckpointId` records which checkpoint already
 * landed in the session file.
 *
 * `refreshArmed` gates new preparations so a refresh cannot spin while the
 * working set stays above the soft threshold. A trigger disarms it; only an
 * observed swap followed by below-soft context re-arms it (crossing
 * hysteresis). A preparation that fails while a checkpoint keeps serving
 * keeps the gate shut (a failure must not manufacture a threshold crossing);
 * an empty snapshot suppresses until the working set grows meaningfully;
 * any other failure with nothing serving falls back to one native compaction
 * and re-arms.
 *
 * `generation` identifies one preparation attempt: it increments on every
 * `startPreparing()` (as well as on invalidation paths), so the trace joins
 * prepare/publish/swap/rearm per attempt.
 */
export class ShadowCompactStateController {
  #generation = 0;
  #published: PreparedResult | undefined = undefined;
  #publishedSwapped = false;
  #preparing: PreparingInfo | undefined = undefined;
  #persistedCheckpointId: string | undefined = undefined;
  #pendingNativeFallback: PendingFallbackReason | null = null;
  #swapCount = 0;
  #firstSwapTurn: number | undefined = undefined;
  #refreshArmed = true;
  #emptySuppressedAtTokens: number | undefined = undefined;

  get generation(): number {
    return this.#generation;
  }

  get published(): PreparedResult | undefined {
    return this.#published;
  }

  /** Whether the serving checkpoint has swapped into at least one request. */
  get publishedSwapped(): boolean {
    return this.#publishedSwapped;
  }

  get preparing(): PreparingInfo | undefined {
    return this.#preparing;
  }

  /** The checkpoint already persisted as a CustomEntry, if any. */
  get persistedCheckpointId(): string | undefined {
    return this.#persistedCheckpointId;
  }

  get pendingNativeFallback(): boolean {
    return this.#pendingNativeFallback !== null;
  }

  /** Why the queued fallback was requested, if one is queued. */
  get pendingFallbackReason(): PendingFallbackReason | undefined {
    return this.#pendingNativeFallback ?? undefined;
  }

  /** Requests served into request messages since the serving checkpoint published. */
  get swapCount(): number {
    return this.#swapCount;
  }

  /** Turn of the first served request for the serving checkpoint, if served. */
  get firstSwapTurn(): number | undefined {
    return this.#firstSwapTurn;
  }

  get refreshArmed(): boolean {
    return this.#refreshArmed;
  }

  /** Context size when an empty snapshot suppressed preparation, if suppressed. */
  get emptySuppressedAtTokens(): number | undefined {
    return this.#emptySuppressedAtTokens;
  }

  /** Derived phase for logs and tests. Preparing wins, then serving. */
  get phase(): "idle" | "preparing" | "ready" | "ready-preparing" {
    if (this.#preparing && this.#published) return "ready-preparing";
    if (this.#preparing) return "preparing";
    if (this.#published) return "ready";
    return "idle";
  }

  /**
   * Starts a preparation. Succeeds while a published checkpoint keeps serving;
   * fails only while another preparation is already in flight.
   * Disarms the refresh gate: the next trigger needs an observed swap + shrink.
   * Bumps the generation so every attempt has a unique trace identity (a slow
   * superseded completion can never alias a newer preparation).
   */
  startPreparing(): PreparingInfo | undefined {
    if (this.#preparing) return undefined;
    this.#generation += 1;
    const preparing: PreparingInfo = {
      generation: this.#generation,
      controller: new AbortController(),
    };
    this.#preparing = preparing;
    this.#refreshArmed = false;
    this.#emptySuppressedAtTokens = undefined;
    return preparing;
  }

  /**
   * Clears per-checkpoint serving exposure. Every path that installs or drops
   * the serving checkpoint shares this; only the refresh gate and durability
   * marker differ per path, so those stay with the caller.
   */
  #resetServingFields(): void {
    this.#publishedSwapped = false;
    this.#swapCount = 0;
    this.#firstSwapTurn = undefined;
    this.#emptySuppressedAtTokens = undefined;
  }

  /** Publishes a completed preparation, replacing the checkpoint being served. */
  publish(generation: number, result: PreparedResult): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    if (this.#preparing.controller.signal.aborted) return false;
    this.#preparing = undefined;
    this.#published = result;
    this.#resetServingFields();
    return true;
  }

  /**
   * Restores a validated persisted checkpoint into service (session_start).
   * Behaves like a fresh publish that already landed: the gate stays disarmed
   * until an observed swap + shrink, and no re-persist is needed.
   */
  restorePublished(result: PreparedResult): void {
    this.#published = result;
    this.#resetServingFields();
    this.#refreshArmed = false;
    this.#persistedCheckpointId = result.checkpointId;
  }

  /** Records that the serving checkpoint landed as a CustomEntry. */
  markPersisted(checkpointId: string): void {
    this.#persistedCheckpointId = checkpointId;
  }

  fail(generation: number): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    this.#preparing = undefined;
    if (this.#published) {
      // Keep the serving checkpoint and keep the refresh gate disarmed: a
      // failed replacement must not manufacture a threshold crossing (it would
      // otherwise retry — burning a real summarizer call — on every turn while
      // context stays above soft). Only an observed swap + shrink re-arms.
      this.#refreshArmed = false;
    } else {
      this.#pendingNativeFallback = "failure";
      this.#refreshArmed = true;
    }
    return true;
  }

  /**
   * Drops a preparation that found nothing disposable to summarize (empty
   * snapshot at the soft boundary). This is not a summarizer failure, so it
   * queues no native fallback; it suppresses until the working set grows
   * meaningfully (see rearmAfterGrowth) or the hard hatch fires.
   */
  skipPreparation(generation: number, currentTokens?: number): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    this.#preparing = undefined;
    this.#refreshArmed = false;
    this.#emptySuppressedAtTokens = currentTokens;
    return true;
  }

  /**
   * Re-arms after an empty-snapshot suppression once the working set grew by
   * max(1000, tailBudget * 0.25) tokens. Without a recorded suppression size
   * this never fires, preserving the swap+shrink-only re-arm.
   */
  rearmAfterGrowth(currentTokens: number, tailBudgetTokens: number): boolean {
    if (this.#emptySuppressedAtTokens === undefined) return false;
    if (this.#refreshArmed) {
      this.#emptySuppressedAtTokens = undefined;
      return false;
    }
    const threshold =
      this.#emptySuppressedAtTokens + Math.max(1000, tailBudgetTokens * 0.25);
    if (currentTokens < threshold) return false;
    this.#emptySuppressedAtTokens = undefined;
    this.#refreshArmed = true;
    return true;
  }

  /**
   * Records that the serving checkpoint swapped into a request. True on the
   * first swap. Counts every served request and remembers the first swap's
   * turn so idle-point telemetry can report meaningful post-swap exposure
   * (served >= N turns) per checkpoint.
   */
  markSwapped(turn?: number): boolean {
    if (!this.#published) return false;
    this.#swapCount += 1;
    if (this.#publishedSwapped) return false;
    this.#publishedSwapped = true;
    if (turn !== undefined) this.#firstSwapTurn = turn;
    return true;
  }

  /** Re-arms the refresh gate after an observed swap + shrink. True when it flips. */
  rearm(): boolean {
    if (this.#refreshArmed) return false;
    this.#refreshArmed = true;
    this.#emptySuppressedAtTokens = undefined;
    return true;
  }

  requestNativeFallback(reason: PendingFallbackReason = "hard-threshold"): boolean {
    if (this.#pendingNativeFallback) return false;
    this.#preparing?.controller.abort();
    this.#preparing = undefined;
    this.#generation += 1;
    this.#pendingNativeFallback = reason;
    return true;
  }

  clearPendingNativeFallback(): boolean {
    if (!this.#pendingNativeFallback || this.#preparing) return false;
    this.#pendingNativeFallback = null;
    return true;
  }

  /**
   * Drops a stale serving checkpoint. Re-arms so the next crossing retries
   * fresh instead of latching on a checkpoint that can never land.
   */
  discardPublished(): boolean {
    if (!this.#published) return false;
    this.#published = undefined;
    this.#resetServingFields();
    this.#refreshArmed = true;
    return true;
  }

  /** Terminal for invalidation paths alike: native compaction, manual reset, reload. */
  reset(): void {
    this.#preparing?.controller.abort();
    this.#preparing = undefined;
    this.#published = undefined;
    this.#resetServingFields();
    this.#persistedCheckpointId = undefined;
    this.#generation += 1;
    this.#pendingNativeFallback = null;
    this.#refreshArmed = true;
  }
}

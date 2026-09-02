import type { Usage } from "@earendil-works/pi-ai";

export interface FileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PreparedResult {
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

interface Base {
  readonly generation: number;
}

export interface IdleState extends Base {
  readonly phase: "idle";
  readonly pendingNativeFallback: boolean;
}

export interface PreparingState extends Base {
  readonly phase: "preparing";
  readonly controller: AbortController;
}

export interface ReadyState extends Base {
  readonly phase: "ready";
  readonly result: PreparedResult;
}

export interface CommittingState extends Base {
  readonly phase: "committing";
  readonly result: PreparedResult;
  readonly nonce: string;
}

export type ShadowCompactState = IdleState | PreparingState | ReadyState | CommittingState;

/** Owns generation, cancellation, and one-shot commit state for one extension. */
export class ShadowCompactStateController {
  #state: ShadowCompactState = { phase: "idle", generation: 0, pendingNativeFallback: false };

  get current(): ShadowCompactState {
    return this.#state;
  }

  startPreparing(): PreparingState | undefined {
    if (this.#state.phase !== "idle") return undefined;
    const state: PreparingState = {
      phase: "preparing",
      generation: this.#state.generation,
      controller: new AbortController(),
    };
    this.#state = state;
    return state;
  }

  publish(generation: number, result: PreparedResult): boolean {
    if (this.#state.phase !== "preparing" || this.#state.generation !== generation) return false;
    if (this.#state.controller.signal.aborted) return false;
    this.#state = { phase: "ready", generation, result };
    return true;
  }

  fail(generation: number): boolean {
    if (this.#state.phase !== "preparing" || this.#state.generation !== generation) return false;
    this.#state = { phase: "idle", generation, pendingNativeFallback: true };
    return true;
  }

  requestNativeFallback(): boolean {
    if (this.#state.phase === "idle" && this.#state.pendingNativeFallback) return false;
    if (this.#state.phase === "preparing") this.#state.controller.abort();
    this.#state = {
      phase: "idle",
      generation: this.#state.generation + 1,
      pendingNativeFallback: true,
    };
    return true;
  }

  clearPendingNativeFallback(): boolean {
    if (this.#state.phase !== "idle" || !this.#state.pendingNativeFallback) return false;
    this.#state = { phase: "idle", generation: this.#state.generation, pendingNativeFallback: false };
    return true;
  }

  beginCommit(nonce: string): CommittingState | undefined {
    if (this.#state.phase !== "ready") return undefined;
    const state: CommittingState = {
      phase: "committing",
      generation: this.#state.generation,
      result: this.#state.result,
      nonce,
    };
    this.#state = state;
    return state;
  }

  /** Terminal for commit success, failure, and invalidation alike. */
  reset(): void {
    if (this.#state.phase === "preparing") this.#state.controller.abort();
    this.#state = {
      phase: "idle",
      generation: this.#state.generation + 1,
      pendingNativeFallback: false,
    };
  }
}

import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { ADOPT_PREFIX, PROBE_PREFIX } from "./constants.js";
import type { SnapshotIdentity } from "./types.js";

export interface PreparedFileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PreparedProvenance {
  digest: string;
  evidenceCount: number;
  truncated: boolean;
  usedPreviousCheckpointFallback: boolean;
  evidenceRefs: string[];
}

export interface PreparedSummary {
  snapshot: SnapshotIdentity;
  summary: string;
  usage: Usage;
  details: PreparedFileDetails & { provenance: PreparedProvenance };
}

interface EpochState {
  readonly epoch: number;
}

export interface IdleState extends EpochState {
  readonly phase: "idle";
}

export interface ProbingState extends EpochState {
  readonly phase: "probing";
  readonly marker: string;
}

export interface PreparingState extends EpochState {
  readonly phase: "preparing";
  readonly probeMarker: string;
  readonly controller: AbortController;
}

export interface ReadyState extends EpochState {
  readonly phase: "ready";
  readonly prepared: PreparedSummary;
}

export interface AdoptingState extends EpochState {
  readonly phase: "adopting";
  readonly marker: string;
  readonly prepared: PreparedSummary;
  readonly promise: Promise<void>;
}

export interface DisposedState extends EpochState {
  readonly phase: "disposed";
}

export type ShadowCompactState =
  | IdleState
  | ProbingState
  | PreparingState
  | ReadyState
  | AdoptingState
  | DisposedState;

export function isProbeMarker(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PROBE_PREFIX) && value.endsWith("]");
}

export function isAdoptMarker(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ADOPT_PREFIX) && value.endsWith("]");
}

/** Owns the state and cancellation resources for one extension instance. */
export class ShadowCompactStateController {
  #state: ShadowCompactState = { phase: "idle", epoch: 0 };
  #sequence = 0;

  get current(): ShadowCompactState {
    return this.#state;
  }

  beginProbe(): ProbingState | undefined {
    if (this.#state.phase !== "idle") return undefined;
    const state: ProbingState = {
      phase: "probing",
      epoch: this.#state.epoch,
      marker: this.#marker(PROBE_PREFIX),
    };
    this.#state = state;
    return state;
  }

  beginPreparation(probeMarker: string): PreparingState | undefined {
    if (this.#state.phase !== "probing" || this.#state.marker !== probeMarker) return undefined;
    const state: PreparingState = {
      phase: "preparing",
      epoch: this.#nextEpoch(),
      probeMarker,
      controller: new AbortController(),
    };
    this.#state = state;
    return state;
  }

  publish(epoch: number, prepared: PreparedSummary): boolean {
    if (this.#state.phase !== "preparing" || this.#state.epoch !== epoch) return false;
    if (this.#state.controller.signal.aborted) return false;
    this.#state = { phase: "ready", epoch, prepared };
    return true;
  }

  failPreparation(epoch: number): boolean {
    if (this.#state.phase !== "preparing" || this.#state.epoch !== epoch) return false;
    this.reset();
    return true;
  }

  beginAdoption(start: (marker: string) => Promise<void>): Promise<void> | undefined {
    if (this.#state.phase === "adopting") return this.#state.promise;
    if (this.#state.phase !== "ready") return undefined;

    const ready = this.#state;
    const marker = this.#marker(ADOPT_PREFIX);
    const promise = Promise.resolve().then(() => start(marker));
    this.#state = {
      phase: "adopting",
      epoch: ready.epoch,
      marker,
      prepared: ready.prepared,
      promise,
    };
    return promise;
  }

  isCurrent(epoch: number): boolean {
    return this.#state.phase !== "disposed" && this.#state.epoch === epoch;
  }

  matchesProbe(marker: unknown): boolean {
    return (
      (this.#state.phase === "probing" && this.#state.marker === marker) ||
      (this.#state.phase === "preparing" && this.#state.probeMarker === marker)
    );
  }

  matchesAdoption(marker: unknown): boolean {
    return this.#state.phase === "adopting" && this.#state.marker === marker;
  }

  reset(): void {
    if (this.#state.phase === "disposed") return;
    this.#abortBackground();
    this.#state = { phase: "idle", epoch: this.#nextEpoch() };
  }

  dispose(): void {
    if (this.#state.phase === "disposed") return;
    this.#abortBackground();
    this.#state = { phase: "disposed", epoch: this.#nextEpoch() };
  }

  #abortBackground(): void {
    if (this.#state.phase === "preparing") this.#state.controller.abort();
  }

  #nextEpoch(): number {
    return this.#state.epoch + 1;
  }

  #marker(prefix: string): string {
    this.#sequence++;
    return `${prefix}${randomUUID()}:${this.#sequence}]`;
  }
}

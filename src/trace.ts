import { appendFileSync } from "node:fs";

/**
 * Extension-local lifecycle telemetry for rolling working-set maintenance.
 *
 * Records threshold crossings, preparation outcomes, swap applications, rearms,
 * checkpoint persists/restores, and fallbacks with enough structure to derive
 * swap reduction, context area-under-trajectory, and summarizer overhead.
 * These records never enter session history, so measuring never perturbs the
 * working set.
 *
 * Two sinks, both best-effort and silent on failure:
 * - `SHADOW_COMPACT_TRACE`: JSON lines appended to a file (local runs).
 * - `SHADOW_COMPACT_TRACE_STDERR`: when set to anything but "", "0", or
 *   "false", the same lines go to stderr prefixed with `shadow-compact-trace `.
 *   The roast harness captures the agent's stderr per trial, which makes the
 *   mid-run swap observable in benchmark artifacts without touching history.
 */
export const TRACE_FILE_ENV_VAR = "SHADOW_COMPACT_TRACE";
export const TRACE_STDERR_ENV_VAR = "SHADOW_COMPACT_TRACE_STDERR";
export const TRACE_STDERR_PREFIX = "shadow-compact-trace ";

export type TraceEventType =
  | "turn_usage"
  | "threshold_crossed"
  | "prepare_started"
  | "prepare_completed"
  | "prepare_failed"
  | "checkpoint_published"
  | "checkpoint_install_proposed"
  | "checkpoint_installed"
  | "swap_applied"
  | "checkpoint_rearmed"
  | "checkpoint_persisted"
  | "checkpoint_restored"
  | "checkpoint_restore_rejected"
  | "native_fallback"
  | "compaction_served"
  | "compaction_fallback"
  | "summary_recovery"
  | "compaction_route"
  | "compaction_outcome"
  | "summary_call";

/** Change when the deployed compaction routing contract changes. */
export const COMPACTION_CAPABILITY = "bounded-recovery-v2";

export function isStderrTraceEnabled(): boolean {
  // Local read: trace stays dependency-free so telemetry never pulls in
  // config (and its pi-coding-agent import) just to check a flag.
  const raw = process.env[TRACE_STDERR_ENV_VAR];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

export function traceEvent(type: TraceEventType, fields: Record<string, unknown> = {}): void {
  const file = process.env[TRACE_FILE_ENV_VAR];
  const stderr = isStderrTraceEnabled();
  if (!file && !stderr) return;
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), event: type, ...fields });
  } catch {
    return;
  }
  if (file) {
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      // Telemetry must never perturb the run it measures.
    }
  }
  if (stderr) {
    try {
      process.stderr.write(`${TRACE_STDERR_PREFIX}${line}\n`);
    } catch {
      // Telemetry must never perturb the run it measures.
    }
  }
}

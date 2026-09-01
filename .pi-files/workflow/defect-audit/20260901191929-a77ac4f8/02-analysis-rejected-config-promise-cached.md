# 02 Analysis - rejected-config-promise-cached

Run: `20260901191929-a77ac4f8` - Loop 1, iteration 5
Behavior: `config-load` - Criticality: normal (copied)
Location confirmed: **src/index.ts:45-50** (`configFor`: `configPromise ??= loadConfig(ctx).then(...)`), the only cache invalidation at src/index.ts:126-129 (`session_start`), the only consumer catch at src/index.ts:136-142 (`turn_end`).

## Verdict: PROVEN

Runtime-executed, deterministic, first-run pass, using the repository's own extension harness (real handlers, real `configFor`/`loadConfig`, real fs reads against `PI_CODING_AGENT_DIR`; only the model call is faked, as in every existing index test). Three probes, all in `.agents/artifacts/`.

## Expected behavior

- Scope contract: config-load exists to "Resolve project and global config **once per session**". Caching applies to a *resolved* config; a rejected load resolved nothing.
- The extension's own design implies retry-ability: `reportedError` (src/index.ts:39-43) dedups identical toasts precisely so a repeating trigger (`turn_end`) can re-attempt without toast spam. A permanently latched rejection makes that affordance dead code.
- Reasonable inference: a transient failure (momentarily unreadable or partially written file) must not disable the feature for the rest of the session; recovery should be at most one trigger away.

Given: a session whose first config read fails transiently (invalid/partial JSON, or a non-ENOENT fs error such as EACCES), and a later `turn_end` after the file is fixed/restored.
When: `configFor` is called again.
Then: expected - the load is re-attempted (dedup keeps the user quiet). Actual - the cached rejected promise is returned, the identical error is deduped to silence, and soft compaction stays off until `session_start`.

## Reproduction

### Probe 1 - end-to-end latch, dedup, restart-only recovery (`.agents/artifacts/probe1-rejected-config-promise-cached.ts`)

Command: `node --import tsx .agents/artifacts/probe1-rejected-config-promise-cached.ts` (repo root)
Scenario: repo `fixture()`; global config file written as `{ truncated`.

1. `session_start`; `turn_end` at 70%: exactly one toast `shadow-compact: <path> is not valid JSON`; 0 model calls, 0 compact calls.
2. File fixed on disk to a fully valid config. Two more `turn_end`s: **still 0 model calls, 0 compact calls, notifications stuck at 1** - dedup hides the recurrence (`reportedError` keeps the first message; the `then` that would clear it never runs).
3. `process.on("unhandledRejection")` count is 0: no crash - the failure is a silent disable, worse for visibility than a crash.
4. Emitting `session_start` (only invalidation) and one `turn_end`: summary runs and completes. The fixed file is honored **only after a session restart**.

Deterministic; PASS.

### Probe 2 - non-ENOENT trigger variant + cache isolation (`.agents/artifacts/probe2-eacces-trigger-and-cache-isolation.ts`)

Command: `node --import tsx .agents/artifacts/probe2-eacces-trigger-and-cache-isolation.ts`
Scenario: valid config file; `chmod 000` simulates a transiently unreadable file (sync/rotate); restore `644` afterwards.

1. `turn_end` at 70% during the unreadable window: one toast matching `Cannot read .*EACCES` (readOptional rethrow, src/config.ts:62-63); 0 model calls.
2. Permissions restored, same valid content, next `turn_end`: **still 0 model calls**; notifications still 1.
3. Negative control: a fresh `loadConfig()` call right now succeeds (threshold 60, configured summarizer returned). The file is fine - **the cache, not loadConfig, keeps the failure alive**.

Deterministic; PASS.

### Probe 3 - trigger surface: any turn_end with usage data (`.agents/artifacts/probe3-trigger-surface.ts`)

Command: `node --import tsx .agents/artifacts/probe3-trigger-surface.ts`
Scenario: `configFor` runs on every `turn_end` that has usage data, BEFORE the threshold comparison (src/index.ts:133-142).

1. `turn_end` at **10%** (below threshold) with corrupt config: toast fires and the rejection latches - no threshold crossing is needed to arm the defect, matching the candidate's "during any turn_end".
2. Fix the file; fire `turn_end` at 61/75/90/95%: 0 model calls, 0 compact calls, still 1 toast. The extension contributes nothing for the rest of the session, even in the range where Pi's native auto-compact would need a served checkpoint.

Deterministic; PASS.

## Diagnosis

- **Trigger**: any `turn_end` carrying context-usage data - including below-threshold turns - whose config read fails transiently: a partially written or invalid JSON file (JSON.parse throw, src/config.ts:66-68) or a non-ENOENT read error (EACCES/EISDIR/stale NFS handle, rethrown at src/config.ts:62-63). Probes used invalid JSON (1, 3) and EACCES (2).
- **Mechanism**: `configFor` memoizes with `configPromise ??= loadConfig(ctx).then(...)`; the derived promise settles rejected and stays in `configPromise`. The `turn_end` catch only calls `reportError` (deduped) and returns; nothing on the failure path touches `configPromise`. `reportedError`'s reset lives inside the success `then`, which never runs, so even the toast never reappears. The sole invalidation is `session_start` (src/index.ts:127), so the rejected promise outlives the transient condition by the whole session.
- **Root cause**: the memo stores the promise's settlement, not its success value - failure is cached exactly like success. The session-cache design ("once per session") was applied to the promise object instead of to a resolved config, and no failure-path invalidation was added despite `reportedError` being built for repeatable attempts.
- **Counterfactual**: had the rejection cleared `configPromise` (reset the memo and rethrow), the next `turn_end` would reload; probe 2's negative control shows a fresh `loadConfig` succeeds the instant the transient condition ends, so recovery would be one trigger away and the dedup would hold toasts to the design limit. Violated invariant: a transient I/O/parse failure must not permanently disable the feature; the cached-promise contract is "resolve config once", not "remember failure forever". Affected scope: the entire soft-compaction pipeline for the session - threshold trigger (turn_end), settle-commit (no checkpoint to commit), and `session_before_compact` serving (nothing cached, so Pi's native summarizer runs visibly when its own threshold fires).
- **Family classification**: standalone. Searched for the same mechanism (a memoized rejected promise or a failure state latched for the session). The only sibling-shaped state is `reportedError` itself, but its latch is part of this same defect episode (its reset sits in the `then` that never runs), not a separately established defect. No other promise is memoized across events in the extension.

No fix designed; production code untouched. Baseline re-verified: `npm run check` green, 106/106 tests.

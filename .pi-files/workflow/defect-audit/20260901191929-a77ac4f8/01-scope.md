# 01 Scope - Defect Audit `20260901191929-a77ac4f8`

Target: entire codebase of `pi-shadow-compact` (Pi extension for silent soft-threshold compaction).

Sources: `src/index.ts` (233 LoC), `src/state.ts` (104), `src/summary.ts` (295), `src/normalize.ts` (216), `src/prepare.ts` (79), `src/config.ts` (157), `test/` (7 files), `README.md`, and Pi host APIs read from `node_modules/@earendil-works/pi-coding-agent/dist` (agent-session.js compaction flow, runner.js ctx actions, compaction.js findCutPoint/prepareCompaction, session-manager.js appendCompaction).

Baseline health: `npm run check` EXECUTED - typecheck clean, 106/106 tests pass.

## Runtime architecture (mapped)

Pi loads `src/index.ts` as an extension. One `ShadowCompactStateController` (idle -> preparing -> ready -> committing -> idle, generation-guarded) drives a detached summary pipeline:

1. `turn_end` reads `ctx.getContextUsage().percent`; at or above `softCompactThresholdPercent` it synchronously claims `startPreparing()` and fires `prepare()` without awaiting (src/index.ts:70-105).
2. `prepare()` snapshots Pi's native cut point (`prepareSnapshot`, keepRecentTokens from settings), builds a token budget, normalizes the branch into a redacted evidence packet, runs a 1-shot+1-retry summary model call, re-checks session/branch/compaction currency, and publishes the result or fails into a pending native fallback (src/index.ts:44-86, src/prepare.ts, src/normalize.ts, src/summary.ts).
3. `agent_settled` either runs one plain native `ctx.compact({})` after a failed summary, or commits a ready checkpoint via `ctx.compact({customInstructions: nonce})` (src/index.ts:107-135).
4. `session_before_compact` serves the cached summary when the nonce matches the committing state, or when Pi auto-compacts with an exactly matching boundary; manual compaction invalidates the cache (src/index.ts:137-176).
5. `session_compact`/`session_compact_failed`/`session_tree`/`session_shutdown`/`session_start` reset state (and the config cache).

Host facts verified in Pi dist (INFERRED from host source unless noted): `ctx.compact` swallows errors into `onError` (agent-session.js:2068-2080). `appendCompaction` persists the extension-provided `usage` verbatim; `CompactionResult.usage` is documented as "usage from the LLM call(s) that generated this summary". Post-compaction context percent comes from `estimateContextTokens`, not from compaction usage. `findCutPoint` keeps everything below `keepRecentTokens` (default 20000). A branch that never accumulates that many tokens yields an empty summarizable range (compaction.js:308-330).

## Deep-mapped paths

| id | entry | purpose | criticality | context (state/deps, failure surface) |
|---|---|---|---|---|
| soft-trigger | src/index.ts `pi.on("turn_end")` | Detect first threshold crossing and launch background prepare | critical | Reads usage percent + cached config; claims preparing state. Failure: silently no trigger; guard is the idle-phase check. |
| background-prepare | src/index.ts `prepare()` | Snapshot boundary, build packet, summarize, publish result | critical | Owns AbortController; validates session/branch/compaction currency before publish. Failure: catch -> `state.fail` -> pendingNativeFallback; one early `return` path bypasses fail (candidate). |
| state-machine | src/state.ts `ShadowCompactStateController` | Generation/phase ownership, abort, one-shot commit, fallback flag | critical | All transitions guard phase+generation. Failure: stuck phase or lost flag blocks trigger/commit. |
| settle-commit | src/index.ts `pi.on("agent_settled")` | Commit ready checkpoint via nonce, or run one native fallback compaction | critical | Calls ctx.compact fire-and-forget; onComplete/onError reset state. Failure: commit error -> native retry once. |
| compact-interception | src/index.ts `pi.on("session_before_compact")` | Serve cached summary for nonce or matching Pi auto-compact; invalidate on manual | critical | Guards nonce, phase, boundary equality, currency. Failure: fall through to Pi native summary (visible model call). |
| packet-normalization | src/normalize.ts `normalizeSnapshot` | Redact, bound, and trim transcript evidence under a budget | major | Pure; entry caps 40k/24k/32k chars, default cap 240k chars. Failure: empty packet -> prepare throws -> fallback; over-budget trimming order and unit of the cap are candidate defects. |
| summary-validation | src/summary.ts `runSummaryAgent` | One model call + one corrective retry; strict JSON + citation validation | major | Rejects non-stop stops, tool calls, unknown refs; renders bounded Markdown. Failure: throw -> prepare catch -> fallback. |
| config-load | src/config.ts `loadConfig`/`parseConfig` + src/index.ts `configFor` | Resolve project/global config once per session | normal | Cached promise; strict schema validation. Failure: throws -> one error toast; see candidate on caching. |

Excluded paths (one-line reasons):
- `dist/shadow-compact.js` - build artifact, not source of truth.
- `.agents/artifacts/*` - historical spec drafts and reference copies, not runtime.
- `test/**` - validation harness; used as evidence only, not audited as runtime.
- `prepare.ts fileDetails` read/modified tracking - informational `CompactionDetails` metadata only.
- `summary.ts prompt-assembly text` - static prompt strings; no state or control flow.

## Selected candidates (5)

1. **stuck-preparing-empty-snapshot** (behavior `background-prepare`, critical)
   - Location: src/index.ts:47-48 (`if (!snapshot) return;`) with src/prepare.ts:22-50 empty-range case.
   - Trigger (INFERRED): `turn_end` at/above threshold while content since the last compaction boundary is below `keepRecentTokens` (default 20000) - e.g. contextWindow <= ~33k models with default threshold 60, or large configured `keepRecentTokens`, or the first post-compaction turns where the retained tail alone exceeds the threshold.
   - Suspected outcome: state machine stays `preparing` forever; every later `turn_end` no-ops; soft compaction is silently disabled for the session with no error toast and no native fallback (the `fail()` path is never reached).
   - Evidence: `prepareSnapshot` returns `undefined` when `sourceEntries` and `turnPrefixEntries` are both empty (findCutPoint keeps everything below keepRecentTokens); `prepare()` returns without `fail()`/`reset()`; only Pi-initiated compaction/tree/session events clear the phase.
   - Affected entries: turn_end, agent_settled.

2. **packet-budget-unit-mismatch** (behavior `packet-normalization`, major)
   - Location: src/index.ts:63-70 (`budget = contextWindow - reservedTokens` in tokens) passed as `maxChars` to `normalizeSnapshot`; src/normalize.ts:40-46 `packetSize` counts JSON chars.
   - Trigger: any prepare whose evidence JSON exceeds `contextWindow - reservedTokens` characters, or `summarizerContextTokens` set above the real window (the project's own tracked `.pi/shadow-compact.json` sets 1000000).
   - Suspected outcome: token budget interpreted as a character cap trims the packet at roughly one quarter of the model's real input capacity (1 token ~ 4 chars). Evidence starves in large sessions, contradicting README's "the input side never starves". With an inflated override the cap never bites, so the prompt can overflow the real window and force fallback.
   - Evidence: budget is derived from `contextWindow`/`maxTokens` (token units); the only consumer treats it as a character limit (`packetSize(evidence) > maxChars`).
   - Affected entries: turn_end.

3. **previous-checkpoint-trimmed-first** (behavior `packet-normalization`, major)
   - Location: src/normalize.ts:41-45 (`while (...) evidence = renumber(evidence.slice(1))`).
   - Trigger: packet over budget in a session that already contains a compaction (previousSummary present at index 0 of drafts).
   - Suspected outcome: the prior checkpoint - the only carrier of pre-compaction context, since those entries no longer exist in the branch - is the first evidence dropped; the new checkpoint silently omits earlier objectives/decisions while the most recent low-value evidence survives.
   - Evidence: `drafts` places `previous_checkpoint` first; the trim loop drops strictly from the front and never treats the checkpoint specially.
   - Affected entries: turn_end.

4. **stale-reset-kills-newer-prepare** (behavior `state-machine`, critical)
   - Location: src/index.ts:84 (`if (!valid || !state.publish(generation, result)) state.reset();`) with src/state.ts `reset()`/`publish()`.
   - Trigger: a stale background summary completes after its generation was superseded (reset via manual compact/tree/compaction while the model call is slow to observe the abort) while a newer `turn_end` prepare is in flight.
   - Suspected outcome: `reset()` unconditionally aborts whatever controller is current - the newer legitimate prepare is silently cancelled (aborted signal, `fail()` no-op) and the generation is bumped again, delaying compaction by a full turn cycle with no notification.
   - Evidence: `publish()` returns false on generation mismatch; the same failure branch then calls `state.reset()` without checking whether the current state still belongs to this generation.
   - Affected entries: turn_end, session_before_compact.

5. **rejected-config-promise-cached** (behavior `config-load`, normal)
   - Location: src/index.ts:39-43 (`configPromise ??= loadConfig(ctx).then(...)`).
   - Trigger: one transient non-ENOENT read failure (e.g. EACCES/EBUSY while the file is rewritten) or transiently invalid JSON during any `turn_end`.
   - Suspected outcome: the rejected promise stays cached for the whole session; soft compaction remains disabled even after the file is fixed, and the dedup reporter shows the error only once so recurrences are invisible.
   - Evidence: `configPromise` is only reassigned on `session_start`; `reportedError` resets only inside the success `.then` or `session_start`; the catch path never clears the cached promise.
   - Affected entries: turn_end.

## Unselected suspicions (one-line reasons)

- `bounded()` returns `marker + full string` when `limit < marker.length` - unreachable; all call-site limits are >= 10,000 chars.
- Fire-and-forget `ctx.compact({})` unhandled rejection - disproven: Pi's context action wraps compact in try/catch and routes errors to `onError` (agent-session.js:2068-2080).
- Commit serves the prepared (older) `firstKeptEntryId` without re-checking Pi's current cut - safe direction: keeps a superset of Pi's native intent, no entry loss.
- No `resultIsCurrent` re-check between `beginCommit` and the `session_before_compact` emit - branch changes in that window would have reset state via session events; keeps-superset remains safe.
- Tool-call/tool-result pairing Map overwrites duplicate call ids - affects normalization fidelity only, no wrong state transitions.
- `fileDetails` tool-name allowlist misses custom mutating tools - degrades informational file lists, not history or boundaries.
- `sumUsage` totals usage across both retry attempts - matches Pi's documented `CompactionResult.usage` semantics ("LLM call(s)").
- `turn_end` threshold compares percent captured before the config await - config resolves in milliseconds and the idle-phase guard re-checks; no realistic staleness.

## Notes

- No fixes, reproductions, or diagnoses attempted at this phase; candidate triggers are hypotheses with copied code evidence.
- Candidate 1's trigger class is statically derived from Pi's `findCutPoint` semantics (keepRecentTokens default 20000) plus `getContextUsage` percent estimates; the loop phase must prove the exact reachability window.

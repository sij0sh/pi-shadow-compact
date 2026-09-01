# Close - Defect Audit 20260901191929-a77ac4f8

Target: entire codebase of pi-shadow-compact (Pi extension for silent soft-threshold compaction).
Inputs: `scope` (01-scope.md) and `evidence` (03-normalize.md). Per-candidate reports were not used to recover state.

## Prior decisions searched

Locations checked: README.md (only maintained doc), git history (`git log`), commit b128a77 and 4724f76 diffs, `.pi/shadow-compact.json` (project config), src comments. No ADR directory, no CHANGELOG, no decision records exist.

| Decision | Source | Status | Relation to recommendations |
|---|---|---|---|
| "The extension still reserves at least half the context window for transcript evidence, so the input side never starves" | README.md (Optional summarizer tuning) | Accepted | fix-budget-unit-conversion follows it: restores the promised evidence budget |
| `summarizerContextTokens` override "decouples the summarizer budget from models.json: the summary request uses the deployment's real capacity" | commit b128a77, src/index.ts comment | Accepted | fix-budget-unit-conversion follows it; the report explicitly rejects clamping the override to models.json |
| "A failed background summary schedules one ordinary native compaction at the next settle point. It never retries in a loop" | README.md (Safety and native fallback) | Accepted | fix-stale-fail-not-reset follows it: `state.fail()` is the documented failure contract; `reset()` was the deviation |
| Soft threshold detected at first persisted `turn_end`; native fallback one-shot | README.md (Limitations, Safety) | Accepted | All fixes preserve both |
| Project config sets `summarizerContextTokens: 1000000` | .pi/shadow-compact.json | Accepted (local config) | Unchanged; with correct units the user-asserted capacity is honored as configured |

## At a glance

- **Do now**
  - `fix-stale-fail-not-reset` (P0): replace the unconditional `state.reset()` at src/index.ts:113 with the ownership-checked `state.fail(generation)`. A stale summary completion then no-ops instead of aborting a newer in-flight prepare.
  - `fix-protect-previous-checkpoint` (P1): make the trim loop in src/normalize.ts:56 never evict the promoted `previous_checkpoint`, so prior compaction context survives every trim.
  - `fix-clear-rejected-config-cache` (P2): clear the memoized `configPromise` on rejection (src/index.ts:46-50) so the next `turn_end` retries `loadConfig`; the existing dedup still toasts persistent failures once.
- **Decisions needed**
  - Pricing constant for `fix-budget-unit-conversion`: confirm `CHARS_PER_TOKEN = 4` matches Pi's context accounting and owns its re-verification. See Decision D1.
- **Do after a condition is met**
  - `fix-budget-unit-conversion` (P1): convert the token budget to a char cap at the normalizeSnapshot call site (`budget * CHARS_PER_TOKEN`). Condition: Decision D1 (pricing constant) is confirmed. Its regression test can be written now; only the constant is gated.
  - Package a repair for `stuck-preparing-empty-snapshot`: only after its re-analysis produces a contract-valid verdict and diagnosis. No repair exists this run.
- **Do not do**
  - Do not clamp `summarizerContextTokens` to models.json; that reverses accepted decision b128a77 and the override's documented purpose.
  - Do not rewrite `normalizeSnapshot` to token-based accounting; the parameter is honestly named `maxChars` and the single call site is the correct boundary.
  - Do not add retry/backoff for config loading; cache-clearing plus existing dedup is the designed semantics.
  - Do not package any repair for `stuck-preparing-empty-snapshot` in this run; its normalized record is RECOVERY_REQUIRED.
- **Research or evidence needed**
  - `stuck-preparing-empty-snapshot` (critical): recovery item from normalization. Re-run the candidate's analysis to emit a compact verdict with id and evidence and a diagnosis with id and reproduction inside field caps. No verdict, diagnosis, or repair is invented here.

## Corrections in plain language

Each section states the defect, impact, repair, evidence, tradeoffs, timing, prerequisites, interactions, validation, completion, rollback, and prior decisions, then the challenge result.

### C1 fix-stale-fail-not-reset (diagnosis stale-reset-kills-newer-prepare, critical) - VALIDATED

- Defect: when a background summary finishes after being superseded, `if (!valid || !state.publish(generation, result)) state.reset()` (src/index.ts:113) calls `reset()`, which aborts the CURRENT preparing controller and bumps the generation.
- Impact: the newer prepare's valid work is silently discarded. Zero commits, zero native fallbacks, zero toasts; soft compaction loses one full turn cycle. Probes: `.agents/artifacts/probe-stale-reset-*.ts` (e2e kill, unit isolation vs `fail()`, abort-honored boundary healthy).
- Repair: replace `state.reset()` with `state.fail(generation)`. `fail()` checks phase and generation: from a superseded position it is a safe no-op; from the current generation it takes the documented failed path (idle + `pendingNativeFallback`), identical to the adjacent catch branch at src/index.ts:116.
- Evidence: verdict PROVEN; 3 deterministic first-run probes.
- Tradeoffs: one behavior change - a result that is invalid while we still own the machine now schedules one native fallback instead of returning silently to idle. That matches the README contract ("A failed background summary schedules one ordinary native compaction at the next settle point") and replaces a silent no-op with the documented recovery.
- Timing: first, P0. No prerequisites. One-line diff plus regression test.
- Interactions: `agent_settled` already consumes `pendingNativeFallback` (one-shot via `clearPendingNativeFallback`), so no loop is possible. Manual-compaction supersession reaches `fail()` with a stale generation and no-ops.
- Validation: existing probes become regression tests: stale completion must not abort prepare #2; `fail()` from a stale generation must no-op; invalid-result-in-current-generation must schedule exactly one native fallback.
- Completion: probes green, `npm run check` green, prepare #2 completes and commits after a stale completion.
- Rollback: revert the one line; the state machine is unchanged.
- Prior decisions: follows the README fallback contract (accepted).
- Challenge:
  - Removes the cause: yes. The conflation of "superseded result" with "global invalidation" is gone.
  - Breaks valid neighbors: no. The fallback path is tested and one-shot.
  - Misses callers: no. This is the only unconditional `reset()` inside prepare. All other `reset()` calls are event-driven invalidation, which is correct.
  - Changes a contract: yes, toward the documented README behavior.
  - Opens another defect class: no. The fallback cannot loop.
- Result: VALIDATED.

### C2 fix-budget-unit-conversion (diagnosis packet-budget-unit-mismatch, major) - VALIDATED WITH CONDITIONS

- Defect: `budget = contextWindow - reservedTokens` is a token quantity (src/index.ts:78) passed as `maxChars` to `normalizeSnapshot`, whose `packetSize` counts JSON chars (src/normalize.ts:60-62). The cap binds about 4x early.
- Impact: a 200k-window model sends 24.8% of the budgeted input (probe 1: 7 of 19 items, 45628 of 183616 tokens; 75.2% of capacity unused); with `summaryMaxTokens=65536` only 19555 tokens are sent against the README-promised at least 100000; a large override can overflow the real window (probe 3: 221616 > 200000 tokens).
- Repair: at the single call site, convert units once: `normalizeSnapshot(input, budget * CHARS_PER_TOKEN)` with `CHARS_PER_TOKEN = 4` defined once next to the budget computation. `normalizeSnapshot` keeps its honest `maxChars` contract; per-item caps and the 240k default are untouched.
- Evidence: verdict PROVEN; 3 probes (e2e budget trim, README starvation, override overflow).
- Tradeoffs: larger packets mean longer summarizer prompts; that is the documented intent. An override set above the deployment's real window can still overflow - that is the user-asserted-capacity decision (b128a77), now honored with correct units instead of accidentally amplified.
- Timing: after Decision D1. Independent of C1; lands naturally with C3 (same loop's budget).
- Prerequisites: D1 pricing constant.
- Interactions: raises the cap so C3's guard rarely binds; both compose (a huge transcript can still overfill the packet).
- Validation: regression test - 200k window, evidence of about budget tokens must not trim (probe 1 input must pass untrimmed); `summaryMaxTokens=65536` must send at least 100000 tokens of evidence capacity; unit test pinning the constant.
- Completion: probe-1 input untrimmed; README promise holds; `npm run check` green.
- Rollback: revert the call-site expression and constant; no state.
- Prior decisions: follows README "input side never starves" (accepted); rejects clamping the override (b128a77 accepted, recommendation follows it).
- Challenge:
  - Removes the cause: yes. The unit mismatch at the boundary is gone.
  - Breaks valid neighbors: no. `maxChars` semantics, per-item caps, and the default are unchanged.
  - Misses callers: no. `src/index.ts` is the only production caller. Tests call `normalizeSnapshot` directly with char semantics and keep them.
  - Changes a contract: no. The function contract was already chars.
  - Opens another defect class: dense-tokenization input (CJK, roughly 1-2 chars/token) can overshoot the token budget. The failure is loud: provider error, catch, one native fallback. It is never silent.
- Result: VALIDATED WITH CONDITIONS.

#### Decision D1 (condition for C2)

- Exact choice: define `CHARS_PER_TOKEN = 4` as the single conversion constant between token budgets and char caps, and use it at the `normalizeSnapshot` call site.
- Why needed: the repair's correctness depends on the conversion factor matching Pi's context accounting; probes measured Pi pricing at about 4 chars/token. A wrong constant silently re-opens the defect in either direction.
- Options: (a) constant 4 in src/index.ts - smallest diff, single use; (b) constant exported from src/normalize.ts - reusable, slightly broader surface; (c) switch `normalizeSnapshot` to token-based accounting - larger rewrite, rejected above.
- Pros/cons: (a) minimal, KISS, trivially testable; (b) marginally better discoverability, unused generality today (YAGNI); (c) most correct long-term but riskier and unbounded.
- Risks: Pi changes its pricing or exposes true tokenization; the constant drifts. Mitigation: unit test that pins the constant with a comment naming its source; re-verify on Pi upgrades.
- Reversibility: fully reversible, one expression plus one constant.
- Applicability: only this call site today.
- Recommended: option (a).
- Deferral effect: C2 waits; C1, C3, C4 are unaffected.
- Clearing evidence: maintainer confirms 4 matches Pi's accounting, or Pi exposes exact tokenization and the constant is replaced.
- Owner: repository maintainer.

### C3 fix-protect-previous-checkpoint (diagnosis previous-checkpoint-trimmed-first, major) - VALIDATED

- Defect: `normalizeSnapshot` promotes the prior checkpoint to drafts[0] as `previous_checkpoint` (src/normalize.ts:51-53), but the trim loop `while (...) evidence = renumber(evidence.slice(1))` (lines 56-58) evicts it before any transcript evidence.
- Impact: in any session that already compacted once, an over-budget packet erases the only carrier of pre-compaction context; the new checkpoint silently omits earlier objectives and decisions; the commit still applies. Probes: unit (39,900-char checkpoint evicted as sole casualty), integration (zero checkpoint content in the packet), e2e (summarizer prompt lacks the marker, silent commit).
- Repair: compute `protectedCount = evidence[0]?.kind === "previous_checkpoint" ? 1 : 0` and trim with `while (evidence.length > protectedCount && packetSize(evidence) > maxChars)`. The checkpoint becomes unevictable; survivors renumber as today.
- Evidence: verdict PROVEN; 3 deterministic probes at unit, integration, and e2e levels.
- Tradeoffs: a pathological packet that exceeds the cap even with only the checkpoint stays over budget; downstream the summarizer may fail, which lands in the existing loud fallback path. In practice unreachable: the checkpoint is capped at 40,000 chars and the post-C2 cap is at least about 64,000 chars for a 32k window.
- Timing: with C2 (same file, same loop); after C1 in priority order.
- Prerequisites: none.
- Interactions: composes with C2; without C2 the guard still fixes eviction order at today's caps (the probe's marker fits the budget alone).
- Validation: existing probe becomes the regression test: over-budget packet must retain `previous_checkpoint` as E0001 and evict transcript items instead; no-previousSummary case unchanged.
- Completion: probe green; e2e prompt contains the prior marker after a forced trim; `npm run check` green.
- Rollback: revert the loop condition; no state.
- Prior decisions: none conflict; README's redaction/bounding behavior is preserved.
- Challenge:
  - Removes the cause: yes. The loop no longer treats the privileged checkpoint as ordinary oldest evidence.
  - Breaks valid neighbors: no. Without a prior summary the behavior is byte-identical.
  - Misses callers: no. Eviction order has no other consumer. `firstKeptEntryId` comes from the snapshot, not the packet.
  - Changes a contract: the implied "drop oldest first" narrows to "drop oldest transcript evidence first". That is the intended behavior.
  - Opens another defect class: only the theoretical over-budget-checkpoint case. It fails loudly into the documented fallback.
- Result: VALIDATED.

### C4 fix-clear-rejected-config-cache (diagnosis rejected-config-promise-cached, normal) - VALIDATED

- Defect: `configFor` memoizes `configPromise ??= loadConfig(ctx).then(...)` (src/index.ts:46-50). A rejected promise stays cached for the session; `reportedError` resets only in the success path; `session_start` is the only invalidation.
- Impact: one transient config read failure (invalid or partially written JSON, EACCES) silently disables soft compaction for the whole session; fixing the file changes nothing until restart; recurrences are deduped to silence. Probes: invalid-JSON e2e, EACCES latch with immediate `loadConfig` success after restore.
- Repair: add a rejection handler to the memo: `(...).then(onSuccess, (error) => { configPromise = undefined; throw error; })`. The next `turn_end` retries; `reportedError` dedup keeps persistent failures at one toast; success still clears `reportedError`.
- Evidence: verdict PROVEN; 3 deterministic runtime probes with the repo fixture.
- Tradeoffs: while the config is broken, every `turn_end` with usage performs one file read - negligible.
- Timing: anytime; independent.
- Prerequisites: none.
- Interactions: `session_start` invalidation unchanged; the turn_end catch is unchanged.
- Validation: regression tests from the probes: invalid JSON then fixed file must recover on the next `turn_end` without `session_start`; persistent failure toasts once; EACCES restore recovers.
- Completion: probes green as regression tests; `npm run check` green.
- Rollback: revert the handler; no state.
- Prior decisions: none; the latch was an accidental memoization idiom, not a recorded decision (no ADR, no commit, no test asserts it).
- Challenge:
  - Removes the cause: yes. The memo no longer caches the settlement as if it were success.
  - Breaks valid neighbors: no. Dedup and session invalidation are intact.
  - Misses callers: no. `turn_end` is the only `configFor` caller.
  - Changes a contract: it restores the repeatable-attempt semantics that `reportedError` was designed for.
  - Opens another defect class: no. The retry is one stat/read per turn_end and cannot loop model calls.
- Result: VALIDATED.

## Next steps

1. Decide D1 (pricing constant `CHARS_PER_TOKEN = 4`). This gates only C2; everything else can start now.
2. Land C1 (P0): one line at src/index.ts:113 plus its three regression tests. Do not also change other `reset()` call sites - they are correct event-driven invalidation.
3. Land C2 and C3 together in one commit after D1: same file and loop, plus a combined regression (over-budget packet keeps the checkpoint AND a token-sized transcript passes untrimmed). Choose one unit-repair approach: the call-site conversion (recommended) or a token-based rewrite - never both.
4. Land C4: rejection handler plus the two recovery tests (invalid JSON, EACCES).
5. Run the recovery for `stuck-preparing-empty-snapshot` (re-analysis with a contract-valid verdict and diagnosis), then package its repair in a follow-up close. C1-C4 do not depend on it.
6. Unnecessary once step 3 lands: any separate clamp of `summarizerContextTokens`, and any change to `normalizeSnapshot`'s per-item caps.

## Counts

Derived from normalized verdicts and close records:

| Count | Value | Derivation |
|---|---|---|
| selected (verdicts) | 4 | normalized verdicts |
| proven / likely / notReproduced / disproven | 4 / 0 / 0 / 0 | sums to selected |
| diagnoses | 4 | normalized diagnoses |
| corrections | 4 | one per diagnosis |
| validated / conditional / rejected | 3 / 1 / 0 | sums to corrections |
| unresolved | 0 | every diagnosis corrected |
| actionable (validated + conditional) | 4 | |
| priorities | 4 | one per diagnosis |
| P0 / P1 | 1 / 2 | P2: 1; RESEARCH: 0 |
| families | 0 | all four diagnoses are standalone causes; C2 and C3 share a file but not a cause |
| recovery preserved | 1 | stuck-preparing-empty-snapshot, not packaged |

## Traceability

| Diagnosis | Verdict | Correction | Challenge result | Priority |
|---|---|---|---|---|
| stale-reset-kills-newer-prepare | PROVEN | fix-stale-fail-not-reset | VALIDATED | P0 IMMEDIATE |
| packet-budget-unit-mismatch | PROVEN | fix-budget-unit-conversion | VALIDATED WITH CONDITIONS (D1) | P1 HIGH |
| previous-checkpoint-trimmed-first | PROVEN | fix-protect-previous-checkpoint | VALIDATED | P1 HIGH |
| rejected-config-promise-cached | PROVEN | fix-clear-rejected-config-cache | VALIDATED | P2 NORMAL |
| stuck-preparing-empty-snapshot | RECOVERY_REQUIRED (no normalized verdict/diagnosis) | none this run | n/a | Research or evidence needed |

## Action packages

### AP1 fix-stale-fail-not-reset (P0 IMMEDIATE)

- Root cause: the invalid/publish-rejected branch conflates "superseded result" with "invalidate everything" and calls the unconditional `reset()`.
- Target behavior: a stale completion is a safe no-op; a current-generation failure takes the documented native-fallback path.
- Affected: src/index.ts (prepare failure branch); consumers: `agent_settled` fallback, `session_before_compact` interception, turn_end trigger.
- Steps: change src/index.ts:113 from `state.reset()` to `state.fail(generation)`.
- Reproduction/regression: port `.agents/artifacts/probe-stale-reset-*.ts`: (1) e2e - stale completion after manual-compaction supersession must not abort prepare #2; prepare #2 commits; (2) unit - `fail()` from a stale generation no-ops while `reset()` kills the newer controller; (3) invalid result in current generation schedules exactly one native fallback.
- Boundary/concurrency: stale completion racing a newer `startPreparing`; `publish` rejected on aborted signal (unreachable without a generation bump - covered defensively); fallback one-shot via `clearPendingNativeFallback`.
- Migration/deployment: none; no config or persisted state; reload Pi after update.
- Rollback: revert the line.
- Completion criterion: all three regressions green; `npm run check` green.
- Gates: typecheck, full test suite, the three new tests.
- Residual risk: current-generation invalid results now trigger one visible native compaction instead of silence - intended per README.

### AP2 fix-budget-unit-conversion (P1 HIGH, conditional on D1)

- Root cause: a token budget passed as a char cap at the normalizeSnapshot boundary.
- Target behavior: the packet cap equals the token budget under Pi's char pricing; the README evidence guarantee holds.
- Affected: src/index.ts (one expression, one constant); consumers: normalize trim loop, summarizer prompt size.
- Steps: define `CHARS_PER_TOKEN = 4` near the budget computation; call `normalizeSnapshot(input, budget * CHARS_PER_TOKEN)`; add a unit test pinning the constant with a source comment.
- Reproduction/regression: probe-1 input (19 items, 123842 host tokens) must pass untrimmed at a 200k window; `summaryMaxTokens=65536` must leave at least 100000 tokens of evidence capacity; combined C3 test.
- Boundary/concurrency: override above real window (user-asserted capacity, b128a77); very small windows (cap still exceeds the 40k checkpoint cap); no concurrency surface (single call per prepare).
- Migration/deployment: none; larger packets only.
- Rollback: revert expression and constant.
- Completion criterion: untrimmed probe input; `npm run check` green.
- Gates: typecheck, suite, new unit + e2e tests.
- Residual risk: dense-tokenization input can overshoot the token budget; failure is loud (provider error -> one native fallback). Constant drift if Pi pricing changes.

### AP3 fix-protect-previous-checkpoint (P1 HIGH)

- Root cause: the trim loop treats the semantically privileged prior checkpoint as ordinary oldest evidence.
- Target behavior: trimming never evicts `previous_checkpoint`; it evicts oldest transcript evidence instead.
- Affected: src/normalize.ts (trim loop condition); consumers: summarizer packet, checkpoint continuity across compactions.
- Steps: compute `protectedCount` from `evidence[0]?.kind === "previous_checkpoint"`; gate the loop with `evidence.length > protectedCount`; keep `renumber` as is.
- Reproduction/regression: existing probes as tests: 39,900-char checkpoint survives a 38-char over-budget trim while transcript items are evicted; e2e prompt contains the prior marker; no-previousSummary case unchanged.
- Boundary/concurrency: packet over budget with only the checkpoint left (loop exits; over-budget packet -> loud fallback); single-threaded normalize, no concurrency.
- Migration/deployment: none.
- Rollback: revert the condition.
- Completion criterion: regressions green; `npm run check` green.
- Gates: typecheck, suite, new unit + e2e tests.
- Residual risk: a pathological checkpoint alone above the cap keeps the packet over budget; unreachable today (40k item cap vs at least 64k post-AP2 cap) and loud if hit.

### AP4 fix-clear-rejected-config-cache (P2 NORMAL)

- Root cause: the memo caches the promise settlement; failure is cached like success with no failure-path invalidation.
- Target behavior: a failed config load is retried on the next `turn_end`; a fixed file takes effect without `session_start`.
- Affected: src/index.ts (configFor memo); consumers: turn_end threshold trigger.
- Steps: add the rejection handler `(error) => { configPromise = undefined; throw error; }` to the memoized chain; keep the success path clearing `reportedError`.
- Reproduction/regression: invalid-JSON probe as test (one toast; fix file; next turn_end succeeds without session_start); EACCES probe as test (chmod 000, restore, recovery); persistent failure toasts once.
- Boundary/concurrency: concurrent `configFor` callers share one promise; rejection clears once; retry is one file read per turn_end with usage.
- Migration/deployment: none.
- Rollback: revert the handler.
- Completion criterion: recovery tests green; `npm run check` green.
- Gates: typecheck, suite, the new tests.
- Residual risk: while the config stays broken, one filesystem read per turn_end - negligible; dedup prevents toast spam.

## Recovery preservation (not packaged)

- `stuck-preparing-empty-snapshot` (critical): normalization recorded RECOVERY_REQUIRED - the iteration's verdict was a bare string without id or evidence and its diagnosis lacked id and reproduction with fields over the caps. Per the recovery rule it is preserved here verbatim in substance: "Re-run this candidate's analysis to emit a compact verdict with id and evidence and a diagnosis with id and reproduction inside field caps." No verdict, diagnosis, correction, priority, or repair is asserted for it in this run.

## Post-close resolution (2026-09-01, maintainer decisions)

- **C2 fix-budget-unit-conversion: REJECTED as intentional.** `summarizerContextTokens: 1000000` matches the Luna deployment's real 1M window; the Pi session context window is intentionally set lower to trigger more frequent compaction. The apparent overflow/under-fill is the documented user-asserted-capacity decision (b128a77). No unit conversion lands. Decision D1 is nonetheless confirmed for the record: Pi's `estimateTokens` (dist/core/compaction/compaction.js:188+) prices text at `Math.ceil(chars / 4)`.
- **C1 fix-stale-fail-not-reset: LANDED** (commit 433429f). `reset()` -> ownership-checked `fail(generation)` at the publish-rejected branch; two new regressions (stale completion keeps a newer gated prepare alive and commits; invalid-while-current schedules exactly one native fallback). One existing expectation updated: a completed-but-invalid summary after a foreign `session_compact` now schedules the documented fallback instead of discarding silently. Fixture gates became FIFO to interleave two prepares.
- **C3 fix-protect-previous-checkpoint: LANDED with a repair deviation** (commit 26bed7f). AP3's prescribed `while (length > protectedCount)` gate alone is insufficient: the loop's `slice(1)` evicts from the chronological front, where the checkpoint sits, so the first iteration would still drop it. The landed repair splices at the protected slot (`evidence.splice(protectedCount, 1)`), keeping the checkpoint and evicting the oldest transcript item. Regressions: over-budget trim keeps the checkpoint as E0001; the cap test now asserts checkpoint survival.
- **C4 fix-clear-rejected-config-cache: LANDED** (commit 37d7ce8). Rejection clears the memo so the next `turn_end` retries; recovery after a reported config failure emits one info notification; persistent failures remain deduped to a single toast.
- `stuck-preparing-empty-snapshot` remains a recovery item: still requires re-analysis before any repair.

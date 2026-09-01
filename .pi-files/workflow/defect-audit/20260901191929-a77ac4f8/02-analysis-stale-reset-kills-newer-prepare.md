# 02 Analysis - stale-reset-kills-newer-prepare

Run: `20260901191929-a77ac4f8` - Loop 1, iteration 4
Behavior: `state-machine` - Criticality: critical (copied)
Location correction: candidate cited src/index.ts:84; the failure branch is at **src/index.ts:113** (`if (!valid || !state.publish(generation, result)) state.reset();`), the ownership-checked catch at :116 (`state.fail(generation)`); lines shifted from the candidate snapshot.

## Verdict: PROVEN

Runtime-executed, deterministic, first-run pass, using the repository's own extension harness (real handlers, real state machine, real settings loading, real `prepare()`; only the model call is faked, as in every existing index test). Three probes, all in `.agents/artifacts/`.

## Expected behavior (code's own ownership contract)

- The state machine exists precisely because prepares are superseded out-of-band: `publish()` and `fail()` both refuse non-owning generations (src/state.ts; test/state.test.ts:68 "publish only for matching generation and un-aborted controller", :92, :150 "reset aborts preparing controller and stale publishes fail"). A superseded caller is a no-op by design.
- `reset()` is the documented global invalidation ("Terminal for commit success, failure, and invalidation alike") - it aborts whatever `preparing` controller is CURRENT and bumps generation. It is only correct from a context that owns or intends to discard the current state (host events, own-catch, own-invalid-result).
- src/index.ts:113's failure branch handles "my result was superseded or invalid". When the cause is supersession (generation mismatch), the caller does NOT own the current state, yet it calls unconditional `reset()`. The catch path one line later (:116) uses ownership-checked `fail()` - the asymmetry is the defect.
- README:91: a failed background summary schedules one native fallback at the next settle point. Here two summaries complete, neither commits, and no fallback is scheduled; all silently.

Given: prepare #1 in flight (gen 0) when a superseding reset fires - manual compaction, native auto-compact, or session_tree. Every such reset aborts #1 and returns the machine to idle.
When: a newer `turn_end` prepare #2 (gen 1) starts, and #1's completion then RESOLVES despite its aborted signal (slow/ignored abort),
Then: expected - #1's stale result is discarded with no state effect (ownership contract, as `fail()` would do). Actual - `publish(0, ...)` returns false and index.ts:113 calls `state.reset()`, aborting #2's live controller, bumping generation to 2, silently discarding #2's fresh valid summary, with no commit, no fallback, and no toast for the cycle.

## Reproduction

### Probe 1 - end-to-end kill (`.agents/artifacts/probe-stale-reset-kills-newer.ts`)

Command: `npx tsx .agents/artifacts/probe-stale-reset-kills-newer.ts` (repo root)
Scenario: repo `fixture()` (keepRecentTokens 30, branch e1..e4, percent 60). The fixture's gated completion ignores the abort signal - a faithful model of the candidate's declared "slow abort" transport.

1. `turn_end` -> prepare #1 (gen 0) parked on gate G1 (`calls === 1`, signal not aborted).
2. `session_before_compact` reason `manual` -> reset: signal[0] aborted, gen 1, idle.
3. Second `turn_end` -> prepare #2 (gen 1) parked on gate G2 (`calls === 2`, signal[1] not aborted).
4. Release G1 only; stale completion delivers. Branch unchanged -> `valid === true`; `publish(0, ...)` returns false on generation mismatch -> index.ts:113 `state.reset()` -> **signal[1].aborted === true**: the NEWER prepare's controller is aborted. Zero toasts, zero compact calls.
5. Release G2; #2's completion resolves; `publish(1, ...)` fails (idle) -> second reset. `agent_settled` -> `compactCalls.length === 0`: no commit, no native fallback. Both model calls wasted, silent.
6. Next `turn_end` recovers fully (commit nonce observed) - harm bounded to one cycle, matching the suspected "delayed one turn cycle".

Deterministic; PASS.

### Probe 2 - unit isolation (`.agents/artifacts/probe-stale-reset-unit.ts`)

Command: `npx tsx .agents/artifacts/probe-stale-reset-unit.ts`
Real `ShadowCompactStateController`: `startPreparing` (gen 0) -> `reset()` (supersession) -> `startPreparing` (gen 1) -> `publish(gen 0, ...)` returns false -> `reset()` -> newer controller aborted, gen 2, idle. Contrast on a second machine: `fail(gen 0)` from the same stale position returns false and leaves the newer `preparing` claim and its controller untouched. Isolates trigger/mechanism from the fixture. Deterministic; PASS.

### Probe 3 - abort-honored boundary (`.agents/artifacts/probe-stale-reset-abort-honored.ts`)

Command: `npx tsx .agents/artifacts/probe-stale-reset-abort-honored.ts`
Identical interleaving, but the completion rejects when it observes the abort - the documented behavior of the real pi-ai stack (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:488-492` throws "Request was aborted" on an aborted signal or aborted stopReason; anthropic-messages.js:252/580/598 checks per SSE message). Result: stale prepare lands in catch -> `state.fail(0)` -> ownership-checked no-op; prepare #2 survives, publishes, and commits (`compactCalls[0]` carries the commit nonce). Deterministic; PASS. This bounds the defect: only a completion that RESOLVES past abort arms the kill.

## Diagnosis

- **Trigger**: prepare #1's completion resolves successfully after its controller was aborted (slow/ignored abort) and after a newer `turn_end` prepare owns the machine. Supersession sources that reset during `preparing`: `session_before_compact` manual (index.ts:213) or threshold-mismatch auto-compact, `session_compact`/`session_compact_failed` fromExtension (:218/:221), `session_tree`/`session_shutdown`/`session_start`. With the bundled pi-ai adapters an observed abort converts to a throw (probe 3, safe path), so the trigger requires an abort-resilient/slow completion - permitted by the `CompletionInterface` contract (signal observance unenforced, summary.ts) and exactly the candidate's declared trigger.
- **Mechanism**: `publish(gen, ...)` returns false on generation mismatch; the `!valid || !publish` branch then calls unconditional `state.reset()`, which aborts the CURRENT `preparing` controller - the newer prepare's - and bumps generation. The `!valid` short-circuit arm reaches the same `reset()` without any ownership check. The killed prepare's continuation discards its valid summary; its catch sees an aborted signal and stays silent; `fail(gen)` no-ops; no fallback flag is ever set.
- **Root cause**: the failure branch conflates "my result is superseded/invalid" (a no-op under the ownership contract) with "invalidate the machine" (a global operation). It uses `reset()` where the machine's own API demands an ownership-checked terminal transition, so a stale async continuation can destroy the newer claim.
- **Counterfactual**: had index.ts:113 treated publish mismatch as a no-op (as `fail(generation)` already does at :116), probe 1's interleaving ends with prepare #2 committing at settle; the stale summary is simply discarded. Violated invariant: a superseded generation's terminal transition must not disturb the current owner (state.ts publish/fail guards; test/state.test.ts:150). Affected scope: turn_end trigger (newer prepare aborted), settle-commit (no commit and no native fallback that cycle), all silent; recovery on the next cycle.
- **Family classification**: standalone. index.ts:113 is the only `reset()` reachable from a stale async continuation; every other `reset()` site is a synchronous host-event handler acting on its own current state (by-design global invalidation) and the catch path uses ownership-checked `fail()`. No separately established sibling exists.

No fix designed; production code untouched (baseline re-verified: `npm run check` green, 106/106 tests).

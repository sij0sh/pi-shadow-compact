# 02 Analysis - stuck-preparing-empty-snapshot

Run: `20260901191929-a77ac4f8` - Loop 1, iteration 1
Behavior: `background-prepare` - Criticality: critical (copied)
Location correction: candidate cited src/index.ts:47-48; the early return is at **src/index.ts:63** (`if (!snapshot) return;`), lines shifted from the candidate snapshot.

## Verdict: PROVEN

Runtime-executed, deterministic, using the repository's own extension harness (real handlers, real state machine, real settings loading, real `prepareSnapshot`; only the summary model call is faked and is never reached).

## Expected behavior (explicit contract)

- README.md:91: "A failed background summary schedules one ordinary native compaction at the next settle point."
- Code contract (src/state.ts, test/state.test.ts:92-121): a claimed `preparing` phase must end in exactly one of `publish()` (ready) or `fail()` (idle + `pendingNativeFallback: true`); `agent_settled` turns the fallback flag into one native `ctx.compact({})`.
- `turn_end` trigger guard keys on phase: `if (state.current.phase !== "idle") return;` (src/index.ts). Therefore any `prepare()` exit that leaves `preparing` latches the whole soft-compaction feature.

Given: phase idle, usage percent at/above `softCompactThresholdPercent` (default 60),
When: `turn_end` fires while branch content since the last compaction boundary is below `keepRecentTokens` (default 20000),
Then: expected per contract - either a completed prepare (publish) or a failure that restores idle and schedules one native fallback. Actual: phase stays `preparing` forever; nothing is scheduled or reported.

## Reproduction

### Probe 1 - latch end-to-end (`.agents/artifacts/probe-stuck-preparing-latch.ts`)

Command: `npx tsx .agents/artifacts/probe-stuck-preparing-latch.ts` (from repo root)
Scenario: repo's own `fixture()` (writes `keepRecentTokens: 30`), branch `[user("hi")]` (~1 token < 30), percent 60.

1. `turn_end` at threshold -> `startPreparing()` succeeds, `prepareSnapshot` returns `undefined`, `prepare()` returns at src/index.ts:63.
2. Observed: `registry.calls === 0`, `notifications === []`, `compactCalls === []` - silent, no summary attempt, no fallback.
3. `agent_settled` -> still no compact call (contrast: the summary-error path yields `compactCalls[0] === {}`; existing test "falls back to plain native compaction after a summary model error").
4. Branch grown past `keepRecentTokens` (now summarizable) + `turn_end` -> `calls` still 0: **latched**.
5. Only escape: `session_before_compact` with reason `manual` resets; then `turn_end` prepares, settles, and commits normally.

Deterministic; PASS. Environment: Node 24.19.0, Fedora 44, repo deps (pi-coding-agent 0.84.x).

### Probe 2 - reachability under DEFAULT settings (`.agents/artifacts/probe-empty-snapshot-defaults.ts`)

Command: `npx tsx .agents/artifacts/probe-empty-snapshot-defaults.ts`

- Case A (32k-window model, no prior compaction): 5 user turns totalling 19,800 Pi-estimated tokens (chars/4) - 60.4% of 32,768, above the 60 threshold, below `keepRecentTokens` 20000. Pi's own `findCutPoint` returns `firstKeptEntryIndex === 0`, `isSplitTurn === false`; `prepareSnapshot(branch, 20000) === undefined`.
- Case B (200k-window model, first turns after a compaction): summary + kept tail + fresh turns ~= 60% usage while the since-boundary range is 18,750 tokens < 20000. `findCutPoint` cut equals the boundary; `prepareSnapshot === undefined`.

Deterministic; PASS. Host facts: `findCutPoint` keeps everything when accumulated tokens never reach the budget (`cutIndex = cutPoints[0]`), `keepRecentTokens` default 20000 (settings-manager.js:563), threshold default 60 (src/config.ts:10). Existing tests already cover the pure function: `prepareSnapshot([first, second], 1_000_000) === undefined` (test/prepare.test.ts "returns undefined when there is nothing to summarize").

## Diagnosis

- **Trigger**: `turn_end` at/above the soft threshold while content since the last compaction boundary is below `keepRecentTokens`. Realistic windows:
  - (a) small-context models: window <= ~33k with default threshold 60 and keep 20000;
  - (b) large configured `keepRecentTokens` on any window;
  - (c) early turns after any compaction: retained tail + fresh turns stay below 20000 while the carried summary pushes usage over the threshold.
- **Mechanism**: `prepareSnapshot` returns `undefined` for an empty summarizable range. `prepare()` then exits at src/index.ts:63, the only return outside the try/catch. This exit calls neither `state.fail(generation)` (which sets `pendingNativeFallback`) nor `state.reset()`. The machine stays `preparing` with a dangling AbortController and generation.
- **Root cause**: `prepare()` treats "nothing to summarize" as a non-outcome instead of a terminal one. The state-ownership invariant requires that `publish()` or `fail()` releases every claimed `preparing` phase. The early return violates it, and `turn_end`'s idle-phase guard then disables the trigger for the rest of the session.
- **Counterfactual**: had line 63 called `state.fail(generation)`, the phase would return to idle; `agent_settled` would run the documented one native fallback (which would itself hit the same keep-everything cut, so the primary harm is the latch, not the missed fallback). Affected scope: soft-trigger (all later `turn_end` no-op, silently - no toast), settle-commit (never reached), README:91 contract violated (this failure schedules nothing). Recovery only via manual compaction, Pi's own higher threshold auto-compact, or session tree/shutdown/start.
- **Family classification**: standalone. src/index.ts:63 is the sole exit that bypasses the terminal transition. Lead (unestablished sibling, same mechanism family, not separately proven): a throw from the pre-try code (`SettingsManager.create`/`prepareSnapshot`) would reject the `void prepare(...)` promise unhandled and latch identically.

No fix designed; production code untouched.

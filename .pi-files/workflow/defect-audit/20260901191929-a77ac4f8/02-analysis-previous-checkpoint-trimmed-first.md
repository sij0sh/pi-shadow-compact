# 02 Analysis - previous-checkpoint-trimmed-first

Run: `20260901191929-a77ac4f8` | Behavior: `packet-normalization` | Criticality: major (copied)
Candidate: **previous-checkpoint-trimmed-first**

## Candidate (as supplied)

`drafts` places `previous_checkpoint` first; the trim loop drops strictly from the front and
never special-cases the checkpoint. Location: src/normalize.ts trim loop (`evidence.slice(1)`).
Suspected: the prior checkpoint, the only carrier of pre-compaction context, is dropped first;
the new checkpoint silently omits earlier objectives and decisions. Trigger: packet over budget
in a session that already contains a compaction (`previousSummary` at drafts index 0). Affected
entries: turn_end.

Location check: the supplied `src/normalize.ts:41-45` is stale; the promotion sits at
src/normalize.ts:51-53 and the trim loop at src/normalize.ts:56-58. Substance confirmed.

## Expected behavior

Contract sources, strongest first:

1. **Code's own special-casing (src/normalize.ts:51-53):** `previousSummary` is promoted to
   drafts index 0 with kind `previous_checkpoint` and synthetic `sourceEntryId: "checkpoint"`.
   The test "promotes previous summary to the first previous_checkpoint evidence"
   (test/normalize.test.ts:147) pins that placement. The kind exists precisely so the prior
   checkpoint is carried into the new summary.
2. **Domain rule (src/prepare.ts:30-52):** `sourceEntries = branch.slice(boundaryStart, ...)`
   starts at the previous compaction's `firstKeptEntryId` (or after the compaction entry). All
   history before the previous compaction boundary is excluded from `entries`, so the
   checkpoint summary is the **sole carrier** of pre-compaction context in the packet.
3. **Summarizer contract (src/summary.ts:133-145):** "The checkpoint will replace OLD
   conversation history; a recent suffix remains verbatim, so cover only the supplied
   evidence." Whatever is not in the packet is durably lost once the commit applies, because
   the commit boundary sits after the old compaction entry.
4. **Trim loop invariant (src/normalize.ts:56-58):** strictly front-to-back eviction;
   `previous_checkpoint` gets no protection. The test "caps packets by dropping oldest
   evidence and keeping the newest" passes a `previousSummary` but never asserts the
   checkpoint survives - the drop is not a pinned contract.

Expected: while any newer transcript evidence survives a budget trim, the sole carrier of
pre-compaction context must not be evicted; at minimum, losing it must not be strictly
first-ordered regardless of item value. Actual: any over-budget packet evicts the checkpoint
before every transcript item.

Given/When/Then:
- Given a session that already contains a compaction (`previousSummary` present),
- and given a `maxChars` cap that the packet exceeds,
- when `normalizeSnapshot` trims to the cap,
- then the packet must still carry the prior checkpoint while newer evidence remains.
- Actual: the first evicted item is `previous_checkpoint`. The summarizer never sees the
  prior objectives and decisions. The commit then erases the old history anyway.

## Probes

All probes are deterministic (fixed inputs, no randomness, no network). Environment: repo @
8a1b03a (src/test clean), Node v24.19.0, `node --import tsx`, repo devDependencies.

### Probe 1 - unit-level minimal repro (sole casualty)

- Method: call `normalizeSnapshot` with a 39,900-char `previousSummary` (under the 40k
  TEXT_LIMIT) and two ~29,950-char user entries; `maxChars = 100_000`. Precondition: full
  packet 100,038 chars (over by 38).
- Command: `node --import tsx .agents/artifacts/probe1-checkpoint-trim-unit.ts`
- Expected (invariant): the checkpoint survives; some newer transcript item is evicted
  instead.
- Actual: trimmed packet keeps exactly 2 items (`user`, `user`, 60,048 chars). The only
  casualty is the entire prior checkpoint. `PRIOR_CHECKPOINT_MARKER` absent from the packet.
- Evidence: probe exit 0 with "sole casualty of a marginal over-budget trim is the entire
  prior checkpoint."

### Probe 2 - integration through prepareSnapshot with a real compaction entry

- Method: branch `[pre, compaction C1 (summary=26k marker, firstKeptEntryId=k1), k1, 19x26k
  bulk, tail]`; `prepareSnapshot(branch, 30)`; then `normalizeSnapshot` with the exact
  index.ts budget computation (200k window, defaults: reserved 16,384 -> cap 183,616 chars).
- Command: `node --import tsx .agents/artifacts/probe2-checkpoint-trim-prepare.ts`
- Expected: packet carries the prior checkpoint (marker) into the summary input.
- Actual: `snapshot.previousSummary` starts with the marker (upstream carrier exists), but
  the packet keeps 7 of 21 drafts (182,532 chars <= cap), first item `user "b13: ..."`, zero
  `previous_checkpoint`, marker absent. New commit boundary (branch index 22) sits after the
  old compaction entry (index 1), so the host compaction removes the old summary from
  history. Counterfactual feasibility: the marker alone is 26,000 chars << 183,616 cap.
- Evidence: probe exit 0; printed budget/drafts/kept/boundary numbers.

### Probe 3 - end-to-end through the extension (repo fixture)

- Method: same branch shape via `test/helpers/index-fixture.ts`; `setBranch`, `setPercent(60)`
  (= default threshold), `emit("turn_end")`; capture the prompt sent to `FakeRegistry`;
  then `agent_settled` and the nonce-tagged `session_before_compact`.
- Command: `node --import tsx .agents/artifacts/probe3-checkpoint-trim-e2e.ts`
- Expected: summarizer prompt contains the prior checkpoint content.
- Actual: prompt is 183,868 chars, contains neither the marker nor `previous_checkpoint`;
  branch at trigger time did contain the marker (upstream); `notifications.length === 0`
  (silent); commit proceeds (nonce matched pattern) and the served checkpoint's
  `firstKeptEntryId` ("tail", index 22) excludes the old compaction entry (index 1).
- Evidence: probe exit 0 with "prior checkpoint silently absent from the summary input;
  commit still applies."

## Verdict

**PROVEN** - three deterministic probes at three levels (unit, prepare integration, extension
end-to-end) agree: the promoted `previous_checkpoint` is always the first eviction when the
packet exceeds the cap, and the loss is silent while the commit still erases the old history.

## Diagnosis (PROVEN)

- **Trigger:** `turn_end` crosses the soft threshold in a session that already holds a
  compaction, and the packet JSON exceeds `maxChars` (the token budget passed as a char cap)
  at src/normalize.ts:56.
- **Mechanism:** the trim loop `while (packetSize(evidence) > maxChars) evidence =
  renumber(evidence.slice(1))` evicts `drafts[0]` - the special-cased `previous_checkpoint`
  promotion - before any transcript evidence, renumbering so the loss is invisible in IDs.
- **Root cause:** the budget trim treats the semantically privileged prior checkpoint as
  ordinary oldest evidence; no guard protects the sole carrier of pre-compaction context,
  even though prepare.ts guarantees nothing else in the packet predates the last boundary.
- **Counterfactual (violated invariant):** budget trimming must not evict the only carrier of
  prior-compaction context while newer transcript evidence survives; the packet is the last
  and only input from which the replacing checkpoint can be built (summary.ts:133), and the
  commit boundary erases the old summary afterward. Affected scope: every over-budget
  background summary in a post-compaction session (turn_end -> prepare -> normalize ->
  summary -> commit); the new checkpoint silently drops pre-compaction objectives, decisions,
  and state.
- **Family classification:** standalone. The mechanism (front-anchored eviction of a
  privileged item) exists only in this trim loop; no other site drops protected-priority
  items. Interaction lead (not a sibling mechanism): `packet-budget-unit-mismatch` makes
  trims fire ~4x earlier than the documented token budget, multiplying how often this loss
  occurs; fixing one does not fix the other.

No fix designed; production code untouched (git clean at 8a1b03a).

# 02 Analysis - packet-budget-unit-mismatch

Run: `20260901191929-a77ac4f8` | Behavior: `packet-normalization` | Criticality: major (copied)
Candidate: **packet-budget-unit-mismatch**

## Candidate (as supplied)

`budget = contextWindow - reservedTokens` (tokens) is passed as `maxChars`; `packetSize`
compares `JSON.stringify` chars against it. Location: src/index.ts:63-70 budget in tokens;
src/normalize.ts packetSize counts chars. Suspected: token budget read as char cap trims
evidence to about a quarter of real input capacity; inflated override can overflow the real
window. Affected entries: turn_end.

## Expected behavior

Contract sources, strongest first:

1. **README (documented requirement):** "The background summary input budget comes from the
   model's registered context window ... (`contextWindow`). If you override
   `summaryMaxTokens`, the extension still reserves at least half the context window for
   transcript evidence, so the input side never starves." The context window is denominated
   in tokens, so the transcript-evidence share is promised in tokens.
2. **Code intent (src/index.ts:69-73):** comments state the override "uses the deployment's
   real capacity" and that the extension "never reserve[s] more than half the context
   window, so the input side always retains room to work with".
3. **Host arithmetic:** Pi's own `estimateTokens` (pi-coding-agent compaction.ts) prices
   text at `ceil(chars / 4)` tokens. So a token budget `B` corresponds to roughly `4 * B`
   chars of evidence.
4. **Parameter unit:** `normalizeSnapshot(input, maxChars)` and
   `NORMALIZED_PACKET_MAX_CHARS = 240_000` are char-denominated; existing tests assert the
   default cap against `JSON.stringify(...).length`.

Expected: the evidence packet's **token** size stays within `budget` tokens (equivalently,
the char cap should be ~`4 * budget` chars under host arithmetic).
Actual: `budget` (tokens) is consumed directly as `maxChars`, so the packet is trimmed at
`budget` **chars** = ~`budget / 4` **tokens**.

Given/When/Then:
- Given a summarizer model with `contextWindow: 200_000` and default config
  (`reservedTokens = 16_384`, `budget = 183_616` tokens),
- when a turn ends above the soft threshold, and the branch normalizes to 495,368 chars of
  evidence JSON (123,842 tokens by host arithmetic),
- and that token size sits inside the 183,616-token budget,
- then the packet must keep all evidence that fits the token budget (all of it), but it
  keeps only the newest 7 items (182,512 chars = 45,628 tokens, 24.8% of budget), dropping
  the 12 oldest entries.

## Probes

All probes are deterministic (fixed inputs, no randomness, no network). Environment:
repo @ b0a3a23, Node v24.19.0, `node --import tsx`, repo devDependencies.

### Probe 1 - end-to-end through the extension (repo fixture)

- Method: drive `shadowCompact` via `test/helpers/index-fixture.ts`; 20 chained 26k-char
  user entries (19 summarized, 1 retained tail); `percent = 60`; capture the prompt sent to
  `FakeRegistry.complete`; measure the evidence JSON and host `estimateTokens`.
- Command: `node --import tsx .agents/artifacts/probe1-e2e-budget-unit.ts`
- Expected: packet token size <= 183,616 tokens; nothing dropped (full input = 123,842
  tokens fits).
- Actual: sent 7 of 19 items; evidence JSON 182,512 chars (cap bound in chars); host token
  estimate 45,628 = 24.8% of budget; `m0`..`m11` absent; 75.2% of the budgeted input side
  unused. Exit code 0, all assertions pass.
- Evidence: prompt captured from `registry.prompts[0]`; full input 495,368 chars /
  123,842 tokens would have fit entirely.

### Probe 2 - unit level + README half-window invariant

- Method: call `normalizeSnapshot` directly with the budgets derived in `prepare()` for two
  configs; price packets with host `estimateTokens`.
- Command: `node --import tsx .agents/artifacts/probe2-unit-half-window.ts`
- Expected (README): with `summaryMaxTokens: 65536`, evidence gets >= 100,000 tokens
  (half of the 200k window).
- Actual: default config sends 3..7 of 20 items at 24.8% of budget tokens;
  `summaryMaxTokens: 65536` sends 3 of 20 items = 19,555 tokens vs the promised
  >= 100,000 tokens (invariant violated ~5x). Exit code 0.
- Evidence: in both runs the cap bound in chars (`packet chars <= budget`), proving the
  unit the parameter actually enforces.

### Probe 3 - overflow facet with the project's own override value

- Method: fixture with global config `summarizerContextTokens: 1000000` (the value in this
  project's local `.pi/shadow-compact.json`) against the fixture model whose REAL window is
  200,000; 35 x 26k-char entries (34 summarized).
- Command: `node --import tsx .agents/artifacts/probe3-overflow-override.ts`
- Expected: a truthful implementation would bound the packet to the real window.
- Actual: `budget = 983,616` chars never binds; all 34 items sent (886,463 chars);
  host token estimate 221,616 > 200,000 real window (+21,616). src/index.ts:71 uses the
  override verbatim; no cross-check against `model.contextWindow`. In production the
  request fails at the provider -> `prepare` catch -> error toast + one native fallback.
  Exit code 0.

## Verdict: PROVEN

Three deterministic executions reproduce the suspected outcome with exact numbers. The cap
binds on characters while the budget is denominated in tokens; under the host's own
chars/4 pricing the packet uses ~25% of the budgeted input capacity (Probe 1), and the
README's half-window promise fails ~5x under a large `summaryMaxTokens` (Probe 2).

## Diagnosis

- **Trigger:** any `turn_end`-launched prepare whose normalized evidence JSON exceeds
  `contextWindow - reservedTokens` **characters** - i.e. precisely the large sessions the
  extension exists for - or any `summarizerContextTokens` set above the deployment's real
  window (Probe 3).
- **Mechanism:** `budget = contextWindow - reservedTokens` (tokens, src/index.ts:71-78) is
  passed as `normalizeSnapshot`'s `maxChars` (src/index.ts:85 -> src/normalize.ts:49); the
  trim loop (src/normalize.ts:56-58) drops oldest evidence while
  `JSON.stringify({evidence}).length > maxChars`. At ~4 chars/token the packet holds
  ~budget/4 tokens; the cap bites ~4x early and the surplus is silently discarded oldest
  first.
- **Root cause:** unit conflation at the caller boundary: a token-derived quantity feeds a
  character-count parameter with no conversion, while every other cap in the pipeline
  (`NORMALIZED_PACKET_MAX_CHARS`, `TEXT_LIMIT`, `bounded()`) is deliberately char-denominated.

## Counterfactual (evidenced)

If the cap were token-honoring (char cap ~ `4 x budget` under host arithmetic): Probe 1's
entire 495,368-char input (123,842 tokens) fits the 183,616-token budget and **nothing is
dropped**. Probe 2's `summaryMaxTokens: 65536` case would send ~100,000 tokens of evidence
(~400,000 chars) instead of 19,555. That satisfies the README invariant "reserves at least
half the context window for transcript evidence, so the input side never starves". Violated
invariant: README input-budget semantics + the src/index.ts:72-73 comment ("the input side
always retains room to work with"). Affected scope: every prepare on a session whose
normalized evidence exceeds `budget` chars - impact is silent checkpoint-quality
degradation (oldest context discarded though it would have fit), never a crash; the
overflow facet converts a mis-set override into a visible provider error plus one native
fallback.

## Family classification: standalone

Searched for the established mechanism (token-derived quantity consumed as a char count):
it occurs only at this call boundary. Char limits in summary.ts (`MAX_ITEM_CHARS`,
`MAX_RENDERED_CHARS`) and normalize.ts are char caps by design, not token-derived.
Lead for the report: the same under-sized cap is what activates the trim-order sibling
candidate (`previous-checkpoint-trimmed-first`, loop 3) - trimming only runs because this
cap bites ~4x early - but that candidate's mechanism (drop order, not units) is separate.

## Unknowns

- Real context window of `azure-gateway-responses/gpt-5.6-luna` (whether the local
  `summarizerContextTokens: 1000000` is truthful) - unverifiable locally; decides whether
  the overflow facet fires in this project's real usage.
- Exact deployment tokenizer: chars/token varies by content; host pricing (chars/4) is an
  estimate, and CJK-dense transcripts approach 1 token/char.

No production code was edited and no fix was designed. Analysis artifacts:
`.agents/artifacts/probe1-e2e-budget-unit.ts`, `probe2-unit-half-window.ts`,
`probe3-overflow-override.ts`.

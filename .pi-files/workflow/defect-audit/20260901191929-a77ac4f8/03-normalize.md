# 03 Normalize - Candidate Analysis Coverage (run 20260901191929-a77ac4f8)

Inputs: declared `scope` (5 candidates) and `iterations` (5 records) from `candidate-analyses`.
Method: compare candidate-id sets, validate each immutable iteration output against the
compact verdict/diagnosis contract, flatten only valid records verbatim, and emit recovery
for unusable ones. No new findings, reproductions, or diagnoses were created here.

## 1. Coverage ledger

Scope ids vs iteration ids: set-equal, each accounted for exactly once, no extras, no
duplicate iteration items.

| # | candidate | criticality (scope) | state | verdict id |
|---|-----------|--------------------|-------|------------|
| 1 | stuck-preparing-empty-snapshot | critical | RECOVERY_REQUIRED | - |
| 2 | packet-budget-unit-mismatch | major | ANALYZED | packet-budget-unit-mismatch-verdict |
| 3 | previous-checkpoint-trimmed-first | major | ANALYZED | previous-checkpoint-trimmed-first |
| 4 | stale-reset-kills-newer-prepare | critical | ANALYZED | stale-reset-kills-newer-prepare |
| 5 | rejected-config-promise-cached | normal | ANALYZED | rejected-config-promise-cached |

Counts: coverage 5/5 scope candidates; verdicts 4; diagnoses 4; recovery 1.
Every ANALYZED entry carries exactly one verdict; every retained verdict (all PROVEN)
carries exactly one diagnosis; the RECOVERY_REQUIRED entry carries none, as required.

## 2. Flattened verdicts (evidence preserved verbatim)

| verdict id | candidate | criticality | verdict | evidence (verbatim) |
|---|---|---|---|---|
| packet-budget-unit-mismatch-verdict | packet-budget-unit-mismatch | major | PROVEN | Probe 1 e2e: budget 183616 tokens applied as char cap; 7/19 items sent, 45628 host-estimated tokens = 24.8% of budget; full input 123842 tokens fit. |
| previous-checkpoint-trimmed-first | previous-checkpoint-trimmed-first | major | PROVEN | 3 deterministic probes: over-budget packet evicts previous_checkpoint first; e2e summarizer prompt lacks prior marker; commit still applies. Marker fits the budget alone. |
| stale-reset-kills-newer-prepare | stale-reset-kills-newer-prepare | critical | PROVEN | 3 deterministic first-run probes (.agents/artifacts/probe-stale-reset-*.ts): e2e kill, unit isolation vs fail(), abort-honored boundary healthy |
| rejected-config-promise-cached | rejected-config-promise-cached | normal | PROVEN | 3 deterministic runtime probes with the repo fixture: invalid-JSON and EACCES triggers latch configPromise for the session; fixed file ignored; recovery only after session_start |

Nested iteration records omit `criticality`/`candidate`; both are present at each record's
top level and match scope, so they were filled from the record. No values were rewritten,
truncated, or strengthened.

## 3. Flattened diagnoses

| diagnosis id | candidate | reproduction | family |
|---|---|---|---|
| packet-budget-unit-mismatch-diagnosis | packet-budget-unit-mismatch | probe1-e2e-budget-unit | standalone |
| checkpoint-evicted-before-evidence | previous-checkpoint-trimmed-first | probe1-checkpoint-trim-unit | standalone |
| stale-reset-kills-newer-prepare | stale-reset-kills-newer-prepare | probe-stale-reset-kills-newer | standalone |
| latched-rejected-config-promise | rejected-config-promise-cached | probe1-rejected-config-promise-cached | standalone |

Full mechanism/rootCause/trigger text lives in the per-candidate `02-analysis-*.md` reports.

## 4. Recovery ledger

| candidate | reason | nextStep |
|---|---|---|
| stuck-preparing-empty-snapshot | Verdict is a bare string without id or evidence; diagnosis lacks id and reproduction and exceeds field caps; no contract-valid compact record to flatten. | Re-run this candidate's analysis to emit a compact verdict with id and evidence and a diagnosis with id and reproduction inside field caps. |

Detail (iteration 1 of `candidate-analyses`, candidate `stuck-preparing-empty-snapshot`):

- `verdict` is the bare value `"PROVEN"`, not a compact record: no `id`, no `evidence`
  value exists to preserve. Flattening would require fabricating evidence.
- `diagnoses[0]` has no `id`, no `reproduction` (an off-contract `counterfactual` key
  instead), and `rootCause` (246), `trigger` (295), `mechanism` (268) exceed the 192-char
  caps. Trimming would alter immutable analysis content.
- Per normalization rules, this emits one RECOVERY_REQUIRED coverage entry plus one
  truthful recovery record; normalization completes for this candidate without a rewrite
  demand and without adding findings. The candidate remains a scope-selected critical
  candidate awaiting a contract-valid analysis record downstream.

## 5. Reference-validation ledger

- Candidate ids: all 5 resolve to `scope.candidates`; no unknown ids retained.
- Criticalities: all 5 match scope exactly (critical, major, major, critical, normal).
- Verdict ids: unique within `verdicts` (4/4) and pattern-valid.
- Diagnosis ids: unique within `diagnoses` (4/4) and pattern-valid.
- Reproduction references: 4/4 present and pattern-valid, each attached to its own
  candidate's diagnosis.
- Verdict enums: 4/4 `PROVEN`; diagnosis presence agrees with retained verdicts.
- Collection sizes: coverage 5, verdicts 4, diagnoses 4, recovery 1 - all within the
  8-item cap.

Result: normalization complete. 4 candidates ANALYZED (all PROVEN), 1 candidate
RECOVERY_REQUIRED.

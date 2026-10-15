# Pi Shadow Compact

A Pi extension that keeps long coding sessions working without making
the coding agent manage its own memory. It is a real compactor, not a
tools-plus-memory shim: when compaction fires, Shadow answers with a
**verified structured checkpoint plus the exact recent tail**
(original messages kept verbatim, no gaps), instead of Pi's native
summary.

The acting model gets no context-management tools.

## Native vs Shadow

Native compaction writes a prose summary of what it saw. Shadow writes a
checked checkpoint: every claim points at saved session entries, tested work
is marked verified, untested work stays unverified, and the checkpoint names
exactly how far it covers. A second agent checks the first. If the check
fails, the session falls back to native compaction.

The example is synthetic and shows the same session on each side, so
compare shape, not size. Task and paths are generic on purpose.

<div align="center">

<img src="./docs/images/comparison-full-checkpoint.svg" width="100%" alt="Synthetic example: native prose versus Shadow checkpoint across all 12 checkpoint sections for adding CSV export to a notes app" />

</div>

| Area | Native | Shadow |
|---|---|---|
| Grounding | Prose, no links | Each claim cites entries (`E0004` ...) |
| Tested vs untested | Same voice | `[verified]` vs `[unverified]` ledger |
| Resume pointer | Buried in prose | Goal, approach, next step |
| Coverage proof | None | `coverageEndEntryId` in live transcript |
| Failure mode | Always installs prose | Falls back to native when unsafe |

<details>
<summary>Text version of the example</summary>

Synthetic session — add CSV export (`src/notes/export.ts`). Left column:
what native prose provides per area. Right column: the Shadow checkpoint.

```text
Native: "Add CSV export to notes app. Updated export logic and wired
the button. Tests were run and things look good. Remaining work
is handled. See prior files for details."

Shadow:
## Objective
- Add CSV export, UTF-8 + commas [E0004]
## Constraints
- Keep JSON export working; bundle size stays flat [E0006]
## Completed Work
- Serializer written; Export button wired [E0012]
## Current State
- Serializer done; Excel import untried [E0023]
## Decisions
- RFC-4180 quoting, not ad-hoc escaping [E0015]
## Open Issues
- Excel import of quoted commas not tried [E0031]
## Next Actions
- Open output in Excel, then merge [E0031]
## Critical Context
- Export path: export.ts via export-button.tsx [E0004]
## Modified Files
- src/notes/export.ts, src/notes/export-button.tsx [E0012]
## Referenced Files
- tests/notes-export.test.ts, 14 passed [E0023]
## Verification State
- [verified] export tests, 14 passed [E0023]
- [unverified] Excel import not tried [E0031]
## Continuation
- Goal: ship an export Excel opens cleanly
- Approach: verify in Excel, then merge
- Next: open notes.csv in Excel
Coverage through E0031. Builder + verifier; fails closed to native.
```
</details>

## How it works

```text
session grows ──► whole-session reads (paged turns, stable evidence ids)
prepare at 60% ──► private builder agent (read-only tools over durable history)
                ──► private verifier agent (independent re-read)
                ──► verified checkpoint + coverage boundary
next safe request ──► request-local swap: [checkpoint] + [exact tail, no gaps]
/compact + thresholds ──► canonical Pi compaction with Shadow summary when covered
no/invalid checkpoint ──► Pi native compaction (fail closed)
```

- **Whole-session reads.** The builder starts from a compact manifest
  (turn list with correction/error flags, coverage anchors, required
  turns), then pages through turn ranges and searches history through
  read-only tools. Stable evidence IDs are assigned per session position.
  Later checkpoints re-ground on original evidence, never recursively on
  the last summary.
- **Builder → verifier.** Two private passes run outside the coding loop
  with no memory tools visible to the acting model. Both must inspect the
  first turn, every correction and error turn, and everything since the
  previous coverage boundary. Unknown evidence references, uninspected
  ranges, and unsupported success claims are rejected; an `unusable`
  verifier verdict fails closed.
- **Swap + compaction.** A ready checkpoint serves the next safe request
  as a request-local swap: checkpoint plus every message after the
  coverage boundary, at least `recentTurns` response/tool rounds, and the
  frozen trigger-time overlap. A partly covered round stays verbatim so
  no reply or tool output disappears. Real `/compact` and automatic
  compactions use Pi's prepared cut and `compaction.keepRecentTokens`;
  Shadow supplies the summary only when its coverage includes everything
  Pi will discard and the result shrinks the working context.
- **Thresholds.** Preparation starts at 60% context usage, with rolling
  refresh re-arming after a Shadow install followed by below-checkpoint
  context, or after native compaction. The swap threshold (80%) is a
  compatibility/telemetry threshold, not a readiness gate: a ready
  checkpoint serves even below it. At 92% one native compaction is queued
  at the next safe idle point. Idle settle with at least
  `idleCompact.minimumTokens` (default 20,000) past the checkpoint's
  coverage prepares a fresh checkpoint so `/compact` and reloads start
  current.
- **Persistence.** Verified checkpoints persist as Pi extension state; the
  raw append-only session history remains the durable evidence source. On
  reload Shadow restores the newest checkpoint still valid for the
  current branch. Stale checkpoints on incompatible branches are skipped.

## Install

```bash
pi install git:github.com/sij0sh/pi-shadow-compact
```

Update or remove:

```bash
pi update git:github.com/sij0sh/pi-shadow-compact
pi remove git:github.com/sij0sh/pi-shadow-compact
```

Requires Node 22.19+. Development and integration tests target Pi 1.0.4.

## Commands

| Command | Behavior |
|---|---|
| `/shadow-compact [instructions]` | Start background preparation without aborting acting work; instructions guide only the private builder and verifier |
| `/compact-native` | Bypass Shadow for the next compaction (pure Pi, token-cap recovery disabled) |

## Configuration

Global configuration:

```text
~/.pi/agent/shadow-compact.json
```

Optional project configuration (takes precedence):

```text
<project>/.pi/shadow-compact.json
```

See `.pi/shadow-compact.example.json` for the full schema. Blank provider
and model IDs use the model already running the session.

| Setting | Default | Behavior |
|---|---|---|
| `prepareThresholdPercent` | `60` | Start background checkpoint preparation |
| `swapThresholdPercent` | `80` | Compatibility/telemetry threshold; never delays a ready checkpoint |
| `nativeFallbackThresholdPercent` | `92` | Queue one native compaction at the next safe idle point |
| `recentTurns` | `10` | Minimum recent response/tool rounds kept verbatim |
| `summarizerModel` / `verificationModel` | blank | Checkpoint builder/verifier models; blank reuses the session model, blank verifier reuses the summarizer |
| `thinkingLevel` / `verificationThinkingLevel` | `medium` / unset | Drafting and verification reasoning; verifier falls back to drafting level |
| `summaryMaxTokens` | unset | Per-response generation cap; unset uses the model/provider limit |
| `idleCompact` | enabled, `20000` | Prepare a fresh checkpoint on idle settle past coverage |
| `manualCompactMode` | `shadow` | `shadow` or `native` for manual `/compact` |

Legacy `softCompactThresholdPercent` / `hardCompactThresholdPercent` keys
still load as aliases for the prepare / swap thresholds.

`manualCompactMode: "native"` uses Pi's original summarizer first, with one
evidence-backed token-cap recovery. Either way, `/compact-native` runs one
purely native compaction.

## Beyond native

- **Request-local mid-turn swaps.** Pi can rewrite an individual model
  request without touching canonical history, so a ready checkpoint serves
  the next safe request immediately — no extra assistant response, no
  manual compaction call to force installation. A request already sent to
  a provider cannot change retroactively.
- **Native-summarizer token-cap recovery.** When a wrapped native fallback
  hits its output cap, one "compress and complete" recovery runs instead
  of installing partial prose. The recovery builder gets only the sanitized
  visible draft as an explicitly incomplete aid, re-reads the frozen
  session history, and an independent verifier checks the replacement
  before installation. A second cap, provider failure, or failed
  verification cancels the compaction and keeps the prior context intact.

## Develop

```bash
npm ci
./scripts/verify
```

`./scripts/verify` runs the TypeScript typecheck, test suite, and bundle
build. `npm run check` runs only the typecheck and test suite.

## License

MIT.

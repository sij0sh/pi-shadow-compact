# pi-shadow-compact

> **Self-repairing context maintenance for long-running Pi sessions.**
>
> Shadow Compact prepares continuation checkpoints from the durable session
> record, rather than treating the model's current context as the complete
> history of the work.

## The context window is not the session

A long-running coding session accumulates more history than a model should
reason over at once.

Compaction solves part of that problem by replacing older conversation with a
smaller continuation summary. It also creates a second problem. Lost
information can accumulate. If one compaction forgets a constraint, a decision,
an error, or a discovery, the next compaction sees only that summary plus newer
conversation. The missing detail is gone from its evidence too. No later
summary can recover what an earlier summary failed to preserve.

Run a session long enough and the active context becomes a compressed copy of
a compressed copy of a compressed copy. Each generation inherits every omission
made before it.

Shadow Compact does not assume that the current context window is the
authoritative record of the session. When it prepares a new continuation
checkpoint, it works from a normalized view of Pi's durable session record.
That record can contain evidence the active context no longer has, because an
earlier compaction omitted it.

This gives later compactions a chance to self-repair. An important detail
dropped from one checkpoint is not necessarily lost from every checkpoint after
it. The model stopped seeing it. The record did not.

```text
ordinary recursive compaction

history
   |
   v
summary A + tail
   |
   v
summary B + tail
   |
   v
summary C

an omission in A becomes an omission in every descendant
```

```text
Shadow Compact

             durable session record
               /      |      \
              /       |       \
             v        v        v
       checkpoint A   |   checkpoint C
                      |
                checkpoint B

each checkpoint can be rebuilt from normalized historical evidence
rather than only from its predecessor
```

Smaller context is not the goal in itself. The goal is a useful working set
that can be rebuilt from a richer historical record when earlier compression
was imperfect.

## Context engineering instead of transcript accumulation

A session holds two different things. Active context is what the model should
reason over now. Durable history is the evidence of what happened throughout
the session.

Keeping the entire durable history active eventually buries the model in
context. Discarding it entirely after summarization makes compression mistakes
irreversible.

Shadow Compact separates the two. The model receives a compact continuation
checkpoint plus Pi's recent retained tail. Shadow Compact generates that
checkpoint from normalized historical evidence. The underlying session stays
the richer record that future checkpoints are built from.

Compaction becomes an output of the session record, not the new authority on
everything that came before it.

## Behavior

1. Pi works normally.
2. Crossing the soft threshold starts one background summary. The run never stops or waits for it.
3. When the summary is ready, the next request silently uses it: summary first, then Pi's retained recent tail. No compact runs yet.
4. When the agent next goes idle, the checkpoint is appended to the session as extension state (a `CustomEntry`, invisible to the model). Raw history stays untouched; the serving checkpoint keeps swapping. No summary model call runs on that path.
5. The session continues on the small context.
6. Rolling refresh: the published checkpoint keeps serving while its replacement prepares. Once the swapped working set grows back across the soft threshold, a new preparation starts and its result replaces the old checkpoint. Each idle settle persists whichever checkpoint is latest.

The refresh gate has hysteresis: a trigger disarms it, and only an observed swap followed by below-soft context re-arms it. If a refresh cycle leaves context above soft, the next crossing is logged and suppressed instead of spinning. An empty snapshot suppresses until the working set grows meaningfully. A failed replacement keeps the serving checkpoint; a failure with nothing serving schedules one native compaction.

The mid-run request swap touches only the message list Pi sends to the model, so an active agent run is never aborted. The durable write waits for idle so it never races the run, and it never calls `ctx.compact()`: native compaction is the emergency path only (hard threshold or unsafe summarization). On `session_start` the extension restores the latest still-valid persisted checkpoint, so the first request after a reload already gets the summary plus the recent tail.

Status toasts announce each step: summary ready, a summary that misses a settle point, and hard-threshold native compaction.

## Configuration

The extension reads `<project>/.pi/shadow-compact.json` first, then `~/.pi/agent/shadow-compact.json`. The later file wins wholesale. Without files it uses the defaults below.

Copy the tracked example into your project and edit it. Git ignores `.pi/shadow-compact.json` so personal model choices never get committed:

```bash
mkdir -p .pi
cp .pi/shadow-compact.example.json .pi/shadow-compact.json
```

```json
{
  "softCompactThresholdPercent": 60,
  "hardCompactThresholdPercent": 80,
  "summarizerModel": {
    "provider": "",
    "id": ""
  }
}
```

### Soft threshold

`softCompactThresholdPercent` accepts `1` through `99`. The default is `60`.

Background summarization starts at this level. The actual compact lands slightly above it, depending on how much context Pi adds while the summary runs.

### Hard threshold

`hardCompactThresholdPercent` accepts `1` through `99`, must be greater than the soft threshold, and defaults to `80`.

At this level the extension stops waiting for the detached summary: it aborts any summary still in flight and queues one ordinary native compaction. The queue runs once the agent is idle, so the active run is never interrupted. A published checkpoint keeps serving meanwhile, but it does not disable the hatch: reaching hard means the served working set is already too large despite it. Use it as a deadline when sessions grow fast or the summarizer model is slow.

### Environment overrides

`SHADOW_COMPACT_SOFT_THRESHOLD_PERCENT` and
`SHADOW_COMPACT_HARD_THRESHOLD_PERCENT` override the file thresholds when set
to a number from `1` to `99`. Empty or unset values are ignored. The merged
pair must still satisfy hard greater than soft; a violation reports an error
instead of compacting. Overrides are intended for ephemeral use such as
benchmark harnesses, where per-run configuration cannot be written to the
project or global config files.

`SHADOW_COMPACT_ROLLING` disables rolling refresh when set to `0`, `false`,
`no`, or `off` (default is rolling on): an already-published checkpoint is
never refreshed within the run — exactly one checkpoint per session. This is
the single-shot control condition for Control-vs-Single-vs-Rolling
experiments.

`SHADOW_COMPACT_TARGET_TAIL_PERCENT` is an experimental harness knob (not a
file setting): when set to a number from `1` to `99`, Shadow keeps roughly
that share of the session model's context window as verbatim recent history
after the checkpoint boundary, capped at Pi's `keepRecentTokens` so an
absent or oversized target leaves behavior unchanged. Without it the soft
trigger and the cut boundary are incoherent on small trajectories: the
trigger can fire while the whole branch still fits inside Pi's keep window,
leaving nothing to summarize. Empty or unset values are ignored.

`SHADOW_COMPACT_MODE=observe` is an observe-only instrumented control:
`turn_end` still emits the `turn_usage` telemetry series, and everything
else (summaries, swaps, compactions, cache reads) stays disabled. It gives
context-AUC a control baseline without perturbing the working set.

### Summarizer model

Blank `provider` and `id` use the current Pi session model.

To pin a model, set both fields to an exact provider key and model ID. This includes models from `~/.pi/agent/models.json`:

```json
{
  "softCompactThresholdPercent": 60,
  "summarizerModel": {
    "provider": "my-provider",
    "id": "my-model-id"
  }
}
```

Model IDs can contain `/` or `:`, so provider and ID use separate fields.

### Optional summarizer tuning

```json
{
  "summaryMaxTokens": 32768,
  "thinkingLevel": "high"
}
```

- `summaryMaxTokens` caps the summary response. The default is `4096`, clamped to the model's own output limit. Raise it only for very large sessions.
- `thinkingLevel` forwards a reasoning level (`minimal` through `max`, or `off`) to reasoning models. It is ignored for non-reasoning models.

The background summary input budget comes from the model's registered context window in `~/.pi/agent/models.json` (`contextWindow`). If you override `summaryMaxTokens`, the extension still reserves at least half the context window for transcript evidence, so the input side never starves.

Reload Pi after changing either file.

## Safety and native fallback

The summarizer sees a bounded, redacted transcript: thinking blocks, images, provider metadata, and common secret formats are removed. Tool evidence keeps bounded output, diffs, and exit state so discoveries survive.

Every checkpoint item must cite evidence IDs from the packet. Code validates the citations and renders the Markdown. One corrective retry follows a single invalid response.

Pi's built-in compaction takes over whenever the custom path is not safe:

- Context jumps from below the threshold straight to overflow.
- The prepared history exceeds the summarizer model's budget.
- The model errors, aborts, hits its output limit, or returns invalid JSON twice.
- The session branches or compacts while the summary runs.
- A prepared boundary no longer matches Pi's native boundary.
- There is nothing to summarize yet, so preparation suppresses until the working set grows instead of latching.

A failed background summary schedules one ordinary native compaction at the next settle point. It never retries in a loop and never cancels Pi's overflow recovery.

## Install

Requires Node.js 22.19+ and Pi 0.84.4+.

From GitHub:

```bash
pi install git:github.com/sij0sh/pi-shadow-compact
```

From npm:

```bash
pi install npm:pi-shadow-compact
```

The extension ships as TypeScript source. Pi loads it through its own loader. No runtime dependencies.

Update:

```bash
pi update git:github.com/sij0sh/pi-shadow-compact
```

Uninstall:

```bash
pi remove git:github.com/sij0sh/pi-shadow-compact
```

## Limitations

Pi exposes no public API that silently rewrites live session history. The background summary is invisible, and the durable checkpoint is a plain session append (`pi.appendEntry`), so the soft path never shows compaction status and never disturbs the extension runtime. Only the hard-hatch native fallback uses Pi's compaction API.

The soft threshold is detected at `turn_end`, the first event where final token usage exists. Usage inside a streaming response is not yet final.

Secret redaction is heuristic. Keep secrets out of conversation history.

## Observability

The extension keeps an extension-local lifecycle trace that never enters
session history, so measuring never perturbs the working set:

- `SHADOW_COMPACT_TRACE`: appends JSON lines to a file (local runs).
- `SHADOW_COMPACT_TRACE_STDERR`: when set to anything but `""`, `"0"`, or
  `"false"`, the same lines go to stderr prefixed with
  `shadow-compact-trace `. The roast harness captures agent stderr per trial,
  which makes the mid-run swap observable in benchmark artifacts.

Events: `turn_usage`, `threshold_crossed`, `prepare_started`,
`prepare_completed` (with summarizer input/output/cache usage, model, wall
time, and packet size), `prepare_failed`, `checkpoint_published`,
`swap_applied` (first-swap flag, messages before/after/dropped, pre-swap
context), `checkpoint_rearmed`, `checkpoint_persisted`, `checkpoint_restored`,
`checkpoint_restore_rejected` (with the staleness reason), and
`native_fallback`. Joining `swap_applied` with the next `turn_usage` gives
per-checkpoint swap reduction (`1 - postSwap / preSwap`); summing
`turn_usage` context tokens gives area under the trajectory.

## Development

```bash
npm ci
npm run check
```

`check` runs the type checker and the full test suite.

# pi-shadow-compact

Silent soft-threshold compaction for Pi.

Pi runs normally. When context usage first reaches your soft threshold, the extension summarizes the session in a detached background request. Nothing blocks, aborts, or waits. As soon as the summary is ready, the next `turn_end` swaps old history for the checkpoint through one fast native compaction, even mid-run. Context drops to roughly system prompt + summary + recent tail.

## Behavior

1. Pi works normally.
2. The first persisted `turn_end` at or above the soft threshold starts a detached background summary.
3. Pi continues turns, tools, and steering while the summary runs.
4. The first `turn_end` after the summary is ready applies the prepared checkpoint. Long continuous runs no longer defer the swap to the run's settle point.
5. One nonce-tagged `ctx.compact()` applies the prepared checkpoint. No summary model call runs on that path.
6. The next prompt starts small: summary plus Pi's retained recent tail.

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

At this level the extension stops waiting for the detached summary: it aborts any summary still in flight and runs one ordinary native compaction immediately. Use it as a deadline when sessions grow fast or the summarizer model is slow.

Committing a summary at a mid-run `turn_end` uses Pi's manual compaction path, which ends the active run at that point, exactly like running `/compact` yourself. The completed turn is never lost; only the run's continuation stops.

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
- There is nothing to summarize yet, so the trigger re-arms instead of latching.

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

Pi exposes no public API that silently rewrites live session history. The background summary is invisible, but the final durable swap uses Pi's public compaction API, so Pi may briefly show compaction status. The cached summary keeps that operation instant; it performs no model call.

The soft threshold is detected at `turn_end`, the first event where final token usage exists. Usage inside a streaming response is not yet final.

Secret redaction is heuristic. Keep secrets out of conversation history.

## Development

```bash
npm ci
npm run check
```

`check` runs the type checker and the full test suite.

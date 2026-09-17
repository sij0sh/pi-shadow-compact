# pi-shadow-compact

Long Pi sessions eat context. This keeps them going without getting in the way.

Pi already compacts when things get full. That works, but it has a weak spot: each summary is built from the last summary. If something important gets dropped once, it's gone for good. Later summaries can't recover what they never saw.

Shadow Compact does the boring thing instead. Around 60% context, it builds a checkpoint from the actual session history in the background, double-checks it, and quietly swaps it in. You keep working. The model just sees a short checkpoint plus your recent messages.

No new tools. No new workflow. Just a smaller working set.

## Why another compactor?

Honestly, because the other ones annoyed me.

Most context extensions add tools to Pi: search your memory, recall this, decompress that. Every tool sounds useful in isolation. In practice each one is another schema in context on every turn, and another decision the model has to make instead of doing your work.

That's the exact trade I keep seeing — a tool rescues one session and taxes the other ninety-nine.

So this one adds zero tools to the acting model. Not one. Context maintenance happens in the background with separate model calls, and the agent never sees them. The only extra tokens in your session are the checkpoint itself.

If you like the memory-palace approach with lots of recall tools, this isn't that. This is the lean alternative.

## What it actually does

1. You work normally until context hits the soft threshold (60% by default).
2. Shadow snapshots what would get compacted and hands it to a background summarizer.
3. A second background model checks the draft against the evidence. It looks for dropped constraints, fake "tests passed" claims, stale facts, missing files and errors — then fixes or rejects the draft.
4. The verified checkpoint swaps in on the next request: checkpoint + your recent conversation, verbatim.
5. When context fills up again, it builds a fresh one from history — not from the last checkpoint. So a miss in one checkpoint doesn't have to haunt you forever.

Your run never pauses. If anything looks unsafe, it fails closed and lets Pi's normal compaction handle it.

## Install

Needs Node 22.19+ and Pi 0.84.4+.

```bash
pi install npm:pi-shadow-compact
```

Or from GitHub:

```bash
pi install git:github.com/sij0sh/pi-shadow-compact
```

Update / remove:

```bash
pi update git:github.com/sij0sh/pi-shadow-compact
pi remove git:github.com/sij0sh/pi-shadow-compact
```

No runtime dependencies. It's just TypeScript source.

## Configuration

Config lives in `~/.pi/agent/shadow-compact.json`, optionally overridden by `<project>/.pi/shadow-compact.json`. Project wins wholesale when both exist. Reload Pi after editing.

The defaults are fine for most people:

```json
{
  "softCompactThresholdPercent": 60,
  "hardCompactThresholdPercent": 80,
  "summarizerModel": { "provider": "", "id": "" }
}
```

Blank provider/id just means "use whatever model I'm already running."

Two knobs worth knowing:

- `softCompactThresholdPercent` (default 60) — when background work starts.
- `hardCompactThresholdPercent` (default 80) — the emergency line. Hit this and Shadow stops being clever and queues one normal Pi compaction when idle.

Want different models for the two background passes? This is the one place to get fancy:

```json
{
  "summarizerModel": { "provider": "", "id": "" },
  "verificationModel": { "provider": "", "id": "" },
  "thinkingLevel": "medium",
  "verificationThinkingLevel": "high",
  "summaryMaxTokens": 8192
}
```

A common setup is fast model to draft, stronger model to verify. If you leave the verifier blank it just reuses the summarizer. Neither shows up in your tools or conversation.

## When it backs off

Shadow would rather do nothing than publish a bad checkpoint. It hands control back to Pi's native compaction when:

- context is about to overflow,
- the summarizer or verifier fails, gets aborted, or returns garbage twice,
- the branch changed mid-preparation,
- or it hit the hard threshold.

A bad replacement never evicts a good checkpoint that's already serving.

One caveat: once Pi does a native compaction, that's the new boundary. Shadow can only rebuild from history on its side of that line. That's why native is the emergency path here, not the normal one.

## The honest costs

- Each refresh costs two background model calls. You're trading acting-model context for background inference.
- The verifier is still a model. It catches a lot, but a checked summary isn't a proven fact.
- Evidence sent to the background models is bounded and normalized (thinking blocks, images, and obvious secrets stripped, big outputs truncated). Huge histories may not fit every detail into one packet.
- Secret redaction is heuristic. Don't paste credentials into the session and assume you're safe.
- Threshold detection happens at turn end, not mid-stream.

## Debugging

Set this to watch what it's doing without polluting your session:

```bash
SHADOW_COMPACT_TRACE=/tmp/shadow.jsonl
# or
SHADOW_COMPACT_TRACE_STDERR=1
```

You'll get JSONL events for threshold crossings, prep start/finish, swaps, fallbacks, and restores. Useful if you want to check whether it's actually saving context or just spending tokens.

## Dev

```bash
npm ci
npm run check
```

`check` runs typecheck + tests.

MIT. See [LICENSE](LICENSE).

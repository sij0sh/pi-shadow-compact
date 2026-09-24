# pi-shadow-compact

**Verified, low-overhead context compaction for Pi.**

Long coding sessions eventually fill the context window. Pi's native compaction keeps them running, but any summary-based compactor has a basic failure mode: if an important constraint, decision, error, or unfinished task disappears from a summary, later summaries may inherit the omission.

Shadow Compact is designed around that problem.

It prepares a **verified continuation checkpoint from session evidence**, keeps the recent conversation verbatim, and swaps the checkpoint into the working context without giving the acting agent any memory-management tools.

The goal is simple:

> Keep the active context small and useful without making the coding agent manage its own memory.

## Why Shadow Compact?

Many context-management extensions expose tools for searching memory, recalling old messages, decompressing context, or maintaining a separate memory store.

Those capabilities can be useful, but they also become part of the acting model's job. Every additional tool adds schema to the context and another decision the model may need to make while it is supposed to be coding.

Shadow takes a different approach.

**The acting model gets no context-management tools at all.**

Checkpoint construction, evidence retrieval, verification, persistence, and replacement happen outside the normal coding loop. The model doing the actual work sees only:

```text
verified continuation checkpoint
+
recent conversation verbatim
```

No memory-search tool. No compression tool. No recall workflow.

## What makes it different

Shadow is not just "ask another model to summarize the conversation."

A checkpoint goes through an evidence-grounded pipeline designed specifically for coding-session continuity:

```text
whole durable session
      ↓
session manifest (turns, flags, coverage anchors)
      ↓
agent pages + searches history through read-only tools
      ↓
checkpoint draft (typed submit, validated)
      ↓
independent verifier agent re-reads history, audits the draft
      ↓
verified checkpoint + coverage boundary
      ↓
recent conversation remains verbatim (no-gap tail)
```

The checkpoint explicitly tracks things such as:

* the user's objective and corrections
* constraints and preferences
* completed work and its verification state
* current implementation state
* decisions and rationale
* failed approaches worth remembering
* unresolved errors and blockers
* next actions
* exact identifiers needed to continue
* modified and relevant files

Claims such as "tests passed", "the build succeeded", or "the bug is fixed" are treated as high-risk and are checked against the available evidence before the checkpoint is accepted.

If checkpoint preparation cannot produce something trustworthy, Shadow fails closed rather than publishing an untrusted state.

## Whole-session reads instead of blind truncation

A summarizer still has a finite context window.

Shadow does not solve that with a bounded evidence packet that silently drops whatever does not fit. The checkpoint builder runs as an agent over the whole durable session: it starts from a compact manifest (turn list with correction/error flags, coverage anchors, required turns), then pages through turn ranges and searches history through read-only tools.

Stable evidence IDs are assigned per session position, so citations survive across tool calls:

```text
E0017  tool_result  "npm test ... 3 failures..."
E0018  user         "Do not change the wire format..."
E0019  diff         "src/transport.ts ..."
```

Before submitting, the agent must have inspected the first turn, every user-correction and error turn, and everything since the previous checkpoint's coverage boundary. The submit call itself is validated: unknown coverage, uninspected ranges, and uncited evidence IDs are rejected with an error the agent can fix.

This makes the full session **readable rather than merely truncated**.

### No-gap continuity tail

A checkpoint states exactly how far its evidence grounding extends (its coverage boundary). The working context keeps every complete turn after that boundary, plus at least the last `recentTurns` turns verbatim — whichever retains more. Overlap between the checkpoint and the tail is harmless; a gap would silently lose history, so the swap proves gap-freedom structurally and fails closed to full context when it cannot.

## Evidence-grounded checkpoints

Internally, every checkpoint item must reference evidence that was actually supplied to the checkpoint model.

For example, the model does not merely produce:

```text
- Deployment must wait for the canary job.
```

Internally it produces a structured item associated with one or more evidence IDs.

Unknown evidence references are rejected.

The verification pass is a second agent with its own independent history access: it re-reads the session itself and can add omitted facts, correct stale state, downgrade unsupported success claims, and preserve unresolved work. It never sees the builder's inspection trail, so a shared blind spot cannot hide an omission from both passes.

Those provenance references are intentionally **not shown to the acting coding model**.

The final working context stays clean:

```markdown
# Continuation Checkpoint

## Objective
- Finish the transport migration without changing the public wire format.

## Constraints
- Preserve backwards compatibility with the existing framing protocol.

## Current State
- Parser migration is complete.
- Transport integration remains unfinished.

## Open Issues
- Integration tests currently fail in the reconnect path.

## Next Actions
- Fix reconnect handling in src/transport.ts.
- Re-run the integration suite.
```

Provenance helps build and verify the checkpoint without becoming permanent context clutter.

## Checkpoints can repair earlier omissions

Shadow does not assume that its previous checkpoint is the only source of truth.

Pi sessions are append-only, so the underlying session history survives even when the working context has been compacted.

When Shadow prepares a later checkpoint, it reads the whole surviving session again — raw history first, with the previous checkpoint as orientation, never as a substitute for reads.

That means an omission in checkpoint A does not necessarily become permanent.

If a later checkpoint can still see the original session evidence, it can recover a constraint or fact that checkpoint A missed.

This is one of the main reasons Shadow keeps checkpoints as **replaceable projections over durable session history**, rather than treating each generated summary as irreversible truth.

## Rolling refresh

By default, Shadow can refresh a checkpoint again when the working set grows after a successful swap.

A typical session therefore looks like:

```text
raw conversation grows
        ↓
prepare threshold reached (60%)
        ↓
checkpoint A prepared + verified
        ↓
checkpoint A + recent tail
        ↓
conversation grows again
        ↓
checkpoint B prepared from full history + prior checkpoint
        ↓
checkpoint B + newer tail
```

Each checkpoint is a new attempt to represent the current session state accurately.

It is not simply a summary of the previous summary.

## No steady-state agent context cost

Shadow registers no tools for the acting model.

The background summarizer and verifier use separate model requests. Their prompts, evidence IDs, tool calls, and verification instructions do not become part of the coding agent's normal context.

The only durable model-visible cost is the resulting continuation checkpoint itself.

That tradeoff is deliberate:

**spend inference outside the coding loop so the acting model can spend its context and attention on the task.**

## Background preparation

Shadow begins preparing a checkpoint before the context window becomes critical.

Three thresholds plus an idle rule (defaults):

* **prepare (60%)** — checkpoint construction begins without interrupting the active agent run.
* **swap (80%)** — a ready checkpoint becomes the mandatory working context on the next request. A preparation in flight is never aborted here: it is the path to a smaller working set.
* **emergency native fallback (92%)** — near the provider limit, one native compaction is queued at the next safe idle point.
* **idle** — when the agent settles with at least `idleCompact.minimumTokens` (default 20,000) and the branch moved past the checkpoint's coverage, Shadow prepares a fresh checkpoint so `/compact` and reloads start from current state.

Once a verified checkpoint is ready, future model requests use it in place of the older conversation prefix plus the no-gap continuity tail.

Manual `/compact` is served by Shadow whenever a current checkpoint exists; otherwise Shadow prepares one fresh and serves it. `/compact-native` runs one purely native compaction as an escape hatch (`manualCompactMode: "native"` restores the legacy behavior of always compacting natively on manual request).

## Failure behavior

Context management should not make the coding agent less reliable.

Shadow therefore prefers failing closed.

Examples:

* malformed checkpoint output is rejected
* unknown evidence references are rejected
* checkpoints that skip required history inspection are rejected
* verification failure prevents publication
* stale checkpoints are not restored onto incompatible branches
* checkpoints are invalidated when their underlying compaction ancestry no longer matches
* failed background preparation falls back to native Pi behavior
* an emergency context threshold provides a last-resort native-compaction path

A failed optimization should leave you with Pi's normal behavior rather than a corrupted working state.

## Persistence and resume

Verified checkpoints are persisted into the Pi session as extension state.

On reload or resume, Shadow searches for the newest checkpoint that is still valid for the current session and branch.

Stale or structurally invalid checkpoints are skipped.

The raw session history remains the durable evidence source; the checkpoint is the current compact projection over it.

## Install

From GitHub:

```bash
pi install git:github.com/sij0sh/pi-shadow-compact
```

Update or remove:

```bash
pi update git:github.com/sij0sh/pi-shadow-compact
pi remove git:github.com/sij0sh/pi-shadow-compact
```

Requires Node 22.19+ and a compatible Pi version.

## Configuration

Global configuration:

```text
~/.pi/agent/shadow-compact.json
```

Optional project configuration:

```text
<project>/.pi/shadow-compact.json
```

Project configuration takes precedence.

A minimal configuration (everything else has defaults — see `.pi/shadow-compact.example.json` for the full schema):

```json
{
  "prepareThresholdPercent": 60,
  "swapThresholdPercent": 80,
  "summarizerModel": {
    "provider": "",
    "id": ""
  }
}
```

Blank provider and model IDs use the model already running the Pi session.

Legacy `softCompactThresholdPercent` / `hardCompactThresholdPercent` keys still load as aliases for the prepare / swap thresholds.

### Separate summarizer and verifier models

You can use different models for checkpoint generation and verification:

```json
{
  "summarizerModel": {
    "provider": "",
    "id": ""
  },

  "verificationModel": {
    "provider": "",
    "id": ""
  },

  "thinkingLevel": "medium",
  "verificationThinkingLevel": "high"
}
```

One reasonable strategy is:

```text
fast / inexpensive model
        ↓
checkpoint draft
        ↓
stronger verifier
        ↓
working checkpoint
```

Leaving `verificationModel` blank reuses the summarizer model.

## Tuning

### `prepareThresholdPercent`

Default:

```text
60
```

Controls when Shadow begins preparing a checkpoint.

Lower values give the background process more time and more spare context, but may prepare checkpoints that never become necessary.

Higher values reduce unnecessary preparation but leave less room before the working context becomes constrained.

### `swapThresholdPercent`

Default:

```text
80
```

At this usage a ready checkpoint becomes the mandatory working context on the next request. Preparations in flight are never aborted here.

### `nativeFallbackThresholdPercent`

Default:

```text
92
```

This is the safety boundary.

If the working context reaches it, one native Pi compaction is queued at the next safe idle point. The idle point rechecks first: if context recovered while the run drained, the stale hatch stands down.

### `idleCompact`

```json
{
  "idleCompact": { "enabled": true, "minimumTokens": 20000 }
}
```

When the agent settles with at least `minimumTokens` of context and the branch moved past the checkpoint's coverage, Shadow prepares a fresh checkpoint so the next context request, `/compact`, or reload starts current.

### `recentTurns`

Default:

```text
10
```

Minimum complete recent turns retained verbatim past any checkpoint, even when the checkpoint already covers them. The continuity tail starts at whichever point retains more: the first complete turn after the coverage boundary, or the first of the last `recentTurns` turns.

### `manualCompactMode`

Default:

```text
"shadow"
```

`"shadow"` serves manual `/compact` from the Shadow checkpoint (preparing fresh when none is ready). `"native"` restores the legacy behavior of always compacting natively on manual request. Either way, `/compact-native` runs one purely native compaction.

### `summaryMaxTokens`

Optionally caps the generated checkpoint size. When omitted, Shadow does not impose its own output cap and lets the model/provider use its registered output limit.

Set this only when you intentionally want a smaller response. A low value can stop checkpoint generation before its strict JSON output is complete.

### Summarizer and verification reasoning

Reasoning levels can be configured separately.

For example:

```json
{
  "thinkingLevel": "medium",
  "verificationThinkingLevel": "high"
}
```

This lets checkpoint drafting remain relatively inexpensive while spending more inference on checking whether important state was lost or overstated.

## What Shadow Compact is not

Shadow is not a permanent-memory system.

It does not provide the acting model with:

* semantic memory search
* memory-management tools of any kind
* decompression tools
* a memory palace
* a vector database
* a user-facing archive browser

Shadow does not inject selectively retrieved old transcript turns into the acting model's context. Historical recovery happens while constructing the checkpoint: the background builder and verifier can inspect the durable session directly.

Those systems solve a different problem.

Shadow focuses narrowly on maintaining a **high-quality active working set** for a long coding session.

If your primary requirement is arbitrary recall from hundreds of thousands or millions of tokens of history, use a system designed around explicit retrieval.

If your primary requirement is:

> "Keep Pi working on the same task for much longer without making it think about memory management"

that is the problem Shadow is designed to solve.

## Design philosophy

Three principles drive the implementation.

### 1. Preserve operational state, not transcript shape

A continuation agent usually needs:

* what are we trying to accomplish?
* what constraints must not be violated?
* what has already been changed?
* what actually worked?
* what is still broken?
* why did we choose this approach?
* what should happen next?

It usually does not need every intermediate token that produced those answers.

### 2. Keep raw history more authoritative than generated summaries

Generated checkpoints are useful projections.

They are not ground truth.

Whenever practical, later checkpoints are allowed to consult original session evidence again instead of recursively trusting earlier summaries.

### 3. Keep memory management out of the coding model's way

The acting model should spend its tool calls and attention on the repository.

Shadow handles context maintenance separately.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs the TypeScript typecheck and test suite.

## License

MIT.

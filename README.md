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
session history
      ↓
normalized evidence
      ↓
bounded evidence packet
      ↓
checkpoint draft
      ↓
independent verification pass
      ↓
verified checkpoint
      ↓
recent conversation remains verbatim
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

## Overflow retrieval instead of blind truncation

A summarizer still has a finite context window.

Shadow does not solve that by silently throwing away everything that does not fit.

Individual messages, tool calls, tool results, diffs, and command output are bounded before they enter the main evidence packet. If an item is too large, or if the full packet exceeds the available evidence budget, its full content is retained as archived overflow with a stable evidence ID.

The checkpoint model receives a compact manifest of that archived evidence.

If it decides an archived item is important, it can request the full text by ID before completing the checkpoint.

Conceptually:

```text
E0017  tool_result  "npm test ... 3 failures..."
E0018  user         "Do not change the wire format..."
E0019  diff         "src/transport.ts ..."
```

The summarizer can effectively say:

```json
{"needEvidence":["E0018","E0019"]}
```

Shadow then supplies the complete archived text and lets the model finish the checkpoint using the recovered evidence.

This makes oversized evidence **retrievable rather than merely truncated**.

### Head and tail protection

When the evidence packet must shrink, Shadow also avoids simple oldest-first truncation.

It preferentially protects:

* the beginning of the relevant history, which often contains the original objective and major constraints
* the newest work, which is usually most important for immediate continuation

Intermediate evidence is evicted first and remains available through the overflow mechanism.

That does not make compaction lossless, but it gives important context more ways to survive than naive transcript truncation.

## Evidence-grounded checkpoints

Internally, every checkpoint item must reference evidence that was actually supplied to the checkpoint model.

For example, the model does not merely produce:

```text
- Deployment must wait for the canary job.
```

Internally it produces a structured item associated with one or more evidence IDs.

Unknown evidence references are rejected.

The verification pass operates over the same evidence and can add omitted facts, correct stale state, downgrade unsupported success claims, and preserve unresolved work.

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

When Shadow prepares a later checkpoint, it can use:

* the current Pi compaction summary
* recent Shadow checkpoints
* raw session history around and before the current compaction boundary

That means an omission in checkpoint A does not necessarily become permanent.

If a later checkpoint can still see the original session evidence, it can recover a constraint or fact that checkpoint A missed.

This is one of the main reasons Shadow keeps checkpoints as **replaceable projections over durable session history**, rather than treating each generated summary as irreversible truth.

Recovery is intentionally bounded, so this is not infinite archival memory. Extremely old details can eventually fall outside the evidence available to a later checkpoint. Shadow is designed to make ordinary repeated compaction substantially more resilient, not to turn the context window into permanent storage.

## Rolling refresh

By default, Shadow can refresh a checkpoint again when the working set grows after a successful swap.

A typical session therefore looks like:

```text
raw conversation grows
        ↓
soft threshold reached
        ↓
checkpoint A prepared + verified
        ↓
checkpoint A + recent tail
        ↓
conversation grows again
        ↓
checkpoint B prepared from history + prior evidence
        ↓
checkpoint B + newer tail
```

Each checkpoint is a new attempt to represent the current session state accurately.

It is not simply a summary of the previous summary.

## No steady-state agent context cost

Shadow registers no tools for the acting model.

The background summarizer and verifier use separate model requests. Their prompts, evidence IDs, retrieval protocol, and verification instructions do not become part of the coding agent's normal context.

The only durable model-visible cost is the resulting continuation checkpoint itself.

That tradeoff is deliberate:

**spend inference outside the coding loop so the acting model can spend its context and attention on the task.**

## Background preparation

Shadow begins preparing a checkpoint before the context window becomes critical.

Defaults:

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

At the soft threshold, checkpoint construction begins without interrupting the active agent run.

Once a verified checkpoint is ready, future model requests can use it in place of the older conversation prefix while retaining Pi's recent-history boundary verbatim.

If context continues growing toward the hard threshold and Shadow cannot safely replace it in time, the extension falls back to native Pi compaction.

## Failure behavior

Context management should not make the coding agent less reliable.

Shadow therefore prefers failing closed.

Examples:

* malformed checkpoint output is rejected
* unknown evidence references are rejected
* verification failure prevents publication
* stale checkpoints are not restored onto incompatible branches
* checkpoints are invalidated when their underlying compaction ancestry no longer matches
* failed background preparation falls back to native Pi behavior
* a hard context threshold provides an emergency native-compaction path

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

A minimal configuration:

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

Blank provider and model IDs use the model already running the Pi session.

### Separate summarizer and verifier models

You can use different models for checkpoint generation and verification:

```json
{
  "softCompactThresholdPercent": 60,
  "hardCompactThresholdPercent": 80,

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

### `softCompactThresholdPercent`

Default:

```text
60
```

Controls when Shadow begins preparing a checkpoint.

Lower values give the background process more time and more spare context, but may prepare checkpoints that never become necessary.

Higher values reduce unnecessary preparation but leave less room before the working context becomes constrained.

### `hardCompactThresholdPercent`

Default:

```text
80
```

This is the safety boundary.

If the working context reaches it before Shadow has safely recovered enough space, native Pi compaction is queued at the next safe idle point.

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
* explicit historical recall
* decompression tools
* a memory palace
* a vector database
* a user-facing archive browser

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

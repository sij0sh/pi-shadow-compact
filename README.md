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

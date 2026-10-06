# Domain docs

Use a single-context layout for this repository.

## Before exploring

Read `GLOSSARY.md` at the repository root.
Read relevant architecture decision records (ADRs) under `docs/adr/`.

If these files do not exist, proceed silently.
Do not flag their absence or suggest creating them upfront.
The domain-modeling skill creates them when terms or decisions are resolved.

## Layout

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architecture decision records.

## Vocabulary

Use glossary terms when naming domain concepts in issues, proposals, hypotheses, and tests.
Avoid synonyms that the glossary explicitly rejects.

If a needed concept is missing, reconsider whether the project uses it.
Note genuine vocabulary gaps for domain-modeling.

## Decision conflicts

State explicitly when a proposal contradicts an existing ADR.
Identify the ADR and explain why its decision should be reconsidered.

# Bayes Engine — Agent Instructions

Build **Bayes Engine**, a desktop XMLBIF editor.

## Before coding

1. Read `Plan.md` and every file in `context/`.
2. Work on **one unchecked Plan step only** per session.
3. Inspect existing code/tests before changing anything.

## Non-negotiable rules

- XMLBIF 0.3 semantics in `context/project-overview.md` are the source of truth.
- Preserve `OUTCOME` order, `GIVEN` order, arbitrary `PROPERTY` strings, and unknown-but-safe XML data where possible.
- `GIVEN P` means edge `P -> FOR`; never maintain a second independent topology.
- Never reorder states/parents without the matching CPT tensor transform.
- Graph edits must produce valid model state before serialization.
- Code edits update the graph only after successful parse + structural validation.
- Keep Electron privileged APIs behind the preload bridge; no Node access in the renderer.
- No inference/learning engine in v1.

## Completion rule

A step is complete only when its acceptance criteria and tests pass. Then mark only that step `[x]` in `Plan.md` and stop.

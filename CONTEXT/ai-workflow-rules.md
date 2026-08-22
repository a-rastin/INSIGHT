This file's name: "ai-workflow-rules.md"

# Project INSIGHT

Before changing code:
- Write a bounded acceptance statement for the change.
- Implement the smallest end-to-end increment that can be verified independently.

## Project Invariants
- One unified Docker image does not mean one process, one database, one codebase, or merged module boundaries.
- Every persisted or exchanged dataset has an explicit, versioned schema.
- A system-generated treatment plan is an explainable draft.
- The psychiatrist remains the final decision-maker and must explicitly confirm or modify clinical outputs.
- Finalized treatment plans are immutable. Later plans supersede prior versions; they do not rewrite them.

## When to Split Work
Split an implementation step when it combines any of the following:
- UI behavior and an unrelated backend/domain change;
- a new endpoint and an unrelated migration;
- authentication changes and clinical decision logic;
- Bayesian-model calibration;
- model structure changes and probability/utility elicitation;
- more than one clinical decision point;
- a legacy compatibility adapter and removal of the legacy contract;
- production hardening and unrelated feature work;
- clinical validation and routine software refactoring.
- If the change cannot be verified end to end with a focused test set and one clear rollback path, the scope is too broad.

## Frontend and Accessibility Rules
- Preserve the clean academic clinical design and shared design tokens unless the task explicitly changes the design system.
- Use teal as an accent, not as small body text where contrast is insufficient.
- Preserve visible clinician-control wording near recommendations.
- Use semantic labels, table headers, keyboard navigation, visible focus indicators, and reduced-motion behavior.
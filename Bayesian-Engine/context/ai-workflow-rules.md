# AI Workflow Rules

1. Read `AGENTS.md`, all `context/*`, then the next unchecked `Plan.md` step.
2. Work only on that step; do not pre-build later features.
3. Inspect current files, tests, package scripts, and public types before editing.
4. Implement the smallest complete vertical slice satisfying the step.
5. Add/adjust tests for every behavior introduced.
6. Run relevant tests first, then lint/typecheck; run E2E when the step crosses UI/file boundaries.
7. Do not weaken validation/tests to make them pass.
8. Do not silently change XMLBIF ordering or CPT semantics. Use architecture tensor helpers.
9. Avoid broad refactors, dependency churn, generated lockfile rewrites unrelated to the step, and speculative abstractions.
10. If docs conflict, priority is: `AGENTS.md` → `project-overview.md` → `architecture.md` → current Plan step → other context.
11. Record a necessary deviation in the smallest relevant context file.
12. Mark the step `[x]` only after acceptance/tests pass; summarize changed files, commands run, and any remaining risk; then stop.

# Bayesian Network Package: Clozapine in Treatment-Resistant Schizophrenia

This topic package translates the supplied APA guideline excerpts into a qualitative Bayesian Network for a clinical decision support app.

## Clinical Decision Point

For a patient with schizophrenia and persistent symptoms after antipsychotic therapy, determine the recommended management pattern among clozapine initiation, clozapine optimization/restart/hold, further treatment-resistance verification or antipsychotic optimization, adjunctive ECT consideration, and avoidance of TMS as a recommended schizophrenia intervention from this source.

The supplied source also contains separable decision points, including clozapine side-effect management, clozapine level interpretation, and clozapine-resistant schizophrenia augmentation. Those were not split into separate BNs because the project context requires explicit permission before a decision point split.

## Files

- `bn_spec.md`: Human-readable source-backed BN design.
- `clozapine_trs.net`: Hugin-style qualitative BN skeleton with placeholder probability tables.
- `diagram.mmd`: Mermaid diagram of the BN topology.

## Source Basis

Primary source excerpts:

- `C:\Users\Amirali Hatami\.codex\attachments\65b56978-c83e-4fc0-b57c-28db80e8cd42\pasted-text.txt`
- `C:\Users\Amirali Hatami\.codex\attachments\9e9a20c0-6f1b-42b4-98eb-ab42ee87716b\pasted-text.txt`

Important deployment note: the source text includes operational statements about US clozapine REMS and ANC monitoring. Because REMS and monitoring requirements are regulatory and jurisdiction-specific, the app should verify current local policy before deployment rather than treating the textbook passage as a current legal rule.

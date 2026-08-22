# ADR-014: Final Plan Supersession and Optional Trial Details

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** Final Treatment Plan revisions and previous-antipsychotic field requirements

## Context

Each Patient has one Research Case, but research conclusions may still be revised. Existing decisions require Final Treatment Plans to remain immutable. Historical antipsychotic records also need a minimum completeness rule and a practical adverse-effect input model.

## Decision

### Immutable superseding Final Treatment Plans

A Research Case may contain multiple Final Treatment Plan versions. After a plan is finalized, that version is permanently immutable. To change it, a Psychiatrist creates a new mutable draft within the same Research Case, normally seeded from the active Final Treatment Plan.

Immutability prohibits editing a surviving plan; it does not prevent the whole Patient aggregate from being permanently deleted under ADR-020.

Finalizing that draft creates a new immutable version and atomically marks the previously active version `SUPERSEDED`. The new version becomes `ACTIVE`. Supersession does not delete, alter, or detach the prior plan and does not create another Research Case.

Each version stores its sequence number, predecessor identifier, status, author, finalization timestamp, complete medication regimen, source draft, DDI result, BN/CPT provenance, assessment states, and all model and knowledge versions used. Repeated submission with the same finalization idempotency key returns the already-created version rather than creating another.

If the medication regimen or any upstream dependency changes, the applicable DDI, AI-imputation, CPT, BN, and plan-generation invalidation rules run before the new version can be finalized.

No supersession reason, explanation, acknowledgement, or override rationale is requested or stored. The predecessor link, actor, timestamps, and changed content remain available, but the system does not capture why the Psychiatrist replaced the prior active plan.

### Minimum historical trial data

Each previous-antipsychotic trial requires only a medication entry. Canonical normalization is attempted automatically under ADR-011, and the trial may still exist with state `UNKNOWN` if normalization has no usable result.

All other historical-trial fields are optional and may be omitted independently:

- dose and unit;
- start, end, or approximate treatment period;
- structured treatment response;
- adverse effects;
- discontinuation reason;
- notes.

An omitted field means “not recorded,” not a negative finding and not the explicit response value `UNKNOWN`.

### Adverse-effect input

When entered, adverse effects are a multi-select field backed by a predefined catalog. The Psychiatrist may select any number of catalog entries and may select `OTHER`. Free-text detail is available but optional, including when `OTHER` is selected; `OTHER` with an empty detail value is valid.

Administrators own the adverse-effect catalog and can create and manage its versioned terms without accessing Patient content. Saving a catalog change immediately creates and activates a new immutable catalog version for new selections. Existing trial records retain their pinned version and stable term identifiers; no automatic migration or forced reselection occurs in an in-progress Research Case.

## Consequences

- The one Research Case can accumulate a chain of Final Treatment Plan versions without losing the research history.
- Only one Final Treatment Plan is active at a time, while every superseded version remains readable and attributable.
- Superseded plans preserve who, when, and what changed but contain no structured or narrative reason for the change.
- A historical drug trial can influence the workflow even when no dose, dates, response, adverse-effect, or discontinuation information was captured.
- Absence-heavy trial records reduce the reliability of LLM-generated CPTs and recommendations but do not block plan creation.
- A controlled adverse-effect list supports aggregation, while `OTHER` preserves unanticipated descriptions.
- Because `OTHER` may have no detail, some adverse-effect records intentionally carry no interpretable description.

## Implementation Defaults

- Administrator save immediately activates a new immutable catalog version;
- existing selections remain pinned and are not migrated;
- discontinuation reason is optional free text;
- `OTHER` detail remains optional.

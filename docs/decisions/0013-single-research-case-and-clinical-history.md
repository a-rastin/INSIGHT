# ADR-013: Single Research Case and Clinical History

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** one-case research workflow, presentation status, previous antipsychotic trials

## Context

INSIGHT is a research application, not a longitudinal clinical-record system. The workflow distinguishes a known schizophrenia case from a first presentation and captures previous treatment experience, but it does not require repeated visits.

## Decision

### Exactly one Research Case

Each Patient has exactly one `ResearchCase`, created for the single research workflow. INSIGHT has no Encounter, visit, follow-up, or second-case entity and none is planned. A database uniqueness constraint enforces one Research Case per Patient.

The Research Case owns all assessments, medical history, current and previous medications, normalized medication identities, AI imputations, CPT executions, BN results, DDI checks, Primary Treatment Plan, Final Treatment Plan, and clinical audit references for that Patient's study workflow.

Creating or opening an existing Patient opens the same Research Case. There is no “new visit” action. How revisions after Final Treatment Plan creation behave remains a separate plan-lifecycle decision.

### Presentation status and conditional history

The Research Case requires exactly one structured presentation status:

- `FIRST_PRESENTATION`
- `KNOWN_SCHIZOPHRENIA`

For `FIRST_PRESENTATION`, previous-treatment questions are hidden and no previous-antipsychotic trial is required. For `KNOWN_SCHIZOPHRENIA`, INSIGHT asks whether the Patient was previously treated. If the answer is no, the trial list remains empty. If yes, at least one previous-antipsychotic trial is required.

### Previous antipsychotic trials

Previous treatment is stored as structured, repeating antipsychotic-trial records. Each record contains:

- raw medication entry and the automatically accepted canonical identity under ADR-011;
- optional dose and dose unit;
- optional treatment start and end dates or supported approximate periods;
- optional response: `FULL_RESPONSE`, `PARTIAL_RESPONSE`, `NO_RESPONSE`, `WORSENED`, or `UNKNOWN`;
- optional structured adverse effects;
- optional reason for discontinuation;
- optional free-text notes.

Only the medication entry is required. All other fields may be absent; absence is distinct from selecting `UNKNOWN`. When adverse effects are supplied, the Psychiatrist may select multiple entries from a predefined list and may select `OTHER` with free-text detail. ADR-014 completes the field-optionalness and plan-supersession rules.

The trial records are distinct from current medications. They are included in de-identified CPT-generation and plan-drafting projections according to the applicable field allowlist.

## Consequences

- The data model and UI need no visit list, Encounter selector, follow-up creation, or cross-visit comparison.
- Every clinical artifact is attributable to the one Research Case and Patient.
- A Patient cannot participate in a second independent workflow inside the same deployment.
- First-presentation cases cannot enter previous-treatment records through the normal conditional form.
- Known cases marked previously treated must supply at least one trial, but that trial can contain only a medication.
- Automatic medication-normalization errors can alter historical treatment interpretation without confirmation.

## Resolution

- adverse effects use the Administrator-owned versioned catalog in ADR-014;
- selecting `OTHER` does not require text;
- discontinuation reason is an optional free-text field in the initial release;
- the initial adverse-effect term set is a governed clinical-content artifact to be reviewed in its implementation packet, not a separate architecture choice.

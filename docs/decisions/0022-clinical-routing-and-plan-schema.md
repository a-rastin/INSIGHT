# ADR-022: C-SSRS, Deterministic Clinical Routing, and Structured Plans

- **Status:** Accepted with external instrument-permission record required
- **Date:** 2026-08-22
- **Scope:** suicide-risk instrument, Bayesian routing, plan schema, DDI fallback, comorbidity rules, hosted-model data policy

## Context

The final architecture requires exact clinical-source ownership and deterministic boundaries around LLM use. The repository contains one suicide-risk artifact: `medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf`. Bayesian pathway selection, plan structure, comorbidity logic, DDI fallback, and hosted-provider data terms also materially affect the module contracts.

## Decision

### Governed C-SSRS Screen Version - Recent

The suicide-risk module implements the one-page [`COLUMBIA-SUICIDE SEVERITY RATING SCALE, Screen Version - Recent`](../../medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf) from the local PDF. The pinned source artifact has SHA-256:

`8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2`

The source presents six Yes/No questions. Questions 1 and 2 are always asked. If question 2 is Yes, questions 3 through 6 are asked; if question 2 is No, the flow skips to question 6. Questions 1 through 5 cover the past month. Question 6 asks about suicidal behavior ever and, if Yes, whether it occurred within the past three months.

The backend assessment tool implements the visible color mapping deterministically:

- Yes to question 1 or 2: `LOW`;
- Yes to question 3: `MODERATE`;
- Yes to question 4 or 5: `HIGH`;
- Yes to question 6 within the past three months: `HIGH`;
- Yes to question 6, but not within the past three months: `MODERATE`;
- multiple positive answers: the highest mapped band;
- no positive answer: application state `NO_POSITIVE_RESPONSE`, because the source legend does not name a fourth risk band.

The module stores the exact source version/hash, answers, branching path, timeframes, derived band, calculation version, actor, and timestamp. Scoring runs locally and does not require the LLM. Assessment bypass, partial-answer deletion, warning-only completed results, and hidden AI imputation remain governed by ADR-009 through ADR-011.

The PDF identifies Research Foundation for Mental Hygiene copyright. The [official Columbia research guidance](https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/cssrs-for-research/) distinguishes research permission/training requirements from general healthcare embedding. Therefore production activation requires an Administrator-recorded permission basis applicable to this research project, source/version approval, and any required training record. INSIGHT does not paraphrase, translate, or alter the core questions without a newly governed artifact.

The repository does not currently contain a permission letter, training certificate, governed transcription, approved Persian translation, or a clinical review of the color-to-band implementation. The local PDF also does not print a formal revision identifier. These are activation gaps documented in `docs/reviews/cssrs-source-audit.md`.

### Deterministic Bayesian routing

The backend, not the LLM, selects Bayesian pathways. A versioned routing artifact maps structured Research Case conditions to one or more active BN pathway identifiers. Conditions can use allowed structured demographics, presentation status, assessment states/results, comorbidities, medication history, and current regimen data.

The routing evaluator is deterministic, records every matched rule and selected model version, and rejects ambiguous or missing required routes. The LLM may invoke only the `bn.*` tools exposed for the selected routes; it cannot name an arbitrary model, run every model, or override the routing result.

### Structured Treatment Plan

Primary and Final Treatment Plans are schema-validated objects rather than unrestricted narrative. Each regimen item supports:

- canonical medication identity and display name;
- dose and unit;
- route;
- frequency;
- titration instructions;
- monitoring requirements;
- rationale linked to structured inputs, BN outputs, and knowledge artifacts;
- DDI and other warnings;
- provenance for models, CPTs, prompts, tools, sources, and clinician edits.

Optional narrative can explain a structured element but cannot replace required regimen fields or provenance. The LLM must return the versioned schema, and the backend rejects malformed plans before clinician review.

### Medscape is required and has no fallback

The product premise is that the required Medscape reuse permission will be available and documented. The initial architecture contains no alternate DDI database, live-source fallback, or LLM-generated interaction mode. Until permission and manifest requirements in ADR-005 are satisfied, DDI remains disabled and Final Treatment Plan creation remains blocked.

### Governed comorbidity and contraindication knowledge

Comorbidities use versioned database catalog entries with stable identifiers. Deterministic versioned rules map selected conditions to contraindications, cautions, monitoring requirements, and BN-routing inputs. Administrator governance follows the same non-Patient-content boundary used for other knowledge artifacts.

The frontend renders backend-provided catalog values and does not hard-code clinical rules. Free text may supplement a structured condition but cannot independently create a deterministic contraindication unless normalized to a governed catalog entry.

### No hosted-provider retention or training gate

Any OpenAI-compatible endpoint that passes the technical tool/schema checks may receive the de-identified projections allowed by ADR-003. INSIGHT does not require a no-training promise, zero-retention setting, data-processing agreement, or approved provider policy before activation.

Direct identifiers remain prohibited. De-identification does not guarantee anonymity, and a provider may retain, analyze, or train on the submitted clinical projection under its own terms. This is an accepted external-disclosure risk rather than an activation block.

## Consequences

- Suicide-risk scoring is reproducible from one pinned local instrument, but permission/training evidence remains a production gate for this research app.
- C-SSRS triage bands are not treated as a prediction of suicide or a substitute for clinical evaluation.
- BN selection is reproducible and cannot drift with model reasoning.
- Plans can be validated, diffed, versioned, and audited field by field.
- Medscape permission failure has no in-product fallback and prevents finalization.
- Comorbidity logic can change only through versioned knowledge artifacts.
- De-identified clinical data may be retained or used for training by the configured hosted provider without INSIGHT blocking activation.

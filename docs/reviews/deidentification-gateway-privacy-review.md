# De-identification Gateway Privacy Review

## Status

Engineering review completed for projection schema `1.0.0`. Independent human privacy approval remains required before identified research data is sent to a hosted model.

## Reviewed boundary

`apps/server/src/deidentification` is the only implemented model-visible Patient-context boundary. It:

- accepts no model-selected fields or projection type;
- binds a random 24-character `subjectRef` to one execution, job, Research Case revision, workflow state, and Psychiatrist in server memory for at most 15 minutes;
- selects `MEDICATION_NORMALIZATION`, `ASSESSMENT_IMPUTATION`, `CPT_GENERATION`, or `PLAN_DRAFT` only from trusted workflow state;
- exposes derived age at Research Case start, binary sex, structured assessment values, selected structured history fields, and conservatively screened medication or governed clinical tokens;
- never exposes names, official identifiers, Patient or Research Case UUIDs, exact birth date, contact/address data, actor attribution, timestamps, opaque result references, or unrestricted clinical text;
- records static and dynamically omitted field classes;
- validates every projection against a closed runtime schema and scans its complete canonical model-visible representation before release;
- replaces unsafe tool results and all tool errors with a fixed privacy-failure envelope.

The SHA-256 input fingerprint covers projection type/version, exact projected data, and sorted omission classes. It intentionally excludes ephemeral `subjectRef`, making identical approved inputs reproducible across executions.

## Projection review

- `MEDICATION_NORMALIZATION`: local medication entry references, current/prior source, screened medication string, normalization state, optional screened canonical ID, and optional structured prior response.
- `ASSESSMENT_IMPUTATION`: derived demographics, presentation/treatment status, official completed-or-bypassed assessment state and structured completed results, screened medicines, governed comorbidity term IDs, and safe deterministic rule outputs.
- `CPT_GENERATION`: assessment-imputation context plus accepted-imputation availability. Opaque imputation references and unrestricted payloads remain excluded.
- `PLAN_DRAFT`: CPT clinical context plus accepted imputation, BN inference, and primary DDI availability. BN/DDI payloads are not yet implemented and therefore cannot cross this boundary.

## Verification evidence

- `test/deidentification.test.mjs` provides golden projection/fingerprint checks for all four workflow states.
- Closed input/output schema tests reject arbitrary fields and model-selected projection requests.
- Adversarial fixtures place names, official IDs, UUIDs, email, phone, address, exact birth date, and labeled identifiers into every currently projected structured/free-text class.
- A deterministic 500-case property sweep checks identifier-shaped medication inputs.
- Tool success/error tests verify final-boundary filtering and diagnostic removal.
- Root lint, TypeScript, formatting, focused tests, and test-artifact privacy scan are required before merge.

## Human review checklist

Reviewer must confirm:

- each model-visible field is necessary for its stated workflow purpose;
- medication text screening is sufficient for approved research fixtures and locale;
- omitted-field records are adequate for reproducibility and residual-risk review;
- no future BN, DDI, imputation, plan, or provenance payload is exposed without extending the closed schema and adversarial fixtures;
- captured hosted-model requests and application logs contain no direct identifier under an end-to-end agent execution;
- residual re-identification risk is accepted under the research approval.

No human sign-off is recorded in this repository yet.

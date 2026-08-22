# C-SSRS Screen Version - Recent Schema and Validation

## Artifact record

- Instrument: Columbia-Suicide Severity Rating Scale, Screen Version - Recent
- Local source: `medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf`
- Source SHA-256: `8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2`
- Schema version: `1.0.0`
- Calculation version: `1.0.0`
- Review record: `CSSRS-CLINICAL-REVIEW-2026-08-22-PENDING`
- Status: Pending clinical approval
- Research activation: Inactive

## Engineering transcription

Questions 1, 2, and 6 are always traversed. A Yes response to question 2 adds questions 3, 4, and 5. A Yes response to question 6 adds its past-three-month recency follow-up. Questions 1 through 5 use the past-month timeframe; question 6 is lifetime behavior with the separate recent follow-up.

The deterministic calculator uses the source color cells as follows:

- question 1 or 2 positive: `LOW`;
- question 3 positive, or question 6 positive but not within three months: `MODERATE`;
- question 4 or 5 positive, or question 6 positive within three months: `HIGH`;
- no positive response: `NO_POSITIVE_RESPONSE`.

When multiple mappings apply, `HIGH` takes precedence over `MODERATE`, which takes precedence over `LOW`. The all-negative state is deliberately not described as absence of risk. The result is informational text paired with a visible color marker. No result creates an acknowledgement, action-record, escalation, or finalization gate.

## Verification record

Engineering verification covers all 54 valid completed answer combinations across both question-2 branches and both question-6 recency outcomes. Tests also cover incomplete answers, prohibited hidden-branch answers, exact traversed-question storage, source SHA-256 drift, accessible rendering, API recalculation, persistence, bypass deletion, and the absence of any all-negative risk claim.

## Clinical review record

No attributable clinical reviewer has approved this transcription or its color-to-band precedence. The record therefore remains pending and must not be represented as clinical approval.

Required sign-off fields before the review reference can change:

- reviewer name and role;
- review date;
- approved source hash;
- approved schema and calculation versions;
- reviewed decision-table version;
- wording, branching, timeframe, and color-mapping disposition;
- limitations and required corrective actions.

## Activation gate

Research activation remains inactive until all four independent evidence fields are true: applicable project permission, required training, governed transcription approval, and attributable clinical review approval. Repository presence and passing software tests do not satisfy those evidence fields.

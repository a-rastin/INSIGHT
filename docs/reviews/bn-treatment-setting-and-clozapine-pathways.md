# Treatment Setting, Continuing Medication, and Clozapine Pathway Review Record

- **Record date:** 2026-08-24
- **Routing artifact:** `5.0.0`
- **Mapping review reference:** `BN-PATHWAY-STRUCTURED-MAPPING-REVIEW-2026-08-24-V5`
- **Clinical approval status:** Not established
- **Calibration status:** Uncalibrated

## Review Scope

This record cross-checks software routing and requested-output mappings against repository XML,
package documentation, and ADR-022. It is not an attributable clinical sign-off. No clinician name,
approval date, independent guideline transcription review, calibration report, or prospective
validation record exists in the repository.

## Pinned Artifacts

| Pathway                        | Artifact                                                                               | SHA-256                                                            | Structural result                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Treatment Setting              | `BNs/Treatment-Setting/BN-Treatment-Setting.xml`                                       | `2208cadaf8938ab1bb82b8f985296f3f75241002b8ca0958ce27a7b89010be91` | XMLBIF 0.3 parse, model validation, and deterministic round trip pass |
| Continuing medication          | `BNs/5 - Continuing Medications/gemini-code-1783421787562.xml`                         | `9527c9c7c0efdfa2caf748fb7ebceaad8715ff79b89180305ba9d0aef3e8b355` | XMLBIF 0.3 parse, model validation, and deterministic round trip pass |
| Clozapine aggressive behavior  | `BNs/9 - Clozapine in Aggressive Behavior _/gemini-code-1783422744909.xml`             | `424562a955ef0def89e93f8fede10e87b7bd65b6b9e95182634baecfa1786416` | XMLBIF 0.3 parse, model validation, and deterministic round trip pass |
| Clozapine treatment resistance | `BNs/7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml` | `faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb` | XMLBIF 0.3 parse, model validation, and deterministic round trip pass |
| Clozapine suicide risk         | `BNs/Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml`                       | `90f633bee7da1625ca4d44d35ace5acace5ca51ee7d597541ee7a5d0089acf3a` | XMLBIF 0.3 parse, model validation, and deterministic round trip pass |

Only active models with these exact content hashes are eligible for these routes. A missing,
inactive, quarantined, superseded, duplicate, or hash-mismatched model fails closed.

## Structured Routing Mapping

Treatment Setting is required only when presentation status is `FIRST_PRESENTATION` or
`KNOWN_SCHIZOPHRENIA` and DSM-5-TR state is `COMPLETED` with result
`SCHIZOPHRENIA_CONFIRMED`. Missing confirmation produces `MISSING_REQUIRED_ROUTE`; duplicate
matching rules produce `AMBIGUOUS_ROUTE`.

Continuing medication is optional and selected only for `KNOWN_SCHIZOPHRENIA` with the same
completed confirmation, an explicit `IMPROVED` response to a normalized prior medication, that
same medication in the current regimen, and a structured plan relation containing the source plan
reference, source revision, a greater target revision, and `relationship: REVISES`. These facts and
the plan relation participate in the revision-scoped routing input hash; the exact active model is
pinned to the research case. Missing plan context, non-improved response, different medications,
unknown relationship values, and free text cannot select the route.

Clozapine suicide risk is optional and selected only for `KNOWN_SCHIZOPHRENIA` with the same
completed confirmation and a C-SSRS routing state of `COMPLETED`, `BYPASSED`, or `IMPUTED`.
All three terminal states select the same pinned model. Risk band, generated classification,
answers, and free text never gate routing. `NOT_STARTED` and `IN_PROGRESS` do not select it.
This preserves the warning-only C-SSRS policy and does not create a suicide-risk action gate.

Clozapine treatment resistance is optional and selected only for `KNOWN_SCHIZOPHRENIA` with the
same completed confirmation plus at least two distinct normalized prior medications. Each counted
trial must explicitly record adequate dose, adequate duration, adequate adherence, and
`NO_RESPONSE` or `PARTIAL_RESPONSE`. Duplicate medicines, missing adequacy fields, nonadherence,
other responses, or fewer than two qualifying trials do not select the route. This is a conservative
routing prerequisite, not a clinical diagnosis of treatment-resistant schizophrenia.

Clozapine aggressive behavior is optional and selected only for `KNOWN_SCHIZOPHRENIA` with the
same completed confirmation and structured `riskAfterOtherTreatments` value
`SUBSTANTIAL_DESPITE_OTHER_TREATMENTS`. Missing aggression data, controlled/non-substantial risk,
or insufficient prior-treatment/adherence assessment does not select it. Unknown enum values,
additional note fields, and free-text-only payloads fail as `INVALID_ROUTING_FACTS`; no LLM output
or unnormalized note can select this route. This trigger is a conservative routing prerequisite,
not a validated violence-risk assessment.

## Requested Outputs

Treatment Setting requests:

- `inpatient_care_priority`
- `inpatient_service_priority`
- `less_restrictive_care_priority`
- `management_recommendation`

Continuing medication requests:

- `maintenance_antipsychotic_eligibility`
- `adherence_strategy_priority`
- `medication_adjustment_priority`
- `management_recommendation`

Clozapine aggressive behavior requests:

- `ClozapineIndicationPriority`
- `ClozapineEligibility`
- `ManagementRecommendation`

Clozapine suicide risk requests:

- `Clozapine_Eligibility`
- `Clinical_Action_Pattern`

Clozapine treatment resistance requests:

- `TreatmentResistanceStatus`
- `ClozapineEligibility`
- `ClozapinePriority`
- `ClozapineImplementationMode`
- `ECTPriority`
- `TMSPriority`
- `ManagementRecommendation`

Runtime inference accepts only the complete ordered output list published in the routed CPT
contract. Arbitrary model or node selection is rejected.

## Evidence and Calibration Limits

- Treatment Setting and clozapine treatment resistance contain placeholder CPTs; continuing
  medication and clozapine
  aggressive behavior and suicide risk contain qualitative placeholder probabilities. None has a
  calibration report.
- Patient-specific LLM-generated CPTs receive mathematical validation only.
- Structural validity does not establish clinical validity, safety, fairness, or local suitability.
- Clozapine use still requires current prescribing information, patient-specific contraindication
  and interaction review, monitoring feasibility, current jurisdictional requirements, and
  psychiatrist judgment.
- Treatment-setting outputs do not replace emergency evaluation, local admission criteria, or
  applicable involuntary-treatment law.
- Continuing-medication outputs do not replace adverse-effect, interaction, adherence, monitoring,
  patient-preference, diagnostic, or psychiatrist review of each plan revision.

## Clinical Review Gap

Research deployment must keep `clinicalReviewStatus: NOT_ESTABLISHED` visible until an authorized
clinical reviewer records identity, scope, source versions, reviewed route vectors, findings,
approval decision, and approval timestamp. Software tests must not convert this pending state into
clinical approval.

## Verification

- `test/bn-routing.test.mjs` contains reviewed diagnosis, medication/plan revision, aggression, treatment-trial, C-SSRS
  terminal-state, free-text rejection, missing, ambiguous, inactive, duplicate-trial,
  unsupported-semantic, and hash-mismatch vectors.
- `packages/bayes/test/bayes.test.mjs` replays full artifact CPTs through exact marginal inference,
  including Treatment Setting and continuing medication without database dependencies.
- `test/bn-pathways.integration.mjs` imports and activates pinned artifacts, routes one synthetic
  qualifying case, validates all CPT contracts, persists snapshots, and verifies stable inference
  references and distributions on replay.

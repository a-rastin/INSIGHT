# Qualitative Bayesian Network Specification

## Topic

Clozapine-centered management for treatment-resistant schizophrenia.

## Clinical Decision Point

For a patient with schizophrenia and persistent symptoms after antipsychotic therapy, rank the appropriate management pattern:

- initiate clozapine with slow titration and monitoring
- discuss clozapine and resolve monitoring/preference barriers
- verify treatment resistance or optimize prior antipsychotic treatment/adherence
- continue or optimize clozapine with level/side-effect assessment
- restart clozapine at low dose after interruption
- hold or stop clozapine for urgent safety reasons
- consider adjunctive ECT when rapid response, catatonia, suicide risk, or clozapine resistance is present
- avoid recommending TMS for schizophrenia symptoms from this source

## Scope Guard

This is one BN for the central clozapine treatment decision. The source contains additional separable BNs that should be created only after explicit approval to split:

- management of clozapine-associated constipation
- management of tachycardia during clozapine treatment
- management of sedation, sialorrhea, metabolic effects, and orthostatic hypotension
- interpretation of clozapine/norclozapine levels
- augmentation after clozapine nonresponse

## Source-Derived Decision Rules

1. Clozapine is strongly recommended for treatment-resistant schizophrenia.
2. Treatment resistance is supported by schizophrenia plus persistent clinically significant symptoms despite adequate antipsychotic treatment, commonly two antipsychotic trials of at least 6 weeks at adequate dose with adequate adherence and no or only partial/suboptimal response.
3. A medication trial should not be counted as adequate if it was limited by poor adherence, inadequate duration, inadequate dose, or poor tolerability.
4. A clozapine trial may also be appropriate when there is some symptom response but significant residual symptoms or functional impairment persists.
5. Clozapine initiation requires shared decision-making, attention to patient concerns, feasibility of monitoring, and a slow titration strategy.
6. Higher-risk titration situations include older age, severe debility, sensitivity to side effects, CNS conditions such as 22q11.2 deletion syndrome, cardiovascular vulnerability, and concomitant respiratory depressants.
7. If clozapine is interrupted for 48 hours or more, restart at 12.5 mg once or twice daily and retitrate.
8. If clozapine is stopped, taper unless urgent medical reasons exist, including severe neutropenia, myocarditis, or neuroleptic malignant syndrome.
9. During inadequate response to clozapine, first verify adequate dose, steady-state levels, adherence, tolerability, and sufficient trial duration before declaring clozapine resistance.
10. Adjunctive ECT can be considered for clozapine-resistant schizophrenia, especially with catatonia, significant suicide risk, or need for rapid response.
11. ECT may also be considered with non-clozapine antipsychotic treatment in treatment-resistant schizophrenia when catatonia, significant suicide risk, or rapid response need is present.
12. TMS has insufficient evidence in this source to recommend for schizophrenia hallucinations or negative symptoms.

## Node Inventory

| Node | Type | States | Purpose |
|---|---|---|---|
| SchizophreniaAndSymptoms | Patient state | confirmed_significant, absent_or_mild, unknown | Captures diagnosis plus persistent clinically significant symptoms. |
| PriorTrialAdequacy | Patient state | two_adequate_trials, inadequate_or_uncertain, unknown | Captures whether prior antipsychotic exposure supports TRS. |
| AdherenceAndResponse | Patient state | adequate_adherence_poor_response, response_or_nonadherence_uncertain, unknown | Captures adherence and lack of meaningful response. |
| ResidualImpairmentAfterResponse | Patient state | significant, not_significant, unknown | Allows clozapine consideration despite partial response. |
| TreatmentResistanceStatus | Patient state | confirmed_trs, probable_or_residual_impairment, not_confirmed, unknown | Summary of TRS determination. |
| UrgentClozapineSafetySignal | Patient state | present, absent, unknown | Hard safety gate: severe neutropenia, myocarditis, NMS, urgent toxicity. |
| MonitoringAndPreference | Patient state | feasible_accepting, barriers_or_ambivalent, refuses, unknown | Captures practical monitoring and shared decision-making readiness. |
| TitrationRisk | Patient state | standard, elevated, unknown | Captures need for slower initiation/restart strategy. |
| ClozapineCurrentStatus | Patient state | not_on_clozapine, interrupted_ge_48h, on_subtherapeutic_or_short_trial, adequate_nonresponse, responding_or_benefiting, urgent_harm_on_clozapine, unknown | Captures current clozapine situation. |
| ClozapineEligibility | Intervention eligibility | eligible_with_monitoring, defer_or_relative_caution, hold_or_contraindicated, unknown | Whether clozapine is medically allowable now. |
| ClozapinePriority | Intervention priority | high, moderate, low, unknown | How strongly clozapine should be favored if eligible. |
| ClozapineImplementationMode | Intervention priority | initiate_standard_slow_titration, initiate_extra_slow_titration, restart_12_5mg_retitrate, optimize_current_trial, continue_current, urgent_hold_stop, not_applicable_or_unknown | How clozapine should be operationalized. |
| ECTClinicalIndication | Patient state | present, absent, unknown | Catatonia, significant suicide risk, rapid response need, or clozapine resistance. |
| ECTPriority | Intervention priority | consider_adjunctive, low, unknown | Whether ECT should be considered. |
| TMSConsidered | Patient state | yes, no, unknown | Whether TMS is being considered. |
| TMSPriority | Intervention priority | not_recommended_from_source, not_applicable, unknown | Encodes insufficient evidence from source. |
| ManagementRecommendation | Management recommendation | initiate_clozapine_monitoring, shared_decision_resolve_barriers, verify_trs_optimize_antipsychotic_or_lai, optimize_or_continue_clozapine, restart_clozapine_low_dose_retitrate, hold_stop_clozapine_urgent_evaluation, consider_adjunctive_ect, do_not_recommend_tms_from_source, periodic_person_centered_review | Final clinical action pattern. |

## Edges

- SchizophreniaAndSymptoms -> TreatmentResistanceStatus
- PriorTrialAdequacy -> TreatmentResistanceStatus
- AdherenceAndResponse -> TreatmentResistanceStatus
- ResidualImpairmentAfterResponse -> TreatmentResistanceStatus
- UrgentClozapineSafetySignal -> ClozapineEligibility
- MonitoringAndPreference -> ClozapineEligibility
- TreatmentResistanceStatus -> ClozapinePriority
- ClozapineEligibility -> ClozapinePriority
- TitrationRisk -> ClozapineImplementationMode
- ClozapineCurrentStatus -> ClozapineImplementationMode
- ClozapineEligibility -> ClozapineImplementationMode
- ClozapinePriority -> ManagementRecommendation
- ClozapineImplementationMode -> ManagementRecommendation
- ECTClinicalIndication -> ECTPriority
- ECTPriority -> ManagementRecommendation
- TMSConsidered -> TMSPriority
- TMSPriority -> ManagementRecommendation

## Hard Contraindication Gates

These are hard gates in the qualitative model:

- UrgentClozapineSafetySignal = present drives ClozapineEligibility toward hold_or_contraindicated.
- ClozapineCurrentStatus = urgent_harm_on_clozapine drives ClozapineImplementationMode toward urgent_hold_stop.
- ManagementRecommendation should not output initiate_clozapine_monitoring when ClozapineEligibility = hold_or_contraindicated.

The source specifically names severe neutropenia, myocarditis, and NMS as urgent medical reasons to stop rather than taper clozapine. Other absolute contraindications from product labeling are not added unless a separate source is supplied or approved.

## Relative Risk Factors

These downgrade or modify implementation rather than automatically excluding clozapine:

- older age
- severe debility
- sensitivity to side effects
- CNS condition including 22q11.2 deletion syndrome
- seizure risk, high clozapine level, rapid level shifts, or interacting drugs
- cardiovascular compromise or orthostatic hypotension risk
- respiratory depressant co-medication such as benzodiazepines during titration
- logistical barriers to monitoring
- patient concerns about blood work, weight gain, or somnolence
- constipation risk, metabolic risk, tachycardia risk, and sedation burden

## Rationale Labels

| Label | Meaning |
|---|---|
| R_TRS_CRITERIA | TRS requires persistent significant symptoms despite adequate pharmacologic treatment, commonly two adequate antipsychotic trials with adherence and poor response. |
| R_CLOZAPINE_1B | APA recommends clozapine for treatment-resistant schizophrenia with 1B strength. |
| R_SHARED_DECISION | Clozapine initiation should include shared decision-making and barrier management. |
| R_SLOW_TITRATION | Slow titration reduces seizure, orthostatic hypotension, sedation, and cardiovascular collapse risk. |
| R_RESTART_48H | Interruption of at least 48 hours requires restarting at 12.5 mg once or twice daily. |
| R_URGENT_STOP | Severe neutropenia, myocarditis, or NMS are urgent reasons to stop rather than taper. |
| R_OPTIMIZE_CLOZAPINE | Inadequate clozapine response should prompt dose/level/tolerability/duration review before nonresponse is concluded. |
| R_ECT_AUGMENT | ECT may be considered in clozapine-resistant or treatment-resistant schizophrenia, especially with catatonia, significant suicide risk, or rapid response need. |
| R_TMS_INSUFFICIENT | TMS evidence is insufficient in this source to recommend for schizophrenia hallucinations or negative symptoms. |
| R_PERIODIC_REVIEW | Periodic review of medication trials, psychosocial interventions, symptoms, function, and side-effect burden is recommended. |

## Placeholder CPT Strategy

This package is a qualitative BN. Numeric CPTs are placeholders and must be calibrated with expert review, local data, or prospective validation.

Recommended placeholder approach:

- Root clinical finding nodes: uniform distribution over known states plus unknown until EHR/rating-scale evidence populates them.
- TreatmentResistanceStatus: deterministic or near-deterministic once all criteria are known; otherwise preserve uncertainty.
- ClozapineEligibility: deterministic for urgent hard stop signal; otherwise sensitive to monitoring feasibility and patient preference.
- ClozapinePriority: high for confirmed TRS with eligibility; moderate for probable TRS or significant residual impairment; low when TRS not confirmed.
- ClozapineImplementationMode: deterministic for interruption >=48h and urgent harm; otherwise based on current status and titration risk.
- ECTPriority: high/consider when ECT indication is present.
- TMSPriority: deterministic not_recommended_from_source when TMS is being considered.
- ManagementRecommendation: deterministic override for urgent hold/stop; otherwise ranks clozapine-centered actions by priority and implementation mode, with ECT as an adjunctive consideration.

## Clinical Safety Boundary

This BN is not a standalone prescribing tool. It requires clinician review, current prescribing information, current jurisdiction-specific monitoring rules, and integration with patient-specific contraindications, labs, vital signs, medication interactions, pregnancy/lactation status, and emergency evaluation workflows.

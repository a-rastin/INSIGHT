# Bayesian Network Package: Maintenance Antipsychotic Management After Response in Schizophrenia

## Clinical Decision Point

For a patient with schizophrenia whose symptoms have improved with an antipsychotic medication, determine the preferred management pattern among continuing maintenance antipsychotic treatment, strengthening adherence/formulation support, dose or medication adjustment, planned gradual dose reduction with close monitoring, diagnostic reconsideration, or emergent discontinuation/urgent medication change.

This is a qualitative, source-backed Bayesian Network scaffold for a clinical decision support application. It is not calibrated for direct patient care and requires clinician review, local policy review, and probability calibration before deployment.

## Source-Derived Decision Rules

| ID | Rule | Source support |
|---|---|---|
| R1 | If schizophrenia diagnosis is clear and symptoms improved with an antipsychotic, maintenance antipsychotic treatment is strongly favored. | APA Statement 5 recommends continuing antipsychotic treatment, grade 1A. |
| R2 | Continuing treatment is favored because it reduces relapse, rehospitalization, and mortality compared with discontinuation or no use. | Implementation and evidence appendix describe lower relapse, rehospitalization, and mortality. |
| R3 | Long-term treatment harms should be actively monitored and mitigated, including weight gain, sedation, metabolic abnormalities, and movement disorders/tardive syndromes. | Implementation section lists harms and mitigation through preventive interventions and monitoring. |
| R4 | If medication is well tolerated, use the lowest effective dose that maintains benefit. | Implementation states the optimal dose provides best benefits while tolerable. |
| R5 | Significant side effects should raise priority for dose adjustment or medication change rather than automatic discontinuation. | Implementation recommends assessing benefits/side effects and adjusting dose or medication as needed. |
| R6 | Pharmacokinetic modifiers such as interacting medications, smoking status, body mass, renal/hepatic status, or drug absorption changes can require dose adjustment. | Implementation lists these factors as reasons dose changes may be required. |
| R7 | If emergent discontinuation is required, urgent medication change/discontinuation overrides routine gradual reduction. | Implementation states gradual reductions are preferable unless a medication requires emergent discontinuation. |
| R8 | Planned dose reductions should generally be gradual and paired with close monitoring for recurrent symptoms. | Implementation explicitly recommends gradual reductions and close monitoring. |
| R9 | Brief episode or uncertain psychotic diagnosis may reduce the need for continuing antipsychotic treatment after diagnostic review. | Implementation notes some individuals with brief or uncertain psychosis may not require continuing treatment. |
| R10 | Chronic symptoms, repeated relapses, and clear schizophrenia features increase concern for poor outcomes if medication is stopped. | Implementation states such individuals will likely have poorer outcomes if medications are stopped. |
| R11 | Poor or uncertain adherence should raise priority for adherence interventions and may support LAI use. | Implementation and guideline review state LAIs may be useful when adherence is poor or uncertain. |
| R12 | Patient preference, pill-swallowing difficulty, or inconsistent oral medication use may support alternative formulations or LAI. | Implementation discusses rapidly dissolving tablets, oral concentrates, and LAIs. |
| R13 | Shared decision-making should include recovery goals, tradeoffs, patient preferences, and often family or support persons. | Implementation recommends shared decision-making and inclusion of supports. |

## Nodes and States

| Node | Type | States |
|---|---|---|
| `diagnosis_context` | Patient state | `clear_chronic_schizophrenia`, `brief_or_uncertain_psychosis`, `unknown` |
| `symptom_response_to_antipsychotic` | Patient state | `improved`, `not_improved`, `unknown` |
| `serious_or_emergent_medication_harm` | Patient state / hard gate input | `present`, `absent`, `unknown` |
| `significant_side_effect_burden` | Patient state / relative risk input | `present`, `absent`, `unknown` |
| `adherence_concern` | Patient state | `poor_or_uncertain`, `adequate`, `unknown` |
| `formulation_barrier_or_lai_preference` | Patient state | `present`, `absent`, `unknown` |
| `pharmacokinetic_dose_change_factor` | Patient state | `present`, `absent`, `unknown` |
| `dose_reduction_goal_or_request` | Patient state | `present`, `absent`, `unknown` |
| `maintenance_antipsychotic_eligibility` | Intervention eligibility | `continue_indicated`, `consider_discontinuation_after_review`, `emergent_stop_required`, `insufficient_information` |
| `adherence_strategy_priority` | Intervention priority | `lai_or_alternative_formulation_high`, `routine_adherence_support`, `insufficient_information` |
| `medication_adjustment_priority` | Intervention priority | `urgent_discontinue_or_switch`, `adjust_or_switch_for_tolerability_or_pk`, `maintain_lowest_effective_dose`, `gradual_reduction_with_close_monitoring`, `insufficient_information` |
| `management_recommendation` | Management recommendation | `continue_antipsychotic_lowest_effective_dose_with_monitoring`, `continue_antipsychotic_with_adherence_or_lai_strategy`, `adjust_dose_or_change_antipsychotic_with_monitoring`, `planned_gradual_dose_reduction_with_close_monitoring`, `consider_no_continuing_antipsychotic_after_diagnostic_review`, `emergent_discontinue_or_urgent_medication_change`, `insufficient_information_reassess` |

## Edges

| Parent | Child | Rationale |
|---|---|---|
| `diagnosis_context` | `maintenance_antipsychotic_eligibility` | Clear schizophrenia favors maintenance; brief/uncertain psychosis may not require continuing treatment. |
| `symptom_response_to_antipsychotic` | `maintenance_antipsychotic_eligibility` | Statement applies to patients whose symptoms improved with antipsychotic medication. |
| `serious_or_emergent_medication_harm` | `maintenance_antipsychotic_eligibility` | Emergent discontinuation overrides routine continuation. |
| `adherence_concern` | `adherence_strategy_priority` | Poor/uncertain adherence supports adherence interventions and possibly LAI. |
| `formulation_barrier_or_lai_preference` | `adherence_strategy_priority` | Swallowing difficulty, inconsistent oral use, or preference can favor alternative formulation/LAI. |
| `serious_or_emergent_medication_harm` | `medication_adjustment_priority` | Emergent harm raises urgent discontinuation/switch priority. |
| `significant_side_effect_burden` | `medication_adjustment_priority` | Side effects raise priority for dose adjustment or medication change. |
| `pharmacokinetic_dose_change_factor` | `medication_adjustment_priority` | PK changes can require dose increase or decrease. |
| `dose_reduction_goal_or_request` | `medication_adjustment_priority` | Planned reduction requests should be gradual with close monitoring. |
| `maintenance_antipsychotic_eligibility` | `management_recommendation` | Eligibility determines whether continuation, discontinuation review, or urgent stop is considered. |
| `adherence_strategy_priority` | `management_recommendation` | High adherence strategy priority shifts the recommended pattern toward LAI/alternative formulation support. |
| `medication_adjustment_priority` | `management_recommendation` | Adjustment priority determines whether dose change, switching, gradual reduction, or routine continuation is favored. |

## Hard Contraindication Gates

| Gate | Trigger | Effect |
|---|---|---|
| `emergent_medication_harm_gate` | `serious_or_emergent_medication_harm = present` | Forces `maintenance_antipsychotic_eligibility = emergent_stop_required` and strongly favors `management_recommendation = emergent_discontinue_or_urgent_medication_change`. |

## Relative Risk Factors

| Factor | Effect |
|---|---|
| `significant_side_effect_burden = present` | Downgrades routine continuation and increases priority for dose adjustment or medication change. |
| `pharmacokinetic_dose_change_factor = present` | Increases priority for dose reassessment, especially when long half-life or LAI formulations are involved. |
| `diagnosis_context = brief_or_uncertain_psychosis` | Shifts away from default maintenance and toward diagnostic review and possible non-continuation. |
| `dose_reduction_goal_or_request = present` | Allows planned gradual reduction only with close monitoring, unless emergent discontinuation is required. |
| `adherence_concern = poor_or_uncertain` | Shifts recommendation toward adherence supports and possible LAI. |
| `formulation_barrier_or_lai_preference = present` | Shifts recommendation toward alternative formulation or LAI strategy. |

## Rationale Labels for Recommendation States

| Recommendation state | Rationale labels |
|---|---|
| `continue_antipsychotic_lowest_effective_dose_with_monitoring` | `R1`, `R2`, `R3`, `R4`, `R13` |
| `continue_antipsychotic_with_adherence_or_lai_strategy` | `R1`, `R2`, `R11`, `R12`, `R13` |
| `adjust_dose_or_change_antipsychotic_with_monitoring` | `R3`, `R5`, `R6`, `R13` |
| `planned_gradual_dose_reduction_with_close_monitoring` | `R8`, `R13` |
| `consider_no_continuing_antipsychotic_after_diagnostic_review` | `R9`, `R13` |
| `emergent_discontinue_or_urgent_medication_change` | `R7` |
| `insufficient_information_reassess` | Applies when diagnosis, response, harm, adherence, or tolerability information is unavailable. |

## Placeholder CPT Strategy

The `.net` file contains qualitative placeholder CPTs, not validated probabilities.

- Deterministic placeholder probabilities are used only for the hard emergent-harm gate.
- Source-favored paths are represented with high but non-final placeholder probabilities.
- Unknown inputs propagate increased probability of `insufficient_information` states.
- Final production CPTs should be calibrated by expert elicitation, retrospective validation, and monitoring against local clinical outcomes.

## Files

- `network.net`: Hugin-style qualitative BN scaffold.
- `diagram.mmd`: Mermaid diagram for the BN structure.

# Long-Acting Injectable Antipsychotic Bayesian Network

This folder contains a Bayesian Network for clinical decision support around long-acting injectable (LAI) antipsychotic treatment in schizophrenia or schizoaffective disorder.

Source topic: APA schizophrenia guideline Statement 10, "Long-Acting Injectable Antipsychotic Medications."

Guideline anchor: APA suggests that patients receive treatment with an LAI antipsychotic medication if they prefer such treatment or if they have a history of poor or uncertain adherence. The recommendation is graded 2B.

## Files

- `lai_antipsychotic_bn.net`: Hugin-style Bayesian Network file with discrete nodes and seed CPTs.
- `README.md`: Model documentation and implementation notes.

## Intended CDS Use

The network estimates whether LAI antipsychotic treatment should be recommended, offered through shared decision-making, considered with barrier mitigation, deferred, or avoided pending specialist review.

Final output node:

`LAIRecommendation`

States:

- `recommend_lai`
- `offer_shared_decision`
- `consider_with_barrier_mitigation`
- `defer_lai`
- `avoid_or_specialist_review`

## Clinical Scope

Population:

- Adults with schizophrenia or schizoaffective disorder for whom antipsychotic treatment is being considered or continued.

Main positive indications:

- Patient prefers LAI treatment.
- Poor or uncertain adherence to oral antipsychotic treatment.
- Risk factors for future poor adherence, such as limited illness insight, co-occurring substance use disorder, or transition between care settings.
- Repeated psychiatric hospitalization or emergency visits where nonadherence may be contributing.
- Poor response to oral therapy when unrecognized nonadherence is suspected.

Main caution or deferral factors:

- Oral tolerability of the candidate medication has not been established.
- Prior intolerance to the candidate antipsychotic.
- Prior neuroleptic malignant syndrome.
- Patient refuses injections.
- No feasible LAI formulation or safe administration pathway.
- Major cost, insurance, transportation, scheduling, or clinic workflow barriers.

## Model Structure

The BN uses observed clinical variables, intermediate indication/safety/barrier nodes, and a final recommendation node.

Key intermediate nodes:

- `PreferenceIndication`
- `AdherenceIndication`
- `UtilizationIndication`
- `LAIIndicationStrength`
- `DrugTolerabilityStatus`
- `PracticalAcceptability`
- `LAISafetySuitability`
- `ImplementationBarriers`
- `ExpectedBenefitFromLAI`
- `ExpectedHarmBurdenFromLAI`
- `NetClinicalFavorability`

The structure intentionally separates:

- Whether an LAI is clinically indicated.
- Whether the candidate drug and route are suitable.
- Whether implementation barriers need mitigation.
- Whether the final CDS output should recommend, offer, defer, or request specialist review.

## Evidence Encoding

Evidence labels from the APA text:

- Recommendation strength: APA 2B.
- Evidence for efficacy: moderate overall.
- Evidence for harms: low overall.

Important interpretation:

The source text does not provide patient-level CPT probabilities. The probabilities in `lai_antipsychotic_bn.net` are seed values that encode guideline-consistent directionality. They should be calibrated against expert review, local clinical data, or prospective validation before deployment in production CDS.

## Implementation Notes

Suggested input mapping:

- EHR medication refill gaps, missed appointments, clinician documentation, or collateral history can populate `OralAdherence`.
- Recent discharge, correctional release, or transfer of care can populate `CareTransition`.
- Hospitalization and ED utilization history can populate `RepeatedHospitalOrED`.
- Prior medication adverse-effect documentation can populate `OralFormulationTolerated` and `PriorNMS`.
- Shared decision-making documentation can populate `PatientPrefersLAI` and `InjectionAcceptability`.
- Insurance authorization and clinic capacity checks can populate implementation barrier nodes.

Recommended CDS behavior:

- If `LAIRecommendation = recommend_lai`, prompt the clinician to discuss LAI initiation and candidate medication selection.
- If `LAIRecommendation = offer_shared_decision`, present a shared decision-making prompt with benefits, harms, and patient preference capture.
- If `LAIRecommendation = consider_with_barrier_mitigation`, prompt barrier mitigation steps before abandoning LAI treatment.
- If `LAIRecommendation = defer_lai`, document the reason and reassess if adherence or preference changes.
- If `LAIRecommendation = avoid_or_specialist_review`, require specialist review or selection of an alternative strategy.

## Safety Notes

This BN is for clinical decision support, not autonomous prescribing. It should not replace clinician judgment. LAI selection still requires medication-specific labeling review, dose conversion guidance, missed-dose protocols, safe injection practices, and monitoring for adverse effects.

The model does not encode individual LAI product selection. Product-specific contraindications, dosing, storage, reconstitution, injection site, oral overlap, and missed-dose rules should be handled by a separate medication-selection module.

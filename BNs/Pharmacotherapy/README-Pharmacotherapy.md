# Schizophrenia Pharmacotherapy — APA Statement 4 Bayesian Network

**File:** `pharmacotherapy.xml` (XML BIF Version 0.3 format)
**Network Name:** `apa_statement_4_antipsychotic_selection_bn`
**Role in the CDSS:** Evaluates a patient's clinical and diagnostic context to generate individualized management recommendations for antipsychotic selection. The model integrates diagnostic certainty, hard contraindications, clinical history, physical health parameters, drug-drug interactions, formulation suitability, and patient preference according to the American Psychiatric Association (APA) Statement 4 guidelines.

---

## 1. Model Classification

Unlike previous influence diagrams that relied on explicit decision or utility nodes to calculate Maximum Expected Utility (MEU), this model is constructed as a pure **Bayesian Network (BN)**. All nodes are declared as `nature` variables. Instead of mathematically maximizing utility across an array of discrete drugs, this network encodes the underlying clinical reasoning and algorithmic logic of guidelines directly into conditional probability tables (CPTs), outputting a specific categorical `management_recommendation`.

---

## 2. File Format & Structure

The network is serialized in **XML BIF v0.3** format. The document structure consists of:

* **`VARIABLE` Blocks:** Define each node's name, type, valid outcome states, and a descriptive clinical property.


* **`DEFINITION` Blocks:** Specify the directed acyclic graph (DAG) topology via `<GIVEN>` tags and contain flat-mapped conditional probability `<TABLE>` matrices.



### CPT Nesting Rule

For definition blocks with multiple parents (`<GIVEN>`), the distribution values inside the `<TABLE>` element follow a strict row-major ordering where the first declared parent represents the outermost loop and the last declared parent is the innermost loop.

---

## 3. Network Topology

The network consists of **11 nodes** organized into a hierarchical multi-stage causal structure:

```
  PATIENT INPUTS (Priors)               INTERMEDIATE PRIORITIES             FINAL OUTPUT
  
  schizophrenia_diagnostic_context ───┐
                                      ├──► antipsychotic_candidate_eligibility ──┐
  candidate_specific_contraindication ┘                                          │
                                                                                 │
  prior_antipsychotic_experience ─────┐                                          │
  side_effect_physical_health_fit ────┼──► individualized_candidate_priority ────┼─► management_recommendation
  interaction_pharmacokinetic_fit ────┘                                          │
                                                                                 │
  patient_preference_acceptability ───┐                                          │
                                      ├──► shared_decision_formulation_priority ─┘
  formulation_fit ────────────────────┘

```

---

## 4. Node Reference

### 4.1 Input Nodes (Roots)

Root nodes have uniform prior probabilities assigned across their respective outcomes ($0.333$ or $0.250$). These act as baseline placeholders until patient evidence is explicitly observed.

| Variable Name | Outcome States | Clinical Description / Property |
| --- | --- | --- |
| `schizophrenia_diagnostic_context` | `schizophrenia_confirmed`<br>

<br>`diagnosis_not_confirmed`<br>

<br>`unknown` | Appraises diagnostic certainty; diagnostic ambiguity requires a formal clinical reassessment.

 |
| `candidate_specific_hard_contraindication` | `present`<br>

<br>`absent`<br>

<br>`unknown` | Identifies absolute clinician/labeling absolute contraindications that immediately disqualify a drug.

 |
| `prior_antipsychotic_experience` | `effective_and_tolerable`<br>

<br>`ineffective_or_intolerable`<br>

<br>`no_prior_trial`<br>

<br>`unknown` | Factors prior individual symptom response and historical patient tolerance into the selection matrix.

 |
| `patient_preference_and_acceptability` | `accepts_candidate`<br>

<br>`prefers_alternative`<br>

<br>`declines_antipsychotic`<br>

<br>`unknown` | Incorporates person-centered discussion findings and willingness to take the chosen agent.

 |
| `side_effect_and_physical_health_fit` | `favorable`<br>

<br>`concerning`<br>

<br>`unknown` | Matches the candidate's metabolic, cardiac, or neurological risk profile against pre-existing conditions.

 |
| `interaction_and_pharmacokinetic_fit` | `favorable`<br>

<br>`concerning`<br>

<br>`unknown` | Considers drug-drug interactions, smoking status metabolism, organ function, and receptor dynamics.

 |
| `formulation_fit` | `acceptable_formulation_available`<br>

<br>`formulation_mismatch`<br>

<br>`unknown` | Verifies available delivery systems against swallowing capacity, adherence context, or acute route needs.

 |

### 4.2 Intermediate Priority Nodes

These internal layers compress multidimensional clinical patterns into specialized, thematic sub-assessments.

* **`antipsychotic_candidate_eligibility`**

* *Parents:* `schizophrenia_diagnostic_context`, `candidate_specific_hard_contraindication`

* *States:* `eligible`, `candidate_contraindicated`, `diagnostic_review_required`, `insufficient_information`



* **`individualized_candidate_priority`**

* *Parents:* `prior_antipsychotic_experience`, `side_effect_and_physical_health_fit`, `interaction_and_pharmacokinetic_fit`

* *States:* `candidate_high_priority`, `alternative_candidate_preferred`, `candidate_requires_caution_or_adjustment`, `insufficient_information`

* *Guideline Note:* Reflects the principle that no single First-Generation (FGA) or Second-Generation (SGA) class is universally preferred over another.




* **`shared_decision_and_formulation_priority`**

* *Parents:* `patient_preference_and_acceptability`, `formulation_fit`

* *States:* `proceed_with_candidate`, `choose_acceptable_alternative_or_formulation`, `address_declination_and_reassess`, `insufficient_information`




### 4.3 Final Target Output Node

* **`management_recommendation`**

* *Parents:* `antipsychotic_candidate_eligibility`, `individualized_candidate_priority`, `shared_decision_and_formulation_priority`

* *States:*
1. `initiate_individualized_antipsychotic_and_monitor_effectiveness_and_side_effects`

2. `select_alternative_antipsychotic_or_formulation_then_initiate_and_monitor`

3. `exclude_contraindicated_candidate_and_select_an_eligible_alternative`

4. `continue_shared_decision_discussion_and_reassess_if_antipsychotic_declined`

5. `defer_selection_and_obtain_missing_or_diagnostic_information`






---

## 5. Inference Logic & Clinical Operation

1. **Instantiation:** Enter findings onto any or all of the 7 root input nodes based on the candidate drug and patient assessment.


2. **Belief Propagation:** The engine routes probabilities through the intermediate structural tiers. For instance, if a candidate drug has an absolute contraindication present, `antipsychotic_candidate_eligibility` shifts fully to `candidate_contraindicated`.


3. **Recommendation Derivation:** The network produces a posterior probability distribution across the five target states in `management_recommendation`. The state with the highest posterior probability serves as the primary guidance action dictated by the expert rule framework.



---

## 6. Model Customization & Maintenance

The underlying conditional matrices can be adjusted or scaled by updating the `<TABLE>` fields within `pharmacotherapy.xml`. To modify how the system handles specific edge cases (such as tuning how aggressively a formulation mismatch or patient preference shifts the final action pattern), modify the conditional distributions located under the `management_recommendation` definition block.
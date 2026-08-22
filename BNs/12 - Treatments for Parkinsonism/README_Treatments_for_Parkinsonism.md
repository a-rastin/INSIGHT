# Treatments for Parkinsonism — Bayesian Network

Decision-support sub-network for **medication-induced (neuroleptic-induced) parkinsonism**, part of the schizophrenia CDSS. Encodes the APA Practice Guideline (Statement 2C) options: reduce antipsychotic dose, switch antipsychotic, anticholinergic medication, or amantadine.

## Files

| File | Style | Loads in pgmpy? | Use with |
| --- | --- | --- | --- |
| `Treatments_for_Parkinsonism.net` | Pure probabilistic BN (chance nodes only) | **Yes** — verified | pgmpy `NETReader`, Hugin, UnBBayes |
| `Treatments_for_Parkinsonism_InfluenceDiagram.net` | Influence diagram (chance + `decision` + `utility` nodes) | **No** | Hugin / UnBBayes GUI only |

**Why two files.** pgmpy 1.1.2's Hugin reader (`NETReader`) does not support `decision` or `utility` node types; it raises `KeyError` on the decision node. This affects every influence-diagram `.net` in this project, not only this one. The pure-BN version is therefore the canonical, code-loadable artifact; the influence diagram is provided for graphical tools that render utilities/decisions natively.

## Network structure (pure BN)

Six nodes:

| Node | Type | States | Source in guideline |
| --- | --- | --- | --- |
| `Dose_Reduction_Feasible` | root | Yes, No | "reduction in dose, if feasible" |
| `Psychotic_Relapse_Risk` | root | High, Low | weigh benefit vs increase in psychotic symptoms |
| `Tardive_Dyskinesia` | root | Present, Absent | anticholinergics can worsen TD |
| `Age` | root | Above65, Under65 | older patients more sensitive to anticholinergic effects |
| `Anticholinergic_Caution` | derived | High, Low | deterministic: High if TD Present **or** Age Above65 |
| `Parkinsonism_Treatment` | recommendation | Reduce_Dose, Switch_Antipsychotic, Anticholinergic, Amantadine | the four guideline options |

Edges:

```
Tardive_Dyskinesia ──┐
                     ├──> Anticholinergic_Caution ──┐
Age ─────────────────┘                              │
Dose_Reduction_Feasible ─────────────────────────────┼──> Parkinsonism_Treatment
Psychotic_Relapse_Risk ──────────────────────────────┘
```

## Influence-diagram variant

Same clinical factors, but the recommendation becomes a `decision` node (`Parkinsonism_Treatment`) with an empty potential, and a `utility` node `U_NetBenefit` holds a designer-elicited net-benefit matrix conditioned on the decision plus `Dose_Reduction_Feasible`, `Psychotic_Relapse_Risk`, and `Anticholinergic_Caution`. Open it in Hugin or UnBBayes to compute the maximum-expected-utility action.

## Parent / data ordering (Hugin)

In every `potential` block the **leftmost parent varies slowest (outermost)** and the **rightmost parent varies fastest (innermost)**; each parent iterates its states in declared order, child values listed innermost. Matches the reference files — preserve the ordering if you edit CPTs by hand.

## Loading in Python (pgmpy)

```python
from pgmpy.readwrite import NETReader
from pgmpy.inference import VariableElimination

model = NETReader("Treatments_for_Parkinsonism.net").get_model()
assert model.check_model()

ve = VariableElimination(model)
q = ve.query(
    ["Parkinsonism_Treatment"],
    evidence={
        "Dose_Reduction_Feasible": "No",
        "Psychotic_Relapse_Risk": "High",
        "Tardive_Dyskinesia": "Present",
        "Age": "Above65",
    },
)
print(q)   # -> Amantadine dominant (avoids anticholinergic harm in TD / elderly)
```

> Note: in pgmpy 1.1.2 the Hugin reader is named `NETReader` (not `HuginReader`).

## Verification

`Treatments_for_Parkinsonism.net` was loaded with pgmpy 1.1.2: `NETReader.get_model()` succeeds, `check_model()` returns `True`, and every CPD is normalized. Inference behaves as the guideline implies:

- feasible dose reduction + low relapse risk → `Reduce_Dose` dominant
- no dose reduction + high relapse + TD + elderly → `Amantadine` dominant
- no dose reduction + high relapse, no TD, younger → `Anticholinergic` dominant

## ⚠ Placeholders — calibrate before clinical use

The guideline text contains **no numeric probabilities**. Following the convention of the reference nets in this project:

- All root priors are uniform `0.5 / 0.5` placeholders. Replace with your population base rates.
- The `Parkinsonism_Treatment` CPT (and the influence-diagram utility matrix) are **elicited from the text's qualitative directionality**, not published statistics. Review and tune with a clinician before any real decision support.
- `Anticholinergic_Caution` is the only fully deterministic node and is grounded directly in explicit guideline statements.

## Clinical source

APA Practice Guideline for the Treatment of Patients With Schizophrenia — Statement 2C on medication-induced parkinsonism (lower dose / switch antipsychotic / anticholinergic; amantadine as alternative). Medication details: Table 10 (benztropine, trihexyphenidyl, diphenhydramine, amantadine).

> All probabilities and utilities are placeholders for clinical calibration, not validated estimates.

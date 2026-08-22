# VMAT2_Tardive_Dyskinesia.net

Bayesian **influence diagram** (Hugin `.net` / UnBBayes dialect) encoding APA Statement 14 — *VMAT2 Medications for Tardive Dyskinesia* — as a decision core of the schizophrenia CDSS. Built to match the structure and syntax of the sibling networks in this folder (`13.net`, `Continuing_Medications.net`, `diagnosis.net`).

## Purpose

Given a patient's tardive dyskinesia (TD) presentation and pharmacologic constraints, the network supports two sequential decisions — **which treatment approach** to take, and **which VMAT2 inhibitor** to select — and scores each pathway on benefit/harm utilities.

## Network type

Influence diagram with three node natures: **nature (probabilistic)**, **decision**, and **utility**. Decision potentials are intentionally **empty** so a Hugin-compatible solver computes the optimal policy (same convention as `Continuing_Medications.net`).

## Nodes

### Nature — clinical inputs (uniform 0.5 priors)

| Node | States | Meaning / source |
|------|--------|------------------|
| `TD_Severity` | Mild, Moderate_to_Severe_or_Disabling | Statement 14 severity split |
| `Contributing_Etiology` | Identified, Not_Identified | Work-up for other movement-disorder causes |
| `Withdrawal_Emergent_Context` | Present, Absent | Dyskinesia emerged/increased after antipsychotic dose reduction |
| `Patient_Preference` | Favor_Treatment, Favor_Observation | Shared decision-making |
| `Hepatic_Impairment` | Present, Absent | Table 11 |
| `Renal_Impairment_Severe` | Present, Absent | Table 11 (CrCl < 30) |
| `CYP2D6_Status` | Poor_or_Inhibited, Normal | Poor metabolizer or strong CYP2D6 inhibitor |
| `CYP3A4_Inducer_Strong` | Present, Absent | Concomitant strong CYP3A4 inducer |
| `Depression_Suicidality_Risk` | Elevated, Not_Elevated | Tetrabenazine safety signal |

### Nature — deterministic logic (CPTs from guideline rules, 1.0/0.0)

| Node | States | Parents | Rule |
|------|--------|---------|------|
| `VMAT2_Indication` | Recommended, Optional_Consider, Not_Indicated | TD_Severity, Contributing_Etiology, Withdrawal_Emergent_Context | Etiology Identified **or** withdrawal-emergent → Not_Indicated (defer/observe). Else moderate-to-severe/disabling → Recommended (1B); mild → Optional_Consider. |
| `Agent_Suitability` | Acceptable, Use_With_Caution, Contraindicated | VMAT2_Agent, Hepatic_Impairment, Renal_Impairment_Severe, CYP2D6_Status, CYP3A4_Inducer_Strong | Deutetrabenazine/Tetrabenazine: hepatic → Contraindicated; poor/inhibited CYP2D6 → Caution. Valbenazine: severe renal **or** strong CYP3A4 inducer → Contraindicated; hepatic **or** poor/inhibited CYP2D6 → Caution. Not_Applicable → Acceptable (neutral). |

### Decisions (empty potentials — solver fills policy)

| Node | States | Informational parents |
|------|--------|-----------------------|
| `Treatment_Approach` | VMAT2_Inhibitor, Antipsychotic_Change_Clozapine, Antipsychotic_Dose_Reduction, Benzodiazepine, Observe_Monitor | VMAT2_Indication, Patient_Preference |
| `VMAT2_Agent` | Deutetrabenazine, Valbenazine, Tetrabenazine, Not_Applicable | Treatment_Approach, Hepatic_Impairment, Renal_Impairment_Severe, CYP2D6_Status, CYP3A4_Inducer_Strong |

`Treatment_Approach` precedes `VMAT2_Agent` (it is an informational parent), establishing decision order.

### Utilities (illustrative placeholder magnitudes)

| Node | Parents | Encodes |
|------|---------|---------|
| `U_Efficacy` | Treatment_Approach, TD_Severity, Withdrawal_Emergent_Context | Motor-symptom benefit: VMAT2 highest; clozapine/AP-change strong in moderate-severe; dose reduction minimal; observation favored under withdrawal-emergent context. |
| `U_Safety` | VMAT2_Agent, Agent_Suitability, Depression_Suicidality_Risk | Contraindicated agent → heavy penalty; caution → moderate; tetrabenazine carries an added depression/suicidality penalty; Not_Applicable → neutral. |

## Edges

Encoded implicitly through `potential (Child | Parents ...)` blocks — the Hugin NET format derives the DAG from the conditioning lists, so there is no separate edge section (consistent with the example files). Every CYP/organ-function node feeds both `VMAT2_Agent` (informational) and `Agent_Suitability` (causal), so no input node is left without downstream influence on a utility.

## Probabilities and conventions

The APA guideline text supplies only **qualitative** direction (benefit outweighs harm; agent contraindications). It contains no cardinal probabilities or utilities. Accordingly:

- **Root priors** — uniform `( 0.5 0.5 )`, as in all reference files.
- **Logic CPTs** — deterministic `1.0 / 0.0`, reflecting explicit guideline rules.
- **Decision potentials** — intentionally empty (`{ }`); the solver/clinician supplies the policy.
- **Utilities** — ordinal placeholder magnitudes; only the *directions* come from the guideline text.

**Calibrate priors and utility values against local data or expert elicitation before any clinical use.**

## Parent / data ordering (Hugin)

In every `potential` block the **leftmost parent varies slowest (outermost)** and the **rightmost parent varies fastest (innermost)**; each parent iterates its states in declared order. Child distributions (CPTs) and utility values are listed innermost. Preserve this ordering if you edit tables by hand.

## Structural integrity

Verified: balanced delimiters; 16 nodes (11 nature, 2 decision, 2 utility, with 9 root + 2 logic among nature); deterministic CPT scalar counts match parent cardinalities (`VMAT2_Indication` 24, `Agent_Suitability` 192); utility counts match (`U_Efficacy` 20, `U_Safety` 24); both decision potentials empty.

## Loading

```python
from pgmpy.readwrite import HuginReader

reader = HuginReader("VMAT2_Tardive_Dyskinesia.net")
model = reader.get_model()
```

> Note: `pgmpy`'s `HuginReader` targets plain Bayesian networks; decision/utility semantics are best loaded in a full influence-diagram tool (Hugin, UnBBayes).

## Clinical source

APA Practice Guideline for the Treatment of Patients with Schizophrenia — Statement 14 (recommendation 1B) and Table 11 (reversible VMAT2 inhibitors: deutetrabenazine, tetrabenazine, valbenazine).

> All probabilities and utilities are placeholders for clinical calibration, not validated estimates.

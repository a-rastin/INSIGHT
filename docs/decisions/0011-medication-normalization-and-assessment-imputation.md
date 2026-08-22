# ADR-011: Automatic Medication Normalization and Assessment Imputation

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** medication terminology MCP, hosted-LLM authority, bypassed assessment inputs

## Context

Psychiatrists enter current and previous medications as clinical text. DDI and Bayesian processing require canonical drug identities. The workflow also permits DSM-5-TR, PANSS, and suicide-risk assessments to be bypassed, while downstream probability generation and plan drafting still require assessment-like inputs.

## Decision

### Automatic medication normalization

The Medication Terminology MCP owns the versioned canonical medication catalog and exposes bounded search, candidate lookup, and identity-validation tools. The hosted LLM, acting as MCP client, submits each entered medication string, reviews the structured candidates, and selects a canonical medication identifier and name.

The application automatically accepts the LLM's selection. It does not show a confirmation step or require the Psychiatrist to review or correct the mapping before it is used. The accepted canonical identity becomes authoritative for DDI evaluation, CPT-generation context, and treatment-plan processing.

For provenance, INSIGHT retains the original entered text, selected canonical identifier and display name, catalog version, candidate set, LLM/provider metadata, prompt/schema versions, tool calls, and timestamp. Retaining the raw string does not prevent an incorrect automatic mapping from affecting the workflow.

If no usable catalog candidate exists, the LLM cannot select one, or the result remains ambiguous, the medication is stored with normalization state `UNKNOWN`. The original entered text remains available, but the application does not require correction or confirmation. DDI evaluation omits every pair involving that medication, and downstream processing and Final Treatment Plan creation continue.

An `UNKNOWN` medication does not establish that interactions are absent. Nevertheless, incomplete interaction coverage caused by an unknown medication is treated as a completed DDI execution rather than the blocking dependency failure described in ADR-005. A failure of the entire Medication Terminology or DDI MCP remains governed by ADR-005.

### LLM imputation after assessment bypass

When the official DSM-5-TR, PANSS, or suicide-risk assessment has state `BYPASSED`, the hosted LLM synthesizes the missing assessment answers, scores, sub-scores, conclusions, and classifications needed by downstream processing. It derives them from the remaining de-identified Research Case context. It must not recover partial answers discarded under ADR-009 or claim that the Patient or Psychiatrist supplied the synthetic values.

The synthetic assessment object is stored separately from the official assessment record with an `AI_IMPUTED` provenance label, provider/model metadata, prompt/schema versions, source-context fingerprint, and generation timestamp. The official record remains `BYPASSED`; imputation does not make it completed and does not create clinical evidence.

The mutable Primary Treatment Plan displays only a generic notice that AI-imputed assessment data was used. It does not expose the generated answers, scores, sub-scores, conclusions, classifications, or reasoning. Those details remain internal provenance. In particular, an AI-imputed high suicide-risk classification does not produce a direct suicide-risk warning, acknowledgement, escalation, or finalization block. It influences only CPT generation and plan drafting through the synthetic input.

When the plan is finalized, the generic notice is removed. Neither the Final Treatment Plan nor its printed or exported representation discloses that assessment values were AI-imputed. Internal provenance remains stored for system reproducibility but is not visible in the final clinical artifact.

An accepted AI-imputation object is part of the same dependency lifecycle as its CPT snapshot. It is reused within the Research Case while the de-identified Patient input, base model, prompt, schema, provider/model request, and generation settings remain unchanged. A dependency change invalidates both artifacts and causes a new imputation to be generated before a new CPT snapshot. It is never reused across Patients.

The imputed values are included in the patient context used to generate every CPT under ADR-008 and may be used by the hosted LLM when drafting the Primary Treatment Plan. No recommendation capability is disabled solely because an assessment was bypassed.

These values are model-generated guesses, not DSM-5-TR findings, PANSS measurements, or a performed suicide-risk assessment. Their use can create false diagnostic certainty and can either conceal or exaggerate risk.

## Consequences

- Incorrect medication mappings can drive incorrect DDI results, Bayesian probabilities, and treatment recommendations without human confirmation.
- An unknown medication can interact with current or proposed drugs without INSIGHT evaluating that interaction or blocking finalization.
- The original medication text and complete mapping provenance permit later audit but do not prevent immediate downstream error.
- Bypassing an assessment does not remove its influence from the recommendation; it replaces observed answers with LLM-generated values.
- An LLM-imputed suicide-risk classification is computational input, not a completed safety assessment.
- A high imputed suicide-risk classification is hidden from the Psychiatrist and creates no direct warning.
- Final and exported plans omit even the generic indication that synthetic assessment data influenced their recommendations.
- Generated CPT snapshots must be invalidated when an accepted medication mapping or imputed assessment object changes.

### Limited unknown-medication disclosure

The DDI page displays one small generic warning when at least one medication has state `UNKNOWN`. The warning is not attached to the medication, does not enumerate unchecked interaction pairs, and is not repeated in the Primary Treatment Plan, Final Treatment Plan, or exports.

## Resolved Lifecycle Summary

- unknown-medication disclosure is limited to one small generic DDI-page warning;
- the generic AI-imputation notice appears only on the mutable Primary Treatment Plan and disappears at finalization;
- AI imputation and the dependent CPT snapshot share the same invalidation and reuse lifecycle within the Research Case.

# ADR-009: CPT Snapshot Lifecycle and Assessment Bypass

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** patient-specific CPT generation, reproducible inference, diagnosis/PANSS/suicide-risk workflow

## Context

ADR-008 requires the hosted LLM to generate every CPT for a patient-specific Bayesian execution and requires mathematical validation before inference. The workflow also permits the Psychiatrist to skip the diagnosis, PANSS, and suicide-risk stages. The system needs deterministic rules for retrying invalid output, reusing generated tables, invalidating stale tables, and representing skipped clinical assessments.

## Decision

### Invalid CPT output

The BN MCP validates the complete generated CPT set before any table is accepted. If the first LLM response is invalid, the orchestrator may make at most two additional generation attempts. Each retry receives structured validation diagnostics. Thus, one execution permits no more than three total generation attempts.

INSIGHT does not silently repair, clip, renormalize, complete, or substitute an invalid table. Each attempt is stored with its raw response and validation diagnostics. If the third attempt is invalid, the execution ends in a typed `CPT_GENERATION_FAILED` state. No Bayesian result or treatment recommendation may be derived from that execution, and Final Treatment Plan creation remains blocked.

A later user-initiated retry is a new execution with its own identifier and provenance. It does not erase the failed execution.

### Snapshot reuse and invalidation

After a complete CPT set passes validation, INSIGHT stores it as an immutable accepted snapshot and reuses it for repeated inference within the same Research Case while all generation dependencies are unchanged. Merely reopening a page, recalculating inference, or retrying a downstream operation does not call the LLM again.

The snapshot's dependency fingerprint includes at least:

- the canonical serialized de-identified Research Case input supplied to the LLM;
- active base-model version and content hash;
- prompt/template version;
- structured-output schema version;
- LLM provider and requested model identifier;
- generation settings that can affect output.

Any dependency change makes the existing snapshot stale. The next Bayesian execution must generate and validate a new snapshot. The stale snapshot remains immutable and traceable to plans or results that previously used it. A snapshot belongs to one Research Case and is never reused across Patients.

### Assessment bypass

The Psychiatrist may bypass each of these stages independently without entering a reason:

- DSM-5-TR schizophrenia diagnostic checklist;
- PANSS severity assessment;
- suicide-risk assessment.

Bypass is an explicit action, not an empty autosave. INSIGHT records the assessment type, `BYPASSED` status, actor, Research Case, and timestamp. The official assessment record does not require or fabricate a rationale, answers, score, severity band, diagnostic conclusion, or suicide-risk classification. ADR-011 separately permits the hosted LLM to create labeled synthetic assessment values for downstream computation; those values never convert the official assessment to `COMPLETED`.

Downstream screens, the Primary Treatment Plan, and the Final Treatment Plan must visibly distinguish `BYPASSED` from `COMPLETED`, `IN_PROGRESS`, and `NOT_STARTED`. A bypass must never be interpreted as a negative finding, low risk, diagnostic certainty, or a zero score.

Bypass remains available after any partial response, including a response that would otherwise indicate elevated suicide risk. When bypass is selected, all partial answer content for that assessment is discarded. The durable record retains only the `BYPASSED` state, actor, Research Case, and timestamp; it does not retain the partial answers or an unresolved-risk warning derived from them. ADR-010 defines the behavior of completed suicide-risk results.

The general fail-closed rule for unavailable required services does not prohibit this user-authorized bypass: bypass is a selected workflow state, whereas a system failure is not.

## Consequences

- Stable inputs produce replayable inference from one stored CPT snapshot without unnecessary hosted-LLM calls.
- Dependency changes cannot silently reuse patient-specific probabilities generated from stale context.
- Invalid LLM probability output is bounded to three attempts and cannot be made acceptable through hidden numerical repair.
- All three assessments can be omitted with no explanation, including suicide-risk assessment.
- A partial high-risk suicide response can be permanently discarded by bypassing the assessment; the resulting record does not preserve that clinical signal.
- Plans can be finalized with no diagnosis score, PANSS score, or suicide-risk classification unless a later policy explicitly introduces a separate finalization gate.
- Despite that missing official result, ADR-011 allows LLM-imputed answers and scores to affect patient-specific CPTs and the draft plan.
- The UI and exported records must expose missing clinical evidence prominently so readers do not confuse omission with reassurance.

## Resolution of Downstream Use

ADR-011 resolves downstream behavior: bypassed assessments are imputed by the hosted LLM and used in CPT generation and plan drafting. No recommendation feature is disabled solely because one of these assessments is bypassed.

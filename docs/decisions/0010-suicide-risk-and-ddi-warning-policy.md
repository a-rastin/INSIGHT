# ADR-010: Suicide-Risk and DDI Warning-Only Policy

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** completed suicide-risk results, drug-interaction findings, treatment-plan finalization

## Context

ADR-009 permits the suicide-risk stage to be bypassed without a rationale and permits partial assessment content to be discarded. A separate rule is needed for completed assessments that indicate high risk. The treatment workflow also requires a DDI check for the patient's current and proposed medications, but must distinguish failure to perform that check from an interaction successfully detected by it.

## Decision

### Completed suicide-risk result

Every completed suicide-risk result, including the highest available risk classification, is informational only inside INSIGHT. The UI displays the result but does not:

- block Primary or Final Treatment Plan creation;
- require acknowledgement;
- require an emergency action, referral, safety plan, or rationale to be recorded;
- automatically contact another person or service;
- force an escalation workflow.

The result and the exact assessment version, answers, score, classification, actor, and timestamp remain attributable in the Research Case. The absence of an application gate must not be presented as evidence that no clinical response is needed. INSIGHT remains a research prototype and does not replace emergency or clinical procedures.

### DDI findings

After a DDI check completes successfully, every detected interaction is a warning regardless of the source's severity or recommended action. Contraindicated, severe, moderate, and minor findings do not create a hard application block. The Psychiatrist may approve any flagged drug combination without entering an override rationale or acknowledgement.

The warning must preserve the normalized drugs, severity, mechanism, clinical effect, recommended action, source/version, and check timestamp when those fields are available. The Final Treatment Plan stores the exact DDI result evaluated for its medication set.

Medication changes after the Primary Treatment Plan require a new DDI check against the complete resulting regimen before finalization. Under ADR-005, failure, timeout, unavailability, or invalid provenance of this required check still blocks finalization. This is distinct from a successful check that returns one or more interactions: those findings never block finalization.

The automated Primary Treatment Plan excludes every candidate drug for which the completed DDI check reports any interaction at any severity. This filter applies only to automatic generation. The Psychiatrist can manually introduce or retain an excluded drug; the complete edited regimen is then rechecked, warnings are displayed, and the plan may be finalized without an acknowledgement or rationale.

## Consequences

- INSIGHT does not enforce an emergency workflow when a completed assessment reports high suicide risk.
- A Final Treatment Plan can be created despite the highest suicide-risk classification.
- A Final Treatment Plan can include a drug combination reported as contraindicated or severe by the selected DDI source.
- The system enforces completion and provenance of DDI evaluation, but clinical action on its findings remains entirely with the Psychiatrist.
- Warning visibility and immutable provenance are the only application safeguards selected for these findings.
- Automatic generation avoids every detected interaction, but manual editing can restore any excluded combination.

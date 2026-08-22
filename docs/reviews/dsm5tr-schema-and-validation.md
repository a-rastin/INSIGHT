# DSM-5-TR Schizophrenia Assessment Schema and Validation

- Instrument pin: `DSM5TR_SCHIZOPHRENIA` / `DSM-5-TR-2022`
- Schema version: `1.0.0`
- Calculation version: `1.0.0`
- Engineering baseline: `ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW`
- Clinical reviewer sign-off: **Pending**

## Source boundary

The schema is an engineering transcription generated on 2026-08-22 from the American Psychiatric Association's DSM-5-TR schizophrenia-spectrum chapter, DOI `10.1176/appi.books.9780890425787.x02_Schizophrenia_Spectrum`. It stores concise criterion labels and operational yes/no fields rather than reproducing the manual's full copyrighted text.

The APA states that DSM criteria guide trained professionals using clinical judgment. Accordingly, the calculator reports only `INCOMPLETE`, `CRITERIA_MET`, or `CRITERIA_NOT_MET`. It never writes the independent Psychiatrist decision.

Before research use, an authorized clinical reviewer must compare every field and rule with a licensed current DSM-5-TR copy, check applicable APA update supplements, approve the wording, execute the vectors below, and replace the pending review reference with an attributable sign-off identifier. Until then, this is an engineering baseline, not a clinically approved instrument.

## Calculation contract

- Criterion A requires at least two of five recorded symptoms and at least one of delusions, hallucinations, or disorganized speech.
- Criteria B, C, D, and E must each be recorded as met.
- Criterion F is met when no governed developmental history is recorded. When that history is present, the conditional prominent-delusions-or-hallucinations requirement must be recorded as met.
- Any required unanswered field produces `INCOMPLETE`, even when another completed criterion is not met.
- A complete failed criterion produces `CRITERIA_NOT_MET`.
- `BYPASSED` is persisted outside the calculator and clears answers, calculation, and Psychiatrist decision.

## Engineering golden vectors

| Vector | Boundary                                                       | Expected           |
| ------ | -------------------------------------------------------------- | ------------------ |
| V01    | Two core Criterion A symptoms; B-F met                         | `CRITERIA_MET`     |
| V02    | Only one Criterion A symptom                                   | `CRITERIA_NOT_MET` |
| V03    | Two Criterion A symptoms, neither from the required core group | `CRITERIA_NOT_MET` |
| V04    | Criterion B not met                                            | `CRITERIA_NOT_MET` |
| V05    | Developmental history present; conditional response missing    | `INCOMPLETE`       |
| V06    | Developmental history present; conditional requirement not met | `CRITERIA_NOT_MET` |
| V07    | Developmental history present; conditional requirement met     | `CRITERIA_MET`     |
| V08    | Any otherwise-required answer missing                          | `INCOMPLETE`       |

`test/dsm5tr.test.mjs` also checks all 2,048 complete boolean combinations against independent properties and validates rejection of ungoverned answer fields. `test/dsm5tr.integration.mjs` verifies version pins, actor/timestamps, REST persistence, bypass clearing, and a stored Psychiatrist decision contrary to the computed result. `apps/web/src/Dsm5trAssessment.test.tsx` verifies the accessible answer, completion, authority, autosave, and bypass flow.

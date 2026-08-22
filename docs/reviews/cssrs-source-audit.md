# C-SSRS Local Source Audit

## Executive assessment

The repository contains one suicide-risk source: `medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf`. It is a one-page, fillable `C-SSRS Screen Version - Recent` form with six Yes/No questions, conditional branching, recent/lifetime timeframes, and color-coded Low/Moderate/High bands.

The source is sufficient to specify a deterministic prototype transcription, subject to independent clinical review. It is not sufficient to activate a research deployment: the repository lacks a project permission record, training evidence, governed transcription approval, formal revision identifier, and an approved Persian translation.

## Scope and limitations

Reviewed:

- the complete one-page local PDF visually and through layout-preserving text extraction;
- PDF metadata and SHA-256;
- official Columbia Lighthouse Project research, healthcare, FAQ, and training pages available on 2026-08-22.

Unavailable:

- permission or licensing correspondence for this project;
- protocol-specific research-use determination;
- rater training certificates;
- source data or a machine-readable scoring specification shipped with the PDF;
- an approved Persian translation;
- documented clinical review of the intended software transcription.

## Instrument map

| Element | Local source behavior |
|---|---|
| Instrument | Columbia-Suicide Severity Rating Scale, Screen Version - Recent |
| Ideation timeframe | Past month |
| Behavior timeframe | Ever, with follow-up for past three months |
| Always asked | Questions 1, 2, and 6 |
| Conditional branch | If question 2 is Yes, ask 3, 4, and 5 before 6 |
| Low color | Positive question 1 or 2 |
| Moderate color | Positive question 3; or behavior not within past three months |
| High color | Positive question 4 or 5; or behavior within past three months |
| No positive response | No named band is printed; software uses a separate `NO_POSITIVE_RESPONSE` state |

When several answers are positive, the software specification selects the highest displayed band. This is a transparent transcription rule inferred from the form's color encoding; it must be approved during clinical artifact review.

## Findings

| ID | Location | Issue | Impact | Severity | Confidence | Required correction |
|---|---|---|---|---|---|---|
| C01 | Repository source set | No project permission/licensing record | Research activation may exceed authorized use | Critical | High | Record the applicable permission basis before activation |
| C02 | Repository source set | No rater training evidence | Research-use requirements may be unmet | Major | High | Record required training/certification status |
| C03 | PDF face/metadata | No formal instrument revision identifier printed | A later similarly titled form may be confused with this artifact | Major | High | Pin SHA-256, metadata, acquisition source/date, and Administrator approval |
| C04 | Risk colors | Banding is encoded visually rather than as a machine-readable rule table | Transcription or accessibility error can change classification | Major | High | Create reviewed test vectors for every branch and color combination |
| C05 | All-No path | The PDF legend names Low/Moderate/High but no all-negative band | Calling it “no risk” would exceed the source | Major | High | Use `NO_POSITIVE_RESPONSE`, not `NO_RISK` |
| C06 | Language | Only an English form is present | An unauthorized translation could alter construct meaning | Major | High | Use the governed English wording or obtain an authorized Persian version |
| C07 | Clinical actions | This local form provides bands but no setting-specific action protocol | A color does not define a complete emergency workflow | Major | High | Keep triage actions out of the scoring engine unless separately governed |
| C08 | Product policy | Completed high risk is warning-only; bypass and hidden imputation are allowed | Product behavior can suppress or discard clinically important signals | Critical | High | Preserve these as explicit accepted research risks in every release review |

## Required implementation checks

- Pin the exact local PDF hash `8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2`.
- Store all answers and the branch actually traversed for completed assessments.
- Test every question's Yes/No path, the question-2 branch, question-6 recency branch, and every band precedence combination.
- Never label an all-negative screen `NO_RISK`.
- Do not infer a mandatory clinical action from color alone.
- Do not activate research use until permission/training/source-review records exist.
- Treat any wording, timeframe, translation, branching, or color change as a new clinical artifact version.

## Source references

- [Columbia Protocol for Research](https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/cssrs-for-research/)
- [C-SSRS healthcare/community embedding guidance](https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/cssrs-for-communities-and-healthcare/)
- [C-SSRS FAQ](https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/faq/)
- [C-SSRS training options](https://cssrs.columbia.edu/training/training-options/)

# PANSS Schema and Validation

- Instrument pin: `PANSS_30` / `KAY-OPLER-FISZBEIN-1987`
- Schema version: `1.0.0`
- Calculation version: `1.0.0`
- Engineering baseline: `ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW`
- Clinical reviewer sign-off: **Pending**

## Source boundary

This engineering transcription uses the original 30-item, three-subscale structure described by Kay, Fiszbein, and Opler (1987), DOI `10.1093/schbul/13.2.261`. Item membership was cross-checked against the NCBI Bookshelf PANSS table and the 1–7 anchor labels and score range against the NIMH Data Archive PANSS structure.

The product includes canonical item labels and shared anchor labels. It does not reproduce licensed item-specific rating criteria. Before research use, an authorized reviewer must compare every item label, anchor, subscale assignment, and rule with the organization's licensed PANSS materials and replace the pending reference with an attributable sign-off identifier.

## Calculation contract

- Positive score sums `P1`–`P7`, range 7–49.
- Negative score sums `N1`–`N7`, range 7–49.
- General psychopathology score sums `G1`–`G16`, range 16–112.
- Total sums all 30 items, range 30–210.
- Each item accepts only an integer from 1 through 7.
- Any missing item yields `INCOMPLETE`, an answered-item count, and `scores: null`. No partial subscale or total is presented.
- `BYPASSED` is persisted outside the calculator and clears answers and calculation.

## Engineering golden vectors

| Vector | Item values                                   | Positive            | Negative            | General             | Total               |
| ------ | --------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| V01    | Every item = 1                                | 7                   | 7                   | 16                  | 30                  |
| V02    | Every item = 7                                | 49                  | 49                  | 112                 | 210                 |
| V03    | Repeating 1–7 in canonical P, N, G item order | 28                  | 28                  | 59                  | 115                 |
| V04    | Any one item absent                           | no completed scores | no completed scores | no completed scores | no completed scores |

`test/panss.test.mjs` checks the exact item and anchor inventory, golden vectors, every single-item boundary, missing-item suppression, and invalid values. `test/panss.integration.mjs` checks API rejection, persistence, pins, service-owned writes, completion, and bypass clearing. `test/e2e/panss.spec.mjs` checks keyboard-only entry and completion.

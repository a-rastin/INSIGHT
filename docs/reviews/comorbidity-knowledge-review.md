# Comorbidity Knowledge Review Record

## Activation contract

Each immutable comorbidity knowledge version stores its source reference and an attributable reviewer record (`reviewerId`, RFC 3339 `reviewedAt`, and `recordReference`). Activation fails before persistence when terms or rules are ambiguous, conflicting, or reference unknown terms.

No clinical term, contraindication, caution, monitoring requirement, or BN-routing value is seeded in source code or React. Administrators must supply reviewed content through the backend contract. Presence of this engineering control does not establish clinical validity.

## Engineering verification

- Golden vectors use synthetic governed terms and cover all four result kinds.
- Input and rule permutations produce byte-equivalent ordered evaluations.
- Supplemental free text is excluded from the evaluator input.
- Duplicate match sets and duplicate result targets fail activation.
- Stored Research Case results retain their immutable knowledge-version and rule provenance after later activation.

## Clinical review status

No real clinical catalog or rule set is included in this repository. Clinical reviewer identity, source evidence, and review record must be supplied for every version. Synthetic test reviewer records are test evidence only and must never be represented as clinical approval.

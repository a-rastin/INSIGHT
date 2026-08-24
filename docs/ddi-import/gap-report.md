# DDI Archive Inventory and Import Gap Report

- Inventory snapshot: `7cdbbaae63b45f9e8e0a4da067537eebfed332ed7e6659874902fe0e2d92e942`
- Repository files: 129
- Eligible text/PDF files: 129 (121 text, 8 PDF)
- Blocked files: 129
- Approved files: 0
- Active records created: 0
- Duplicate paths: 0
- Duplicate byte groups: 0
- Unsupported files: 0

## Review

All 129 archive candidates lack repository source manifests, permission records, legal approval, clinical review, and canonical medication IDs. ADR-005 and ADR-022 therefore block import, extraction, transformation, and activation. ADR-006 does not waive these gates. No live source or LLM fallback was used.

Batch 1 contains sorted positions 1-32. Clinical sample review and lifecycle review cannot start until required evidence exists; entries remain `blocked`, not falsely marked `reviewed`, `active`, or `rejected`. No derived interaction pair exists.

## Frozen Batches

- Batch 1 (1-32): 32 entries, `fa24f1eb76f7b674660cf92572206223cd16ab0826a434d136a1f1aa9afbebbf`
- Batch 2 (33-64): 32 entries, `2dc6186425b20fe18dcea2e51008476639267ea892a2b2eed2f9d9c738e2312c`
- Batch 3 (65-96): 32 entries, `d6d85daca0139a7adf8a9d683f356f437d7197343dc4980e1af8be95e60489b3`
- Batch 4 (97-end): 33 entries, `7624e4fb9f5591427d042a54f56e75f26d71cf91f079ea4423fe73cce864004a`

## Required Inputs

- Per-source title, Medscape URL, retrieval timestamp, content date, and source revision
- Written permission covering storage, transformation, and research use
- Legal and clinical approval references with reviewer identity and timestamp
- Governed medication-catalog version and canonical ID for each source
- Approved deterministic text/PDF extraction version and reviewed regression expectations

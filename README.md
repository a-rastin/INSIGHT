# INSIGHT

INSIGHT is an explainable research decision-support application. It uses versioned clinical inputs, governed knowledge artifacts, Bayesian inference, attributable clinician review, and immutable Final Treatment Plans.

Final Treatment Plan revisions stay inside the Patient's single Research Case. A revision draft is seeded from the active version, reruns invalidated dependencies and final DDI review, then atomically creates one active successor while preserving every superseded version unchanged and readable.

Psychiatrists can review and print every immutable Final Treatment Plan version and download its hash-pinned JSON export. Final artifacts use masked Patient identifiers, calculate age at Research Case start, retain permitted reproducibility provenance, and remain unavailable to Administrators.

## Verification

Run full local checks with:

```sh
npm run ci
```

Dedicated synthetic vertical-slice coverage runs before browser E2E tests:

```sh
npm run test:e2e:vertical
npm run test:e2e
```

`test:e2e:vertical` requires `TEST_DATABASE_URL` for a PostgreSQL 16 administrative database. It uses only loopback model traffic and fixtures marked `TEST_ONLY`; it does not activate production research, instrument, DDI, catalog, or model permissions. Identified Patient creation remains disabled when required external deployment evidence is absent.

Production-shaped container checks run with:

```sh
npm run test:container
```

The local Medscape archive inventory is frozen under `docs/ddi-import`. Verify source bytes,
canonical order, batch membership, and manifest hashes with:

```sh
npm run ddi:inventory
```

All archive entries remain blocked until ADR-005 permission, source-manifest, medication-mapping,
legal-review, and clinical-review evidence is recorded. Inventory generation never imports or
activates DDI records and never uses live or LLM fallback. Batch 2 positions 33-64 have a frozen
blocked-import report and review-gap record under `docs/ddi-import`; no reviewer identity is inferred.
Batch 3 positions 65-96 have the same frozen governed-block report and review-gap treatment.
Batch 4 positions 97-129 reconcile the final frozen entries with the same blocked treatment.
`docs/ddi-import/coverage-report.json` records final catalog, source, pair, omission, conflict,
rejection, lifecycle-policy, rebuild-hash, and reviewer-sign-off status without fabricating approval.

## Bayesian Pathways

Treatment Setting, long-acting injectable, continuing medication, and clozapine aggressive-behavior, treatment-resistance, and suicide-risk execution use deterministic structured routing,
exact pinned artifact hashes, complete CPT contracts, fixed requested outputs, immutable inference
results, and fail-closed model selection. Evidence, calibration, and clinical-review limits are
published in `docs/reviews/bn-treatment-setting-and-clozapine-pathways.md`; none of these pathways has
attributable clinical approval or calibrated probabilities.

# INSIGHT

INSIGHT is an explainable research decision-support application. It uses versioned clinical inputs, governed knowledge artifacts, Bayesian inference, attributable clinician review, and immutable Final Treatment Plans.

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

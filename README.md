# INSIGHT

INSIGHT is an explainable research decision-support application. It uses versioned clinical inputs, governed knowledge artifacts, Bayesian inference, attributable clinician review, and immutable Final Treatment Plans.

Final Treatment Plan revisions stay inside the Patient's single Research Case. A revision draft is seeded from the active version, reruns invalidated dependencies and final DDI review, then atomically creates one active successor while preserving every superseded version unchanged and readable.

Psychiatrists can review and print every immutable Final Treatment Plan version and download its hash-pinned JSON export. Final artifacts use masked Patient identifiers, calculate age at Research Case start, retain permitted reproducibility provenance, and remain unavailable to Administrators.

Audit access is role-separated in both backend queries and UI routes. Administrators can inspect paginated operational metadata that excludes Patient identifiers and clinical content. Psychiatrists can inspect attributable Patient and Research Case audit history, including retained history after Patient deletion, with before/after values and provenance references. Both views are read-only and state that ordinary PostgreSQL audit rows are not tamper-evident.

## Artifact Storage

`apps/server/src/artifact` owns file-backed XMLBIF, DDI source, export, and large provenance metadata. It accepts only UUID owner/artifact relative paths, validates type and size, writes each final file once, then records byte length, SHA-256, access class, and version. Reads are internal service calls, authorize access, reject traversal or symlink escape, and verify content integrity. A metadata failure after a successful file write can leave an orphan by design; there is no staging, atomic rename, or orphan scanner. Patient deletion removes owned metadata transactionally and makes one post-commit best-effort file removal attempt; repeated deletion requests do not retry cleanup.

## Database Backup

Only an authenticated Administrator can start a backup with `POST /api/v1/admin/backups`, read its status and JSON manifest with `GET /api/v1/admin/backups/{backupId}`, or download its PostgreSQL custom-format dump and manifest. Each manifest records application version, PostgreSQL major version, migration head, creation timestamp, byte length, and SHA-256. Downloads reverify byte length and SHA-256 before serving. Backup actions and operational metadata are audited without Patient identifiers or clinical content.

Backups are manual and PostgreSQL-only. They inherently contain the database-held master key and ciphertext together. INSIGHT provides no Patient preview or selective export, schedule, retention, off-site copy, archive encryption, or artifact backup. **A database backup is incomplete disaster recovery unless the matching artifact volume under `/var/lib/insight/artifacts` survives independently.** Store exported dumps, manifests, and the independently protected artifact volume outside the live PostgreSQL data directory according to deployment controls.

Restore is an explicit offline maintenance operation, never part of normal startup. It validates the manifest, dump hash and readability, PostgreSQL/application/schema compatibility, and every referenced artifact already on the volume before atomically replacing the whole database. It never merges rows or recovers files. Forward migrations and integrity checks must pass before the maintenance marker is removed. See `docs/operations/database-migrations.md` for restore, rollback, and displaced-database cleanup commands.

## Production Deployment

The production image supervises Fastify, one durable-job worker, and PostgreSQL 16. Startup requires a mounted, writable, compatible `/var/lib/insight` volume, starts PostgreSQL on loopback and its Unix socket only, runs schema migrations under the database advisory lock, then starts the worker and Fastify. Readiness reports application, database, and worker separately. `SIGTERM` stops new HTTP work, drains active requests, stops new job claims while allowing active work to settle, checkpoints PostgreSQL, and exits. Expired job leases are reclaimed after restart.

`compose.production.yml` publishes Fastify on host loopback only. Terminate HTTPS at a same-host reverse proxy and expose only that proxy; TLS is required for every non-loopback browser deployment. Do not publish port 5432 or mount the PostgreSQL socket outside the container.

Runtime maintenance permits health probes but blocks all ordinary API and static traffic with `503 MAINTENANCE`:

```sh
docker exec insight sh -c ': > /run/insight/maintenance'
docker exec insight rm /run/insight/maintenance
```

Allow runtime egress only from the container to the hostname and HTTPS port in the active OpenAI-compatible model endpoint configuration. Enforce this with the deployment firewall or egress proxy, update the allowlist when an Administrator changes the configured host, and deny general internet egress. DDI, Bayesian models, assessments, PostgreSQL, artifacts, and browser traffic require no outbound internet access.

This all-in-one deployment is single-instance only. Do not horizontally scale it: each replica would own an independent PostgreSQL server and volume. Recovery uses the supervisor restart policy and durable leases, not replicas.

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

# Database Migrations and Recovery

INSIGHT supports PostgreSQL major version 16 only. The server checks `server_version_num` before reading or changing the schema and refuses other majors. Production and test deployments must pin a PostgreSQL 16 image or package; a major upgrade is a maintenance operation, not an ordinary application rollout.

## Server-only configuration

Set `DATABASE_URL` only in the backend process environment or its server-side secret source. Never place it in Vite variables, browser configuration, URLs returned by the API, logs, audit payloads, or support bundles. Migration commands print schema state and version numbers only.

## Forward migration procedure

1. Stop normal application traffic or keep the application unready.
2. Create and verify the manual PostgreSQL custom-format backup required by ADR-018. Store it outside the live database directory and record the PostgreSQL major, application version, and current migration head.
3. Run `npm run db:migration:head` and confirm the database is compatible with the deployed code.
4. Run `npm run db:migrate`. A session-level PostgreSQL advisory lock serializes competing migration processes. Each migration and its ledger insert commit in one transaction.
5. Rerun `npm run db:migration:head`; `state` must be `current`, and `databaseHead` must equal `codeHead`.
6. Start the server. Startup independently rejects an empty, behind, divergent, or wrong-major database before readiness.

Migrations are forward-only. Never delete, reorder, rename, edit, or reuse a committed migration version. Add a new migration to correct an already-released schema.

## Failure and recovery

Migration failures report the migration version, stable name, and SQLSTATE when PostgreSQL supplies one. They do not include SQL text, connection strings, credentials, or raw driver errors. The failing transaction is rolled back and its ledger row is not written.

After failure:

1. Keep the application stopped or unready. Save the sanitized diagnostic and application version.
2. Run `npm run db:migration:head`. Do not edit `insight_schema_migrations` manually.
3. If the failed migration was never released and its ledger row is absent, correct that migration, verify the recovery against a restored backup, and rerun `npm run db:migrate`.
4. If any part committed outside the migration transaction, the ledger diverged, a migration checksum changed, or the database head is newer than the application, stop. Restore the most recent full database backup whose manifest, checksum, and test restore passed, or deploy the exact application version matching that head. Do not attempt a hand-written down migration in production.
5. For a PostgreSQL major change, remain in maintenance mode, verify a complete backup and restore on PostgreSQL 16, run compatibility checks and forward migrations there, then switch only after integrity and head checks pass.

Restore replaces the complete PostgreSQL database under ADR-019. It does not merge rows, restore selected patients, or recover persistent-volume artifacts.

## Full-replacement restore

Restore is never run by normal container startup. It runs with the HTTP server and job worker absent, restores first into a disposable database, and validates all of the following before replacement:

- manifest schema and required fields;
- dump byte length, SHA-256, PostgreSQL custom-format readability, and PostgreSQL major 16;
- supported application version and a nonempty, nondivergent migration ledger no newer than this build;
- every file-backed artifact path, byte length, and SHA-256 against the existing artifact volume.

Missing, mismatched, non-file, symlinked, or unsafe artifact references fail validation and are reported. No artifact is copied, reconstructed, or reported as recovered. Validation failure leaves the live database unchanged and leaves the maintenance marker present.

1. Export the dump and manifest from the backup API and place both in `/var/lib/insight/backups` on the external volume. Independently confirm the required artifact volume survived.
2. Stop the service so no HTTP process, job worker, or PostgreSQL process remains:

   ```sh
   docker compose -f compose.production.yml stop insight
   ```

3. Run the one-shot maintenance operation with exact volume paths:

   ```sh
   docker compose -f compose.production.yml run --rm insight restore \
     /var/lib/insight/backups/<backup-id>.dump \
     /var/lib/insight/backups/<backup-id>.manifest.json
   ```

4. Record the reported `rollbackDatabase`. Replacement preserves the displaced live database under that name. Forward migrations, schema-head checks, constraint checks, and index checks run against the replacement. Any failure keeps `/var/lib/insight/postgres/.restore-maintenance`, so normal startup remains blocked.
5. Only after status is `RESTORED`, restart and verify readiness plus key workflows, including sign-in and reads of restored encrypted records and artifacts:

   ```sh
   docker compose -f compose.production.yml up -d insight
   ```

### Recovery rollback

For `RESTORE_POST_CHECK_FAILED`, or if verification after a completed restore finds a release-blocking problem, keep or return the service to a stopped state and atomically restore the reported rollback database:

```sh
docker compose -f compose.production.yml stop insight
docker compose -f compose.production.yml run --rm insight restore-rollback <rollback-database>
docker compose -f compose.production.yml up -d insight
```

The rollback operation also runs schema-head and integrity checks before removing the maintenance marker. It preserves the rejected replacement under the reported `displacedDatabase` name. Do not delete either displaced database until operational verification and required evidence retention are complete.

For `RESTORE_VALIDATION_FAILED`, the target database was not replaced. Correct the backup, compatibility, or artifact-volume problem and retry. If recovery is cancelled, an operator may remove `/var/lib/insight/postgres/.restore-maintenance` only after confirming the failure code is `RESTORE_VALIDATION_FAILED`; then restart the unchanged service. For unclassified `RESTORE_FAILED`, do not remove the marker or start traffic. Inspect database names and escalate recovery before choosing the target or rollback database.

After successful verification and retention approval, remove a displaced database from the running container with the exact reported name:

```sh
docker compose -f compose.production.yml exec --user postgres insight dropdb <displaced-database>
```

## Integration test database

`TEST_DATABASE_URL` must target PostgreSQL 16 using a dedicated test administrator role with `CREATEDB`. Run `npm run db:migrate:test`. The suite creates random `insight_test_<uuid>` databases, tests empty and repeated migrations, lock serialization, rollback and repair, startup incompatibility, closes all clients, and then drops each database. Never point this variable at production.

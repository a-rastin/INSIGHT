# ADR-020: Database-Only Backup, Best-Effort Files, and Hard Patient Deletion

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** backup coverage, filesystem/database consistency, Patient deletion authority

## Context

ADR-019 splits artifact files from PostgreSQL and defines full-database replacement restore. The application needs an explicit choice about whether backups include those files, how cross-storage writes behave, and whether research records can be deleted.

## Decision

### PostgreSQL-only manual backup

The Administrator-triggered backup exports PostgreSQL only. It does not include, copy, package, or manifest the persistent-volume artifacts. INSIGHT provides no separate artifact backup operation.

A database restore can recover metadata, protected fields, the database-held master key, and relational records, but cannot recover lost XMLBIF files, DDI source files, generated exports, or file-backed provenance. Recovery is complete only when the existing artifact volume independently survived and still matches the restored metadata.

### Best-effort filesystem-first writes

When creating a file-backed artifact, the backend writes the target file and then inserts or updates its PostgreSQL metadata. There is no temporary staging protocol, atomic rename requirement, content-addressed path rule, distributed transaction, or automatic orphan scanner.

If the file write fails, the database update is not attempted. If the file succeeds and the database operation fails, an unreferenced file may remain indefinitely. A process crash can produce the same result. Hashes are stored for later reads but do not make the creation sequence atomic.

### Psychiatrist hard deletion

Any authenticated Psychiatrist may permanently delete any Patient in the shared registry, regardless of who created or finalized it. Hard deletion removes the primary Patient, its single Research Case, assessments, medical history, medications, AI artifacts, CPT/BN results, DDI results, every Primary and Final Treatment Plan version, and non-audit file-backed artifacts.

There is no soft-delete state, archive, withdrawal state, trash, recovery window, or restore-from-UI operation. Final Treatment Plan immutability protects a plan only while its owning Patient exists; it does not prevent aggregate deletion. ADR-023 explicitly preserves the complete clinical audit history and any payloads required to keep it complete.

Deletion must not be available to Administrators because ADR-007 prohibits their access to Patient content. ADR-021 permits one Psychiatrist to invoke it immediately without password re-authentication, confirmation, delay, or second approval. ADR-023 requires the complete clinical audit history to survive deletion. Database deletion commits first; subsequent file removal is a single best-effort attempt whose failure does not reverse success.

## Consequences

- A database backup is intentionally incomplete disaster recovery for the deployed application.
- Artifact loss cannot be repaired from the application backup.
- Failed metadata writes can leave orphan files containing sensitive or proprietary content.
- Any Psychiatrist account can potentially erase another Psychiatrist's Patient and finalized research outputs.
- Clinical audit history survives and may retain enough Patient information to reconstruct sensitive events; hard deletion is not complete privacy erasure.
- Hard-deleted data cannot be restored unless it happens to exist in an older manual database export and the matching artifact volume also survives.
- Deletion across PostgreSQL and the filesystem cannot be fully atomic under the selected storage design.

## Deletion and Path Resolution

- the PostgreSQL deletion transaction commits first while preserving complete clinical audit history;
- non-audit artifact files then receive one best-effort removal attempt;
- a file-removal failure is logged and the deletion still reports success;
- artifact versions use generated UUID paths and are never overwritten in place;
- no automatic orphan cleanup or retry worker is provided.

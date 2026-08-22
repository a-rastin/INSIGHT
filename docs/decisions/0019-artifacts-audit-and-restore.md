# ADR-019: Volume Artifacts, Simple Audit Tables, and Full Restore

- **Status:** Accepted; completed by ADR-020 and ADR-023
- **Date:** 2026-08-22
- **Scope:** large artifact storage, audit persistence, restore semantics

## Context

INSIGHT stores XMLBIF models, source documents, derived DDI artifacts, exports, and potentially large AI provenance payloads. PostgreSQL and an external persistent volume are available inside the all-in-one deployment. The application also needs audit records and a restore model compatible with manual Administrator-triggered database exports.

## Decision

### Persistent-volume artifact storage

Large or file-native artifacts are stored as files on the external persistent volume rather than in PostgreSQL binary columns. This includes imported XMLBIF files, DDI source documents, generated exports, and large raw provenance objects selected for file storage.

PostgreSQL stores the artifact identifier, owning module, relative storage path, media type, byte length, SHA-256 content hash, lifecycle status, version/provenance references, creator, and timestamps. Database records never store absolute host paths. The backend is the only component allowed to resolve metadata to a path; the browser cannot request arbitrary filesystem locations.

Artifact authorization follows the owning domain record. Administrator access to model and source artifacts does not grant access to Patient-scoped exports or clinical provenance files.

### Ordinary PostgreSQL audit tables

Operational and clinical audit events are stored in normal PostgreSQL tables. They contain event type, actor, timestamp, affected object/version identifiers, and the role-appropriate payload or payload reference.

There is no hash chain, append-only database technology, external audit sink, digital signature, or write-once storage. Application APIs do not expose ordinary edit operations for audit rows, but a sufficiently privileged database actor or defect can alter or delete them without cryptographic detection.

Administrator UI separation remains in force: operational events may be visible, while Patient identifiers and clinical payloads remain unavailable to Administrators.

ADR-023 requires complete clinical audit rows and their clinical payload references to survive whole-Patient deletion. These surviving rows remain ordinary mutable PostgreSQL records and are not tamper-evident.

### Full PostgreSQL replacement restore

Restore runs only in maintenance mode and replaces the entire PostgreSQL database. INSIGHT does not merge backup rows into a live database and does not restore selected Patients or Research Cases.

Before replacement, the restore workflow validates backup format, supported schema/application version, required manifest fields, checksums, and database readability. After replacement, migrations may run only according to the forward migration policy, followed by database integrity checks before normal traffic resumes.

The restore does not itself replace or merge the persistent-volume artifact directory. The restored database must reference files already present at the expected relative paths and hashes. Missing or mismatched files leave their artifacts unavailable and can block dependent workflows. The selected manual database-only backup cannot reconstruct a lost artifact volume.

## Consequences

- PostgreSQL remains smaller than if every source and provenance blob were stored inline.
- Database and filesystem updates cannot share one native transaction. ADR-020 selects best-effort filesystem-first writes without a consistency protocol.
- A database export alone is not a complete disaster-recovery copy of INSIGHT.
- Simple audit tables are easy to implement but are not tamper-evident.
- Full replacement avoids identity and version merge conflicts but requires downtime.
- Restoring database metadata without its matching artifact volume can create widespread broken references.

## Implementation Defaults

- each artifact version receives a generated UUID path and files are never overwritten in place;
- after Patient database deletion commits, related non-audit files receive one best-effort deletion attempt; failure is logged but does not reverse database deletion;
- there is no automatic orphan-file garbage collector;
- clinical audit rows and their required payloads are retained without automatic expiry under ADR-023.

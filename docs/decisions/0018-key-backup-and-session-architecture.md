# ADR-018: Database-Held Master Key, Manual Backups, and Server Sessions

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** application encryption, backup scheduling, authentication sessions

## Context

INSIGHT stores identified research data, official identifiers, and a hosted-model credential in PostgreSQL. Administrators manage operations but cannot inspect Patient content. The all-in-one single-instance deployment needs explicit choices for encryption-key location, backup automation, and browser session state.

## Decision

### Master key stored in PostgreSQL

The application encryption master key is stored in PostgreSQL alongside the values it encrypts. The backend reads it during startup and uses it to encrypt and decrypt protected fields, including official identifiers and the hosted-model credential.

Access to the key row is restricted to the backend database role and is never exposed through the REST API, Administrator UI, logs, audit payloads, or job diagnostics. Key versions are recorded so ciphertext can identify the key used and future rotation remains possible.

This arrangement provides no cryptographic separation from a full database read, database-administrator compromise, SQL injection with sufficient privileges, or a complete database export. An attacker obtaining the database can obtain ciphertext and key material together. Encryption therefore prevents routine plaintext storage and accidental exposure through limited queries, but it is not a control against database compromise.

### Manual Administrator-triggered backup only

INSIGHT has no scheduled backup job, retention schedule, automatic off-site copy, or automatic restore test. An Administrator explicitly triggers a full database export through an operational action. The export is all-or-nothing; the Administrator cannot select or preview Patient records.

The action and resulting backup metadata are audited without exposing Patient content. Because the master key resides in PostgreSQL, a complete export necessarily contains the key material required to decrypt protected fields. ADR-019 selects full database replacement for restore.

The export uses PostgreSQL's standard custom-format dump accompanied by a small JSON manifest containing application version, PostgreSQL major version, schema-migration head, creation timestamp, byte length, and SHA-256 hash. INSIGHT does not add archive-level encryption; deployment transport and storage controls are external.

The manual database export does not include the artifact files stored on the persistent volume under ADR-019. This is the final selected backup coverage, not a deferred feature. Restoring the database depends on the destination already having matching files; INSIGHT provides no artifact export or recovery mechanism.

### PostgreSQL-backed opaque sessions

Successful authentication creates a cryptographically random opaque session token. The browser receives it only in a cookie configured as `HttpOnly`, `Secure`, and an appropriate restrictive `SameSite` mode. The token never appears in URLs, browser storage APIs, or response bodies.

PostgreSQL stores only a one-way hash of the token plus user identity, creation time, last-use time, expiry, revocation status, and security metadata. Every authenticated request resolves the session server-side and rechecks that the account remains enabled.

Logout, account disablement, and relevant password changes revoke sessions centrally. Session duration and concurrent-session limits remain policy values rather than a different authentication architecture.

## Consequences

- Sessions can be revoked immediately without relying on browser cooperation.
- Database access is required for authenticated requests and SSE reconnects.
- Full database compromise exposes encrypted fields and their master key.
- Manual-only backups can be forgotten and can remain untested until a real restore is needed.
- A complete database export contains identified research data and decryption capability within one security boundary but does not contain persistent-volume artifacts.

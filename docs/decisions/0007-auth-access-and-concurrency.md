# ADR-007: Authentication, Administrator Isolation, and Concurrency

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** authentication factors, Administrator patient access, simultaneous edits

## Context

INSIGHT stores identified research records and has only Administrator and Psychiatrist roles. Authentication, Administrator access to patient content, and concurrent-edit behavior had not been selected. Final Treatment Plans are already defined as immutable.

## Decision

### Local password-only authentication

INSIGHT uses locally managed usernames and passwords. It does not require MFA and does not integrate with OIDC or organizational SSO initially.

Password-only does not permit insecure storage or transport. Minimum controls are:

- normalized, case-insensitively unique usernames;
- passwords hashed with Argon2id using versioned, configurable cost parameters and per-password salts;
- no plaintext, reversibly encrypted, logged, or retrievable passwords;
- TLS for every non-loopback deployment;
- rate limits and progressive delay for failed sign-in attempts;
- generic authentication errors that do not reveal whether an account exists;
- secure, `HttpOnly`, `SameSite` session cookies with session rotation after sign-in;
- CSRF protection for state-changing browser requests;
- account disablement and session revocation by an Administrator;
- attributable sign-in, failed-sign-in, password-change, reset, disablement, and sign-out events.

The missing second factor is an accepted account-compromise risk. ADR-008 fixes the initial Administrator credential as `admin/admin` without forced change. ADR-023 defines Administrator-issued temporary-password reset.

Initial policy defaults are:

- passwords created or changed after bootstrap require at least 12 characters; the unchanged bootstrap password is an explicit exception;
- no online breached-password service is called;
- sessions expire after 30 minutes idle or 8 hours absolute, whichever comes first;
- concurrent sessions are allowed without a fixed per-user maximum;
- failed authentication receives progressive delay capped at 60 seconds, without permanent automatic account lockout;
- password change, reset, or account disablement revokes all existing sessions for that user.

ADR-023 resolves password recovery: an Administrator sets a temporary password and all of the target user's sessions are revoked. The user must change that temporary password at the next successful sign-in. No email service or self-service reset flow exists.

ADR-018 defines server-side opaque sessions in PostgreSQL and hardened cookies. Password changes and account disablement revoke applicable active sessions.

### No Administrator patient-content access

Administrators cannot view, search, export, create, edit, or delete Patient records, Research Cases, assessments, medications, DDI results, draft plans, Final Treatment Plans, or clinical audit payloads. There is no Administrator break-glass mechanism.

The backend enforces this rule on every patient-scoped route and MCP tool; hiding UI navigation is insufficient. Administrator-visible logs contain operational identifiers and events but exclude names, official identifiers, patient UUIDs, free text, clinical values, and plan content.

Backups remain opaque and encrypted to Administrators during ordinary operation. Restore procedures may move encrypted database material but do not grant application-level access to decrypted patient content.

Psychiatrists can access patient content according to the application workflow. With no Auditor role, independent read-only clinical review is unavailable inside INSIGHT.

ADR-020 permits any Psychiatrist to permanently delete any Patient and all related clinical data and artifacts. Administrator prohibition remains unchanged; Administrators cannot initiate Patient deletion.

### Last-write-wins mutable drafts

Patient and Research Case data remain mutable until the relevant workflow is finalized. When two Psychiatrist sessions save the same mutable record, the newest committed save replaces the prior current value. INSIGHT does not reject stale saves, merge changes, lock the record, or show a conflict-resolution prompt.

Each save still records actor, timestamp, record identity, and an attributable clinical change event. Clinical change payloads remain inaccessible to Administrators.

Last-write-wins never applies to a finalized treatment plan. Finalization is transactional and idempotent:

- the first successful finalization creates an immutable record;
- a retry with the same idempotency key returns the same result;
- a concurrent stale request cannot overwrite the immutable result;
- later changes require a new explicitly superseding plan that preserves the prior version.

## Consequences

- Compromising one password is sufficient to access that account because no second factor exists.
- Administrator troubleshooting cannot inspect patient content, even during an incident.
- Clinical support and independent audit require a Psychiatrist account or an external approved process.
- Concurrent Psychiatrist work can be silently lost when a later save overwrites an earlier save.
- The audit history can establish that an overwrite occurred but does not prevent it.
- Final-plan immutability and idempotency remain stronger than ordinary draft-save behavior.
- Final-plan immutability does not prevent whole-Patient hard deletion under ADR-020.

## Resolution Map

- bootstrap Administrator behavior: ADR-008;
- password reset: ADR-023;
- session storage: ADR-018;
- cross-Psychiatrist access: ADR-008 and ADR-020;
- clinical audit access and deletion residue: ADR-019 and ADR-023.

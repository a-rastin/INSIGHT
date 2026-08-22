# ADR-023: Surviving Clinical Audit, Password Reset, and Vertical Slice

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** deletion residue, account recovery, initial implementation sequence

## Context

The architecture permits immediate Patient hard deletion by any Psychiatrist, uses local password-only accounts, and contains many unimplemented modules. The remaining decisions determine what survives deletion, how locked-out users recover, and how implementation begins without building every module in isolation.

## Decision

### Complete clinical audit survives Patient deletion

Deleting a Patient removes the primary operational aggregate but preserves the complete clinical audit history. Surviving audit records retain their original Patient and Research Case references, event types, actors, timestamps, before/after clinical payloads, provenance references, and any audit payload artifacts required for completeness.

The deleted Patient is no longer available through ordinary registry or workflow routes. Authorized clinical audit access can still reveal the retained history. Administrators remain unable to see Patient identifiers or clinical payloads.

This is not anonymization and not complete erasure. Audit rows use the ordinary mutable PostgreSQL architecture in ADR-019; retention does not make them tamper-evident.

### Administrator-issued temporary passwords

There is no email service, password-reset link, recovery code, or external identity provider. An Administrator selects a user and assigns a new temporary password through the user-management UI.

The backend hashes the temporary password with the normal Argon2id policy, marks the account `PASSWORD_CHANGE_REQUIRED`, and revokes all existing sessions in the same transaction. After successful authentication, the user can access only the password-change operation until a new password is saved; that change revokes the temporary credential state and rotates the session.

The reset event is attributable but never stores either plaintext password. If the only Administrator loses access, INSIGHT has no in-app recovery authority.

### End-to-end vertical slice first

Implementation begins with a single deployable vertical slice rather than completing all backend modules before UI integration or building every module in parallel. The slice includes:

1. local authentication, Administrator user creation/reset, and Psychiatrist session;
2. one Patient and its single Research Case;
3. DSM-5-TR, PANSS, and the governed C-SSRS assessment paths, including bypass states;
4. current medication capture and terminology normalization;
5. one governed DDI execution path;
6. deterministic routing to one structurally passing BN pathway;
7. patient-specific CPT generation, validation, snapshot persistence, and inference;
8. one schema-valid Primary Treatment Plan, Psychiatrist edit/recheck, and immutable Final Treatment Plan;
9. audit, durable-job progress, and failure behavior across the slice.

`BNs/Pharmacotherapy/BN-Pharmacotherapy.xml` is the initial candidate because the repository structural audit did not place it among the malformed or unsupported XML artifacts. This establishes software suitability only. Its probabilities and clinical claims remain research artifacts and must satisfy the same governance and visible calibration limitations as every other BN.

Later packets expand catalogs, pathways, administration, operational polish, and remaining research workflows only after this slice works end to end.

## Consequences

- Patient deletion leaves substantial sensitive clinical history in the database.
- Password recovery needs no mail or external identity service.
- Loss of the sole Administrator credential can require an out-of-band database procedure not currently specified.
- Integration failures surface early because the first implementation crosses browser, backend, jobs, MCP, model, BN, DDI, and persistence boundaries.
- The selected Pharmacotherapy model cannot be described as clinically valid merely because it is structurally loadable.

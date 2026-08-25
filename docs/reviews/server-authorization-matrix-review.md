# Server Authorization Matrix Security Review

## Status

Engineering security review completed for the generated matrix and automated negative suite. Independent human security sign-off remains required before release.

## Reviewed boundaries

- Every registered REST and SSE `operationId` must match `REST_AUTHORIZATION_OPERATION_IDS`; missing or extra entries fail `test/authorization-matrix.test.mjs`.
- `AUTHORIZATION_MATRIX` partitions every principal into explicit allow and deny lists and fails closed for unknown commands or invalid workflow states.
- Current HTTP identity comes only from the server-resolved, non-revoked session. Navigation visibility is not an authorization control.
- Patient, Research Case, clinical audit, MCP, orchestration, and job rows deny Administrators and use shared active-Psychiatrist Patient authority rather than creator ownership.
- User, deployment, operational audit, model endpoint, knowledge-governance mutation, and backup rows deny Psychiatrists.
- Patient and workflow services revalidate the current persisted Psychiatrist role and enabled status. Artifact, backup, audit, orchestration, and job boundaries perform their own persisted actor or object checks.
- MCP tools require a server-issued subject binding, exact execution and job IDs, current Research Case revision and state, and the state-derived allowlist.
- Restore and rollback are unavailable to application roles and remain offline maintenance-operator commands.
- Immediate Psychiatrist Patient deletion, idempotent repeated deletion, retained audit, and shared registry semantics are unchanged.

## Object-access review

- Patient objects: all active Psychiatrists share authority; Administrators are denied before clinical payload retrieval.
- Jobs and SSE: access follows active Psychiatrist authority over the shared Patient registry, not `requested_by_user_id`; each SSE reconnect resolves a current session.
- Artifacts: access follows persisted `access_class` and, for `OWNER`, exact actor ID; traversal, symlink escape, size, hash, and media checks remain enforced.
- Backups: active Administrator role is revalidated; IDs are parameterized and dump integrity is rechecked before download.
- Final-plan exports and clinical audit: both Patient ID and nested object ID are constrained by service queries and remain Psychiatrist-only.
- Workflow and MCP: accepted commands are constrained by current persisted state and revision, not client-provided state.

## Verification evidence

- Generated inventory: `docs/security/authorization-inventory.md` via `npm run authorization:generate`.
- Staleness check: `npm run authorization:check`.
- Exhaustive allow/deny and registration parity: `test/authorization-matrix.test.mjs`.
- Existing negative suites: authentication, audit, artifact, backup, jobs/SSE, MCP, Patient deletion, restore, treatment-plan finalization, and workflow integration tests.
- Local-only unit suite: 134 server tests and 56 web tests passed on 2026-08-25.

## Human review checklist

Reviewer must confirm:

- every generated row matches intended product authority and data classification;
- no production route, worker command, MCP tool, restore path, or artifact read bypasses listed boundary;
- Administrator responses and operational logs contain no Patient identifier, clinical payload, or clinical artifact;
- Psychiatrist requests cannot mutate users, deployment evidence, endpoint credentials, governed administrative history, backup, or restore state;
- cross-Psychiatrist Patient, job, audit, and workflow access is intentionally shared;
- immediate Patient deletion and repeated-deletion behavior remain accepted;
- database-backed negative integration suite passes in release environment.

No independent human sign-off is recorded in this repository yet.

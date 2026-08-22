# INSIGHT Implementation Plan

This plan implements the accepted architecture as end-to-end packets. A packet is complete only when its code, migrations, tests, OpenAPI contract, security checks, and relevant documentation are complete.

## Documentation foundation

- [x] Resolve architecture-shaping product decisions through MCQs.
- [x] Record the accepted decisions in ADR-001 through ADR-023.
- [x] Define the system architecture, domain model, MCP contract, product workflow, and vertical-slice sequence.
- [x] Audit the local C-SSRS source and record its activation gaps.
- [x] Audit the existing XMLBIF collection for structural eligibility and quarantine known failures in repository documentation.
- [x] Define the provider-neutral Chat Completions transport, endpoint-activation probe, secret handling, and compatibility acceptance matrix.

## Packet 0 - Minimal deployable foundation

- [ ] Create the TypeScript workspace for React/Vite, Fastify, shared runtime schemas, and environment-independent Bayesian logic.
- [ ] Add the single production image, embedded PostgreSQL service, external artifact volume, migrations, and local development configuration.
- [ ] Establish versioned REST/OpenAPI contracts, authenticated SSE, and CI for formatting, linting, type checking, tests, migrations, and production build.

## Packet 1 - First end-to-end Research Case

This packet is deliberately vertical. It is not complete until one synthetic case crosses the whole production-shaped path.

- [ ] Implement local `admin/admin` bootstrap, Administrator user creation/reset, and one authenticated Psychiatrist session.
- [ ] Register one Patient with one Research Case, then capture the three assessment states, current medicines, and the minimum medical history required by the Pharmacotherapy path.
- [ ] Activate a governed C-SSRS artifact and one permitted/versioned Medscape DDI path; implement deterministic assessment and DDI results for the slice.
- [ ] Implement the internal MCP Gateway, de-identified model projection, PostgreSQL durable job, bounded retry, and SSE progress needed by the slice.
- [ ] Normalize medicines, route deterministically to the governed `BN-Pharmacotherapy.xml`, generate and check all CPTs, persist the snapshot, and run deterministic inference.
- [ ] Produce one structured Primary Treatment Plan, allow a Psychiatrist edit, rerun DDI for the exact regimen, and create an immutable Final Treatment Plan.
- [ ] Record the complete audit/provenance chain and cover success, bypass, malformed model output, unavailable dependency, and idempotent retry with an end-to-end synthetic-data suite.

## Packet 2 - Identity and Patient lifecycle completion

- [ ] Complete Argon2id policy, opaque PostgreSQL sessions, CSRF protection, revocation, forced password change, username/password administration, and Patient-content isolation from Administrators.
- [ ] Complete official-identifier normalization/uniqueness, duplicate demographic overwrite, age rules, shared Psychiatrist access, and last-write-wins drafts.
- [ ] Implement immediate Psychiatrist hard deletion with surviving complete clinical audit payloads and Patient linkage.

## Packet 3 - Assessment and medical-history completion

- [ ] Complete versioned DSM-5-TR and PANSS schemas, live calculation, unrestricted bypass, and partial-answer deletion.
- [ ] Complete C-SSRS branching, timeframes, banding, source/version pinning, permission/training activation records, and separate hidden AI-imputation records.
- [ ] Complete presentation status, conditional previous-treatment flow, structured antipsychotic trials, comorbidity catalog, contraindication rules, and current-medication capture.

## Packet 4 - Medication and DDI expansion

- [ ] Complete the governed medication catalog plus `medication.*` search, candidate, commit, and `UNKNOWN` behavior.
- [ ] Build the versioned Medscape source manifest and extraction pipeline, then expand deterministic `ddi.*` coverage to every governed catalog medicine.
- [ ] Evaluate current/current and current/proposed pairs, exclude every detected interaction from automatic generation, and support warning-only clinician reintroduction with mandatory recheck.

## Packet 5 - MCP, model, and job hardening

- [ ] Complete the persisted workflow state machine and every namespaced tool contract in `docs/architecture/mcp-contracts.md`.
- [ ] Harden job leases, idempotency, restart recovery, sanitized diagnostics, authorization, and state-based tool allowlists.
- [ ] Complete encrypted Administrator-managed endpoint configuration, write-only credential rotation, normalized base-URL resolution, the two-request tool-call activation probe, configuration invalidation, no-fallback behavior, and direct-identifier exclusion before every model-visible call.
- [ ] Cover nested and trailing-slash base URLs, Bearer authentication, string/object tool arguments, tool-result round trips, secret redaction, timeout/malformed responses, `401`/`404`/`429`/`5xx` mapping, configuration rotation, and one activated-config synthetic MCP workflow with local mock-server tests.

## Packet 6 - Bayesian library and integrated BN Manager

- [ ] Extract XMLBIF parsing, serialization, checks, transforms, and hashing from Bayes Engine without Electron dependencies.
- [ ] Govern the model registry, quarantine malformed or unsupported artifacts, and expand deterministic routing beyond the Pharmacotherapy pathway.
- [ ] Rebuild Bayes Engine administration inside the React shell with upload, graph/table editing, versioning, automatic activation, rollback, and audit.

## Packet 7 - Treatment, audit, and artifact lifecycle completion

- [ ] Complete the plan schema for regimen, titration, monitoring, rationale, warnings, clinician edits, and full provenance.
- [ ] Complete AI-imputation notice rules, immutable idempotent Final Plans, superseding versions without rationale, and final/export presentation rules.
- [ ] Complete clinical/operational audit views and best-effort file storage with PostgreSQL metadata, hashes, authorization, and orphan handling.

## Packet 8 - Operations and research hardening

- [ ] Implement manual PostgreSQL-only Administrator backup and full-replacement restore in maintenance mode.
- [ ] Exercise artifact-volume loss, database replacement, job recovery, model failure, DDI failure, and sole-Administrator loss procedures.
- [ ] Check single-tenant deployment, LLM-only intended egress, TLS guidance, input limits, rate limits, and all accepted-risk warnings.
- [ ] Run the complete acceptance suite with synthetic data and document every remaining research-only limitation before deployment activation.

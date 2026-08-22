# INSIGHT

INSIGHT is a research-only, clinician-facing decision-support prototype for schizophrenia care. It is intended to combine structured assessments, drug-interaction checks, and versioned Bayesian-network pathways into an explainable draft treatment plan that a psychiatrist must review and explicitly approve or modify.

> **Safety status:** The repository contains no documented evidence establishing safety or effectiveness for any patient population, care setting, diagnosis, prescription, or emergency workflow. Development and demonstration use synthetic or properly de-identified data. Identified records are permitted only inside a formally approved research environment after its required security controls are enabled.

## Accepted Product Direction

- **Stage:** research prototype.
- **Initial architecture:** modular monolith with explicit module boundaries.
- **Technology stack:** TypeScript end-to-end, with React/Vite in the browser, Node.js/Fastify on the server, and PostgreSQL for persistence and durable jobs.
- **Runtime:** desktop-first web application; application and PostgreSQL run together in one container backed by an external persistent volume.
- **Tenancy:** every deployment represents one research organization/project. There is no tenant-isolation layer inside an instance.
- **Network:** clinical data, DDI, BN, database, and artifact operations remain local; the backend requires outbound HTTPS only to the configured hosted-model endpoint.
- **Persistence:** PostgreSQL is the system of record.
- **Artifact storage:** XMLBIF models, DDI source files, exports, and large provenance payloads live on the external persistent volume; PostgreSQL stores their paths, metadata, and content hashes.
- **Artifact consistency:** filesystem writes occur best-effort before the database row is written; there is no atomic staging protocol, content-addressed storage, or automatic orphan cleanup.
- **Encryption key:** the application encryption master key is stored in the same PostgreSQL database as the encrypted values. This does not protect secrets or identifiers from full database compromise.
- **Backup:** INSIGHT provides only manual Administrator-triggered database exports; there is no scheduled backup or automatic restore verification.
- **Backup coverage:** the manual export contains PostgreSQL only. Persistent-volume artifacts have no application-supported backup and cannot be recovered from the database export.
- **Restore:** restore replaces the complete PostgreSQL database in maintenance mode after compatibility and integrity checks. It does not merge records or restore selected Patients.
- **Roles:** Administrator and Psychiatrist only.
- **Authentication:** local username and password only; every installation starts with `admin/admin`, and changing it is not mandatory.
- **Sessions:** authentication uses opaque random session tokens, hashed server-side in PostgreSQL and carried only in `HttpOnly`, `SameSite=Strict`, normally `Secure` cookies. Unsafe API requests require a session-bound CSRF token; logout, password change/reset, and account disablement revoke sessions centrally. Failed sign-ins receive progressive delay and generic responses.
- **Gateway navigation:** the backend-restored session role selects the complete Administrator or Psychiatrist navigation contract and guards page rendering. Administrator routes cannot render Patient pages or summaries.
- **Research-use entry:** each Psychiatrist must acknowledge the research-use notice before first workspace entry in that browser profile; acknowledgement is stored per account and restored safely on refresh.
- **Password recovery:** an Administrator assigns a temporary password to a user; every existing session is revoked and the user must replace the temporary password after sign-in.
- **Audit storage:** audit events use ordinary PostgreSQL tables without hash chaining or an external audit service; database-level modification is not tamper-evident.
- **Deletion audit:** permanent Patient deletion preserves the complete clinical audit history, including clinical payloads and Patient linkage. Deletion is therefore not erasure of all Patient information.
- **Administrator data boundary:** Administrators cannot access patient clinical content and have no break-glass path.
- **Draft concurrency:** the newest mutable save wins without a conflict prompt; finalized plans remain immutable.
- **Patient authority:** every Psychiatrist can view, edit, and finalize every Patient and its Research Case; records are not partitioned by creator.
- **Patient deletion:** any Psychiatrist may immediately delete any Patient, Research Case, finalized plans, and related artifacts without re-authentication, confirmation, or second approval. Complete clinical audit history survives deletion.
- **Bayesian model tooling:** Bayes Engine capabilities will become the administrator-facing BN Manager inside INSIGHT.
- **Bayes Engine integration:** reusable TypeScript XMLBIF parsing, validation, and transform logic is extracted into the main application; BN Manager screens are rebuilt in the React shell and production has no Electron dependency.
- **Jurisdiction:** jurisdiction-neutral product core; no country-specific law or identifier is assumed globally.
- **Research records:** identified records may be used only under formal research approval and enforced security controls.
- **Identified-data gate:** identified Patient creation is disabled by default. An Administrator records immutable, versioned EXT-01 deployment evidence and separately activates its latest version only after every configured approval and security prerequisite passes. Evidence changes and approval expiry disable the mode. INSIGHT records external evidence; it does not grant ethics or legal approval.
- **Patient identity:** each patient has a canonical internal UUID and a mandatory official identifier whose type and issuer are deployment-configured.
- **Patient demographics:** duplicate normalized official identifiers resolve to the existing record. Any submitted name, birth-date, or sex differences automatically overwrite that record without confirmation. Birth date and binary `MALE`/`FEMALE` sex are mandatory. Age is calculated against today in the current profile and against the Research Case start date in its clinical artifacts.
- **Clinical history:** each clinical workflow requires a structured `FIRST_PRESENTATION` or `KNOWN_SCHIZOPHRENIA` status. Previous antipsychotic trials are repeating structured records with medication, dose, treatment period, response, adverse effects, discontinuation reason, and notes.
- **Single Research Case:** this research app has exactly one Research Case per Patient. It has no Encounter, visit, or second-case feature now or in the planned scope.
- **AI integration:** a hosted LLM orchestrates MCP tools, uses all patient context to regenerate every CPT as a patient-specific snapshot, and drafts the plan. The inference engine does not separately apply patient facts as BN evidence. Only de-identified data may cross the model boundary.
- **Workflow authority:** the backend owns a deterministic persisted state machine. It decides which transitions and MCP tools are allowed at each stage; the LLM may orchestrate only that allowlisted subset and cannot declare the workflow complete or finalize a plan.
- **MCP topology:** one backend-internal MCP Gateway exposes namespaced tools for the modular-monolith domains. The hosted model emits tool requests through the backend agent runtime; neither the gateway nor individual module tools are public services.
- **Long-running work:** LLM, imputation, CPT, BN, DDI, and plan-generation executions run as durable PostgreSQL-backed jobs that survive restart and publish progress to the UI.
- **Browser boundary:** the browser communicates only with the backend. Provider credentials, hosted-LLM calls, MCP access, clinical orchestration, and database access remain server-side.
- **Model endpoint:** the backend directly targets one Administrator-configured OpenAI-compatible Chat Completions base URL and model through native server-side HTTP. It preserves provider path segments, appends only `chat/completions`, uses Bearer authentication, and requires a two-request tool-call probe before activation. There is no provider-specific adapter.
- **HTTP contract:** the browser uses a versioned REST/JSON API described by generated OpenAPI; durable-job progress is delivered through authenticated Server-Sent Events.
- **Model configuration:** Administrators configure the OpenAI-compatible base URL, model, and encrypted credential through the UI. Stored credentials are write-only and never returned to the browser. Any configuration change disables AI jobs until the exact saved configuration passes the compatibility probe.
- **Model outage:** calls receive bounded retries against the configured endpoint only. Exhaustion fails closed; INSIGHT never switches endpoint or model automatically.
- **Hosted-model data policy:** any compatible endpoint may receive de-identified projections even if its retention, training, or data-processing terms are undocumented or permit provider use. Direct identifiers remain prohibited.
- **CPT execution:** a valid patient-specific CPT snapshot is reused while its Research Case inputs, base model, prompt, and schema remain unchanged. Invalid output receives at most two LLM retries; continued failure blocks BN use and plan finalization.
- **Assessment bypass:** diagnosis, PANSS, and suicide-risk assessments may each be bypassed without entering a reason. A bypass is stored explicitly and must never be interpreted as a normal, negative, or completed result.
- **Suicide-risk instrument:** the governed instrument is the local C-SSRS Screen Version - Recent. Its six questions, branching, timeframes, and Low/Moderate/High color mapping are implemented deterministically from the pinned source artifact.
- **Assessment imputation:** when an assessment is bypassed, the hosted LLM synthesizes its missing answers and scores for CPT generation and plan drafting. These synthetic values are separate from the official `BYPASSED` assessment record.
- **Imputation visibility:** the mutable Primary Treatment Plan shows only a generic notice that AI imputation was used, not its details. The notice is removed on finalization and does not appear in the Final Treatment Plan or printed/exported output. Even an imputed high suicide-risk classification produces no direct warning.
- **Suicide-risk behavior:** even a completed high-risk result is informational only and does not require acknowledgement, an action record, escalation, or a finalization block. If a partially answered assessment is bypassed, its answers—including high-risk answers—are discarded.
- **DDI knowledge:** the current local Medscape archive is the selected source, but DDI operation remains disabled until reuse permission and a versioned freshness manifest are documented.
- **DDI findings:** every interaction severity is warning-only. A Psychiatrist may accept any flagged combination, and no finding itself blocks plan finalization; inability to complete the required DDI check still blocks finalization.
- **Medication normalization:** LLM-selected canonical medication identities are accepted automatically without Psychiatrist review and become the identities used by DDI, BN, and treatment-plan processing.
- **Unknown medications:** a medication with no usable catalog match is retained as `UNKNOWN`; interactions involving it are not evaluated, but the workflow and plan finalization continue. Only a small generic warning appears on the DDI page.
- **Primary-plan DDI filtering:** the generated Primary Treatment Plan excludes every drug for which the completed DDI check reports any interaction. The Psychiatrist may manually add it afterward and proceed after the required recheck.
- **BN routing:** a versioned deterministic backend routing table selects the relevant active Bayesian pathways from structured Research Case data; the LLM cannot select networks.
- **Treatment Plan schema:** plans are structured objects containing regimen medication, dose, route, frequency, titration, monitoring, rationale, warnings, and full provenance; unrestricted free text is not the system of record.
- **Comorbidity rules:** comorbidities and contraindications use governed, versioned database catalogs and deterministic rules rather than frontend constants or LLM-only interpretation.
- **Model activation:** a Bayesian-model version activates immediately in Psychiatrist workflows after all required software checks pass; clinical approval is not an activation gate.
- **DDI freshness:** active DDI content has no time-based expiry and remains usable until an Administrator retires or supersedes it.
- **Failure behavior:** required DDI, BN, or MCP failures block treatment-plan finalization.
- **Clinical authority:** generated plans are explainable drafts; the psychiatrist remains the final decision-maker.
- **Record integrity:** finalized plans must be attributable and immutable; later plans supersede rather than overwrite them.
- **Plan revisions:** the single Research Case may contain multiple immutable Final Treatment Plan versions. A new version supersedes the prior active version without creating a second case or altering history.
- **Previous-treatment fields:** only the medication is mandatory in each historical antipsychotic trial. Dose, period, response, adverse effects, discontinuation reason, and notes may all be absent. When entered, adverse effects use a multi-select catalog plus `OTHER` free text.
- **Adverse-effect governance:** Administrators own a versioned adverse-effect catalog. `OTHER` may be selected with no explanatory text. Superseding a Final Treatment Plan requires no reason or explanation.
- **Initial implementation:** development starts with one end-to-end vertical slice using authentication, one Patient/Research Case, the three assessments, the structurally passing Pharmacotherapy BN candidate, DDI, and one Final Treatment Plan before expanding modules.

Supporting decision records:

- [ADR-001: Product Foundation](docs/decisions/0001-product-foundation.md)
- [ADR-002: Jurisdiction, Research Data, and MCP Client Boundary](docs/decisions/0002-data-and-mcp-boundary.md)
- [ADR-003: Patient Identity and Hosted LLM Boundary](docs/decisions/0003-identity-and-llm-boundary.md)
- [ADR-004: Web Runtime, PostgreSQL, and Roles](docs/decisions/0004-runtime-data-and-roles.md)
- [ADR-005: DDI Source, Model Activation, and Failure Policy](docs/decisions/0005-knowledge-activation-and-failure.md)
- [ADR-006: Immediate Activation, Manual Freshness, and All-in-One Deployment](docs/decisions/0006-operational-scope.md)
- [ADR-007: Authentication, Administrator Isolation, and Concurrency](docs/decisions/0007-auth-access-and-concurrency.md)
- [ADR-008: Patient-Specific CPTs, Default Administrator, and Shared Registry](docs/decisions/0008-cpt-admin-and-patient-scope.md)
- [ADR-009: CPT Snapshot Lifecycle and Assessment Bypass](docs/decisions/0009-cpt-snapshot-and-assessment-bypass.md)
- [ADR-010: Suicide-Risk and DDI Warning-Only Policy](docs/decisions/0010-suicide-risk-and-ddi-warning-policy.md)
- [ADR-011: Automatic Medication Normalization and Assessment Imputation](docs/decisions/0011-medication-normalization-and-assessment-imputation.md)
- [ADR-012: Patient Uniqueness and Demographic Fields](docs/decisions/0012-patient-identity-and-demographics.md)
- [ADR-013: Single Research Case and Clinical History](docs/decisions/0013-single-research-case-and-clinical-history.md)
- [ADR-014: Final Plan Supersession and Optional Trial Details](docs/decisions/0014-plan-supersession-and-trial-details.md)
- [ADR-015: Internal MCP Gateway, Durable Jobs, and Browser Boundary](docs/decisions/0015-mcp-jobs-and-browser-boundary.md)
- [ADR-016: TypeScript Stack, Bayes Integration, and Model Endpoint](docs/decisions/0016-stack-bayes-and-model-endpoint.md)
- [ADR-017: REST API, Administrator Model Secrets, and No Fallback](docs/decisions/0017-api-model-secrets-and-fallback.md)
- [ADR-018: Database-Held Master Key, Manual Backups, and Server Sessions](docs/decisions/0018-key-backup-and-session-architecture.md)
- [ADR-019: Volume Artifacts, Simple Audit Tables, and Full Restore](docs/decisions/0019-artifacts-audit-and-restore.md)
- [ADR-020: Database-Only Backup, Best-Effort Files, and Hard Patient Deletion](docs/decisions/0020-backup-files-and-patient-deletion.md)
- [ADR-021: Single Tenancy, LLM-Only Egress, and Immediate Deletion](docs/decisions/0021-tenancy-network-and-deletion.md)
- [ADR-022: C-SSRS, Deterministic Clinical Routing, and Structured Plans](docs/decisions/0022-clinical-routing-and-plan-schema.md)
- [ADR-023: Surviving Clinical Audit, Password Reset, and Vertical Slice](docs/decisions/0023-audit-reset-and-vertical-slice.md)

Implementation-facing specifications:

- [Interactive Architecture Schematic](insight-architecture-schematic.html)
- [Persian Architecture Schematic](insight-architecture-schematic-fa.html)
- [System Architecture](docs/architecture/system-architecture.md)
- [Domain Model](docs/architecture/domain-model.md)
- [MCP Contract](docs/architecture/mcp-contracts.md)
- [Implementation Plan](Plan.md)
- [C-SSRS Local Source Audit](docs/reviews/cssrs-source-audit.md)
- [Product and Workflow Requirements](docs/product/product-and-workflow-requirements.md)

## Intended Workflow

1. An administrator manages users, system configuration, knowledge artifacts, audit records, and backups.
2. A psychiatrist signs in and acknowledges the research-use notice.
3. The psychiatrist creates or finds a Patient and opens its one Research Case.
4. Structured diagnosis, PANSS severity, medical history, medication, and safety information is collected. Diagnosis, PANSS, and suicide-risk assessments may instead be explicitly bypassed without a rationale; the missing result remains visible downstream.
5. Versioned DDI and Bayesian pathways produce recommendation evidence.
6. INSIGHT assembles an explainable Primary Treatment Plan as a draft.
7. The psychiatrist reviews and edits the draft; changes remain attributable but require no rationale. Medication changes trigger another DDI check.
8. Explicit approval creates an attributable, immutable Final Treatment Plan.

## Planned Modules

- Authentication and role-based access
- Administration and system operations
- Patient identity and single Research Case management
- Schizophrenia diagnostic checklist
- PANSS assessment
- Medical history and medication capture
- Drug-drug interaction evaluation
- BN Manager and model governance
- Treatment Plan orchestration, review, and finalization
- Audit, provenance, backup, and restore

These are target boundaries, not claims that the modules are implemented.

## Repository Status

The root now contains the initial TypeScript workspace for INSIGHT:

- `apps/web` is the React/Vite browser entry point with role-owned navigation and the Psychiatrist-only shared Patient Registry, create, and profile pages.
- `apps/server` owns the versioned `/api/v1` Fastify boundary, safe error envelopes, server-generated request IDs, generated OpenAPI, database/worker-aware readiness, a supervised worker runtime, and production delivery of the React build with SPA fallback.
- `apps/server/src/deployment` owns the EXT-01 evidence lifecycle and identified-data gate. Its Administrator API exposes deployment evidence only; operational audit rows retain actor, evidence version, environment status, request ID, and timestamp without Patient or approval content.
- `apps/server/src/audit` owns Administrator-only operational audit queries. Its result type contains operational metadata only and has no clinical payload or decryption path.
- `apps/server/src/patient` owns configured official-identifier normalization, encrypted Patient demographics, transactional duplicate overwrite, one-to-one Research Case creation, calendar-age calculation, and encrypted before/after audit events. Patient services and routes reject Administrators.
- `apps/server/src/database` owns PostgreSQL 16 pooled access, UTC sessions, transaction handling, forward-only migration locking and ledger checks, startup schema enforcement, safe diagnostics, and isolated integration-test databases.
- `packages/contracts` owns browser-safe version 1 TypeBox runtime schemas and inferred types for UUIDs, RFC 3339 timestamps, fixed roles, API errors, pagination, and provenance. It also provides deterministic JSON serialization, Web Crypto SHA-256 helpers, and explicit unsupported-version errors; lint and contract tests prohibit server, database, secret, and Node-only imports at the browser boundary.
- `packages/bayes` is the migration boundary for environment-independent Bayesian logic.
- `Bayesian-Engine/` remains intact as the standalone Electron migration source and is not a root workspace.

The workspace is intentionally minimal while the production vertical slice is built. The root supports clean installation plus format, lint, typecheck, test, and build checks.

## Continuous Integration

GitHub Actions runs the complete root pipeline against a local PostgreSQL 16 service. Run the same pipeline locally with `DATABASE_URL` and `TEST_DATABASE_URL` pointing to a disposable PostgreSQL 16 database whose role can create databases:

```bash
npm ci
npx playwright install --only-shell chromium
npm run ci
```

`npm run ci` enforces formatting, lint, TypeScript, unit and PostgreSQL integration tests, forward migrations, OpenAPI drift, production builds, container volume smoke tests, browser E2E smoke, and test-artifact privacy scanning. All test processes are restricted to loopback and Unix-socket services; hosted-model and medical-source traffic fails immediately. Browser E2E applies the same local-origin policy. Patient fixtures must use `makeSyntheticPatientIdentity()` from `test/support/synthetic-data.mjs`.

Only npm's download cache is retained in CI. Build output, databases, browser state, traces, screenshots, and test reports are not cached or uploaded. The root workspace includes only `apps/*` and `packages/*`; CI never installs, builds, tests, or packages the standalone Electron application in `Bayesian-Engine/`.

Representative failure contracts:

- malformed formatting, lint violations, and TypeScript errors fail their dedicated static checks;
- changed behavior fails unit tests, and changed migration SQL/checksums or rollback behavior fails PostgreSQL integration tests;
- stale generated API files fail `api:check`;
- missing browser headings, console errors, or external browser requests fail Playwright smoke;
- compilation/bundling defects fail production builds;
- credential patterns, non-synthetic identifiers, or non-test email addresses fail artifact scanning.

## Web UI Development

`apps/web` provides the desktop-first React/Vite shell. It includes local sign-in, forced temporary-password replacement, role-specific navigation, Administrator user management, and Psychiatrist-only Patient Registry list/search/create/profile flows. Patient searches remain in browser memory, duplicate create responses open the canonical profile directly, and Patient names, demographics, and official identifiers never enter client URLs or logs. The shell also provides relative client-side routes, semantic landmarks, a root error boundary, approved light-theme design tokens, responsive behavior down to 320px, and shared accessible state primitives. Dark mode is intentionally unavailable until approved tokens and accessibility review exist.

Run `npm test --workspace @insight/web` for focused component and WCAG A/AA smoke tests. Run `npm run typecheck --workspace @insight/web` and `npm run build --workspace @insight/web` for package checks.

## API Development

Runtime TypeBox schemas are authoritative at the Fastify boundary. The published contract is checked in at `docs/api/openapi.v1.json`; generated browser types and the relative-URL `openapi-fetch` client live under `apps/web/src/generated`. Run `npm run api:generate` after any route-schema change. `npm run api:check` regenerates in memory and fails when the OpenAPI document, browser types, or client are stale.

Operational placeholders are available at `GET /api/v1/health` and `GET /api/v1/ready`. The current OpenAPI document is served at `GET /api/v1/openapi.json`. All API errors use the version 1 safe envelope and include the response `x-request-id`; unknown API routes and unsupported versions never fall through to browser assets.

In production, server startup serves `apps/web/dist` by default and falls back to its `index.html` for client-side navigation. Set `INSIGHT_STATIC_ROOT` only when the built browser assets are stored elsewhere. Browser API URLs remain relative, so Fastify is the only production browser boundary.

The repository also contains one implemented legacy tool:

- [`Bayesian-Engine/`](Bayesian-Engine/) contains a standalone Electron XMLBIF editor. Its completed checklist covers parsing, structural checks, safe CPT transforms, graph editing, XML synchronization, file lifecycle, tests, and packaging. Integration into INSIGHT has not started.
- [`BNs/`](BNs/) contains qualitative Bayesian-network and influence-diagram artifacts for treatment setting, pharmacotherapy, clozapine pathways, maintenance, LAI use, and adverse-effect management.
- [`medical-documentation/`](medical-documentation/) contains source material collected for DDI and suicide-risk work.
- [`CONTEXT/`](CONTEXT/) contains protected project context used by coding agents.

No Encounter or visit entity exists. The DDI engine and treatment-plan orchestrator are not implemented yet. The unified deployment includes local password authentication, Administrator account management, and Patient/Research Case persistence; its worker has no domain jobs until later modules are implemented.

## Database Development

PostgreSQL major version 16 is pinned and enforced at runtime. Keep `DATABASE_URL` in the server environment only. Run `npm run db:migrate` to migrate forward, `npm run db:migration:head` to report database and code heads, and `npm run db:migrate:test` with a dedicated PostgreSQL 16 `TEST_DATABASE_URL` to run isolated integration tests. `npm run secret-log:scan` verifies safe database diagnostics and browser-source boundaries. Server startup fails before readiness when the database is empty, behind, divergent, or on another PostgreSQL major.

Migration 2 creates the identity schema and exactly one enabled bootstrap Administrator. Its publicly predictable `admin/admin` credential is hashed with the current versioned Argon2id policy, does not require a first-sign-in change, and is never recreated or overwritten after the migration is recorded. User services enforce Unicode-normalized case-insensitive usernames, one-character minimum passwords, transparent rehash after policy changes, fixed Administrator/Psychiatrist roles, visible bootstrap-risk metadata, and protection for the last enabled Administrator.

Migration 4 adds attributable, sanitized account-management audit events and treats `PASSWORD_CHANGE_REQUIRED` as enabled for last-Administrator protection. Administrator REST/UI supports listing, creating, renaming, enabling/disabling, direct password changes, temporary resets, and session revocation. Temporary reset hashes the supplied credential, revokes every target session, and restricts the next session to password replacement; successful replacement revokes old sessions and returns a rotated session. No signup, email recovery, reset link, recovery code, or retrievable password is provided.

Migration 5 adds immutable EXT-01 evidence versions, explicit latest-version activation state, and metadata-only operational audit events. `GET` and `POST /api/v1/admin/deployment-evidence` inspect or record evidence; `POST /api/v1/admin/deployment-evidence/{version}/activate` enables identified mode only while the latest approval is effective and every security-control prerequisite is satisfied. Any new evidence version or approval expiry disables identified Patient creation. Administrator requests to the Patient-creation boundary remain forbidden.

Migration 6 adds the database-held application encryption key, encrypted Patient identity and demographics, unique normalized-identifier lookup hash, exactly one Research Case per Patient, and encrypted Patient audit events. `GET /api/v1/patients` lists the shared registry without creator filtering, and `GET /api/v1/patients/{patientId}` returns one profile. `POST /api/v1/patients` creates a complete Patient and Research Case or atomically overwrites demographics on a normalized identifier match; `PUT /api/v1/patients/{patientId}` performs an attributable last-write-wins demographic save. Responses calculate profile age against today's deployment-local date and Research Case age against `startedAt`. Every Patient endpoint rejects Administrators.

Migration 7 completes ordinary PostgreSQL audit persistence. Identity events record actor, time, event, target version, and sanitized before/after account metadata in the same transaction as each managed mutation. Patient events record encrypted complete before/after demographics, Patient and Research Case UUIDs, and monotonically increasing target versions in the Patient transaction. Patient and Research Case UUIDs intentionally have no audit-table foreign keys, so the clinical link and payload survive later Patient hard deletion. Administrator operational queries cannot import or deserialize clinical payloads; Psychiatrist clinical queries remain separately authorized. Normal audit-row update/delete writes are rejected, but database owners can bypass or remove those controls. There is no hash chain, signature, write-once storage, or tamper-evidence claim.

Patient routes require one deployment identifier configuration. Set `INSIGHT_OFFICIAL_IDENTIFIER_TYPE`, `INSIGHT_OFFICIAL_IDENTIFIER_ISSUER`, `INSIGHT_OFFICIAL_IDENTIFIER_PATTERN`, and `INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION`; normalization must be `NFKC`, `NFKC_UPPERCASE`, or `NFKC_LOWERCASE`. The Compose file forwards these runtime values and contains no jurisdiction-specific default.

Migration deployment, failure recovery, full-restore boundaries, and major-upgrade steps are documented in [Database Migrations and Recovery](docs/operations/database-migrations.md).

## Production Container

`Dockerfile` builds React assets and production TypeScript output in Node.js `22.14.0` stages, installs only the Fastify server's production dependency graph, and copies them into the PostgreSQL `16.10` Debian Bookworm image. The Electron source, development dependencies, repository documents, test data, and local credential files are excluded from the build context and final image.

The container requires a separately mounted volume at `/var/lib/insight`; startup without that mount fails closed. First startup creates this versioned layout:

```text
/var/lib/insight/
├── layout-version
├── postgres/     # live PostgreSQL 16 cluster
├── artifacts/    # file-backed application artifacts
└── backups/      # exports, outside the live cluster
```

The root entrypoint validates and prepares the mount, then runs PostgreSQL as `postgres` and the migration, Fastify, and worker processes as the unprivileged `insight` user. PostgreSQL accepts local peer-authenticated Unix-socket connections and binds TCP only to container loopback; port `5432` is not exposed. Migrations complete under the existing advisory lock before worker or HTTP readiness. Shutdown drains Fastify and the worker before a fast PostgreSQL checkpoint and stop.

Create the required external volume before using the production Compose file:

```bash
docker volume create insight-data
docker compose -f compose.production.yml up --build
```

Do not add provider credentials to the image or Compose file. Provider configuration remains runtime/database state. Run `npm run test:container` for fresh-volume readiness, replacement persistence, missing/read-only/incompatible-volume failures, dependency exclusion, and credential-environment smoke checks.

## Known Blockers

- All clinical models are research artifacts with placeholder, uncalibrated probabilities or utilities unless independently assessed under a documented protocol and explicitly promoted through future model governance.
- A repeated basic audit found 6 of 13 XMLBIF artifacts with CPT dimension or normalization failures. A seventh model separately declares BIF `1.0` rather than the editor's supported XMLBIF `0.3` contract.
- The Akathisia XML artifact appears unrelated to its folder topic and must not be treated as an approved model.
- The DDI source archive has no repository-wide provenance, licensing, freshness, normalization, or update contract.
- The C-SSRS source has no repository permission record, training evidence, governed transcription approval, or approved Persian translation.
- Bayes Engine dependencies are not installed in the current workspace, so this audit could not run its tests, lint, type-check, or formatting checks.
- The root `.git` directory is empty; version-control commits are unavailable until the repository is initialized or restored.

Fail closed: no model or medical source is eligible for clinical activation merely because it exists in this repository.

## Documentation Work

The architecture-question intake is complete. Remaining documentation work is consistency auditing, source-governance closure, implementation packet design, and validation of clinical artifacts.

## Bayes Engine Development

See [`Bayesian-Engine/README.md`](Bayesian-Engine/README.md) for its local requirements and commands. Its current implementation requires Node.js 20+ and npm 10+.

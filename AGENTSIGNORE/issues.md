# INSIGHT Implementation Issues

## Purpose

This file is the executable implementation backlog for INSIGHT. Each issue is intentionally bounded to one AI coding session. Complete issues in dependency order. Mark an issue complete only after its implementation, focused tests, affected documentation, and verification pass.

`Plan.md` remains the high-level packet plan. This file decomposes those packets into session-sized work.

## Authoritative baseline

- Product stage: research-only schizophrenia decision-support prototype; never present output as diagnosis, prescription, emergency service, or autonomous clinical authority.
- Current implementation: no executable INSIGHT application exists. `Bayesian-Engine/` is a completed standalone Electron XMLBIF editor and source implementation only.
- Target stack: TypeScript end to end; React/Vite browser; Node.js/Fastify backend and worker; PostgreSQL system of record; one internal MCP Gateway; one all-in-one production container; one external persistent volume.
- Roles: exactly `ADMINISTRATOR` and `PSYCHIATRIST`. Administrators never access Patient content or clinical audit payloads. Every Psychiatrist can access and modify every Patient.
- Tenancy: one research organization/project per deployment; no tenant IDs or tenant switching.
- Clinical record: one canonical Patient UUID and exactly one Research Case per Patient; no Encounters, visits, or second Research Cases.
- Workflow authority: a deterministic persisted backend state machine controls transitions and model-callable tools. Browser and LLM state are never authoritative.
- Hosted model boundary: the backend calls one Administrator-configured OpenAI-compatible Chat Completions endpoint. Only de-identified projections leave the deployment. No automatic provider or model fallback.
- Long-running work: PostgreSQL-backed durable jobs with leases, idempotency, restart recovery, progress events, and authenticated resumable SSE.
- Clinical computation: bypassed assessments receive separate hidden AI imputations; backend rules select BN pathways; the LLM generates every CPT; accepted snapshots are immutable; inference is deterministic and does not clamp Patient facts as BN evidence.
- DDI: local, governed, versioned Medscape-derived knowledge; `UNKNOWN` medication pairs are omitted; successful findings are warnings only; failure to complete a required check blocks finalization.
- Plans: schema-valid structured drafts; clinician edits remain authoritative; final plans are immutable and attributable; later versions supersede rather than overwrite.
- Storage: PostgreSQL plus file artifacts on the external volume. File creation is best-effort filesystem-first. Manual backup contains PostgreSQL only. Restore replaces the complete database in maintenance mode.
- Deletion: any Psychiatrist can immediately hard-delete any Patient without confirmation or re-authentication. Complete clinical audit history survives and deletion is not complete erasure.

Primary specifications:

- `docs/architecture/system-architecture.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/mcp-contracts.md`
- `docs/product/product-and-workflow-requirements.md`
- `docs/decisions/0001-*.md` through `docs/decisions/0023-*.md`
- `docs/reviews/cssrs-source-audit.md`
- `CONTEXT/ui-context.md`

Accepted ADRs override conflicting older overview text.

## Sensitivity and model assignment

| Sensitivity | Use                                                                                                          | Recommended model                       |
| ----------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Low         | Mechanical setup, styling, documentation, generated clients, routine UI                                      | Economy/cheap coding model              |
| Moderate    | Normal domain CRUD, schemas, isolated services, ordinary integration                                         | Standard coding model                   |
| High        | Authentication, authorization, concurrency, durable jobs, storage, cross-module orchestration                | Advanced reasoning/coding model         |
| Critical    | Clinical scoring or knowledge, de-identification, DDI/BN correctness, finalization, deletion, backup/restore | Frontier model plus human domain review |

Sensitivity describes harm from a wrong implementation, not issue size. Low-sensitivity issues still require tests.

## External inputs and release gates

These inputs are not present in the repository. AI implementation must not invent them.

| ID     | Required input                                                                                                                                                                                      | Blocks                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| EXT-01 | Deployment research approval, responsible authority, consent/waiver basis, security baseline, retention/deletion/breach rules                                                                       | Identified research mode activation and real identified-data use        |
| EXT-02 | Authorized DSM-5-TR schizophrenia criteria artifact, exact response model/calculation, permission, version, and clinical approval                                                                   | INS-020 production activation                                           |
| EXT-03 | Authorized PANSS instrument, exact 30 items, response anchors, scoring/subscales, permission, version, and clinical approval                                                                        | INS-021 production activation                                           |
| EXT-04 | C-SSRS research-use permission basis, required training evidence, governed transcription approval, and version approval for hash `8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2` | INS-022 production activation                                           |
| EXT-05 | Medscape reuse permission/legal basis plus reviewed manifest data for every imported source                                                                                                         | INS-036, INS-037, INS-054 activation and finalization                   |
| EXT-06 | Clinically reviewed medication, comorbidity, contraindication, and adverse-effect seed catalogs and rule versions                                                                                   | INS-025, INS-026, INS-034 production use                                |
| EXT-07 | Evidence, calibration, fairness, and clinical-review metadata for every BN pathway                                                                                                                  | Safe interpretation; not a software activation gate under accepted ADRs |

Development and CI use synthetic fixtures and clearly marked non-clinical test artifacts. A technical implementation may be complete while a production activation gate remains closed.

Current source inventory and blockers:

- The repository has 13 XMLBIF candidates. Six have CPT dimension/normalization failures; a separate seventh declares unsupported BIF 1.0; the Akathisia XML content does not match its folder topic.
- `BNs/Pharmacotherapy/BN-Pharmacotherapy.xml` is the first vertical-slice candidate because the basic audit did not reject it. This is software eligibility only, not clinical validation.
- The local Medscape archive contains 121 text files and 8 PDFs, but no repository-wide permission/freshness/provenance manifest. DDI must stay disabled until EXT-05 is recorded.
- The local C-SSRS PDF is one page and has the pinned hash in EXT-04. Permission, training, governed transcription approval, formal revision identity, and approved Persian translation are absent.
- No authorized DSM-5-TR or PANSS implementation artifact is present.
- Root Git metadata is currently unusable, so the required per-issue commit step cannot work until the repository is initialized or restored.

## Per-session completion contract

Every issue session must:

1. Read `AGENTS.md`, required project context, and the issue plus its dependencies.
2. Write a bounded acceptance statement before editing.
3. Implement only the selected issue; no unrelated refactor or speculative abstraction.
4. Add or update runtime validation at every changed trust boundary.
5. Add the smallest focused tests covering success, authorization, validation, and relevant failure behavior.
6. Regenerate OpenAPI/client artifacts when an HTTP contract changes; add a forward migration and migration test when persistence changes.
7. Use synthetic or properly de-identified test data only.
8. Run the focused checks and all cheap affected-package checks.
9. Update affected public documentation. Never modify protected paths contrary to `AGENTS.md`.
10. Mark the issue `[x]` only after all acceptance criteria pass. Record unresolved external activation gates without pretending they passed.
11. Commit the coherent change with an informative message when Git is available. If Git is unavailable, report that explicitly.

Canonical root commands established by INS-001 must include `format:check`, `lint`, `typecheck`, `test`, and `build`. Later issues add `openapi:check`, `db:migrate:test`, and `test:e2e`.

## Phase 0 — Minimal engineering foundation

### [ ] INS-001 — Create the TypeScript workspace

- Sensitivity/model: **Low — Economy**
- Depends on: none
- Outcome: root npm workspace with `apps/web`, `apps/server`, `packages/contracts`, and `packages/bayes`; `Bayesian-Engine/` remains intact as migration source.
- Required work: pin compatible Node/npm ranges; add root scripts for format, lint, typecheck, test, and build; add shared TypeScript/ESLint/Prettier defaults; create minimal package entry points without speculative abstractions.
- Acceptance: clean install works; every root script runs; frontend and backend minimal builds succeed; no Electron dependency enters production packages.
- Verify: clean dependency install, all five root checks, and repository file review.
- References: ADR-004, ADR-016, `Plan.md` Packet 0.

### [ ] INS-002 — Establish versioned runtime contracts

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-001
- Outcome: `packages/contracts` owns versioned runtime schemas for IDs, timestamps, roles, common API errors, pagination, provenance, and schema-version rejection.
- Required work: choose one already-approved runtime-schema library or the smallest compatible dependency; export inferred TypeScript types; define stable serialization and hash helpers; prevent frontend import of server-only secrets or database types.
- Acceptance: invalid UUIDs, timestamps, roles, unknown schema versions, and malformed error payloads fail deterministically; browser-safe exports contain no server module imports.
- Verify: contract unit tests and package-boundary/type checks.
- References: system architecture trust boundaries, ADR-001, ADR-016, ADR-017.

### [ ] INS-003 — Add PostgreSQL access and forward migrations

- Sensitivity/model: **High — Advanced**
- Depends on: INS-001, INS-002
- Outcome: server database package with pooled connections, transactional helper, migration ledger/lock, UTC handling, and isolated integration-test database support.
- Required work: pin a PostgreSQL major; add forward-only migrations and migration-head reporting; forbid undocumented cross-module writes; add startup failure for incompatible/unmigrated schema; keep credentials server-side.
- Acceptance: empty database migrates to head; rerun is idempotent; concurrent migration attempts serialize; failed migration leaves an actionable safe diagnostic; rollback/recovery procedure is documented.
- Verify: `db:migrate:test`, integration tests against PostgreSQL, and secret-log scan.
- References: ADR-004, ADR-006, ADR-018.

### [ ] INS-004 — Build the Fastify REST/OpenAPI boundary

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-002, INS-003
- Outcome: versioned `/api/v1` Fastify server, generated OpenAPI, consistent errors, request IDs, health/readiness placeholders, and production static-asset support.
- Required work: validate params/query/body/response at runtime; expose no stack, SQL, absolute path, or secret; add graceful not-found and unsupported-version behavior; generate a browser client/types from the published contract.
- Acceptance: OpenAPI is reproducible; malformed requests receive stable safe errors; backend is the only browser boundary; API and client contract cannot drift silently.
- Verify: route injection tests, OpenAPI snapshot/check, production server build.
- References: ADR-015, ADR-017, MCP contract error rules.

### [ ] INS-005 — Build the React shell and design tokens

- Sensitivity/model: **Low — Economy**
- Depends on: INS-001, INS-002
- Outcome: desktop-first React/Vite shell with approved light theme, semantic layout primitives, routing, error boundary, and responsive narrow-width behavior.
- Required work: implement canonical tokens from `CONTEXT/ui-context.md`; create shared form, button, table, badge, banner, loading, empty, and error primitives; no dark-mode toggle; no clinical rules in UI constants.
- Acceptance: keyboard focus is visible; teal contrast restrictions are respected; reduced motion works; shell remains usable at supported narrow width; primitives expose accessible labels and states.
- Verify: component tests, accessibility smoke test, visual check at desktop and narrow widths.
- References: UI context, product accessibility requirements.

### [ ] INS-006 — Establish CI and test layers

- Sensitivity/model: **Low — Economy**
- Depends on: INS-001 through INS-005
- Outcome: automated checks for formatting, lint, types, unit/integration tests, migrations, OpenAPI drift, browser E2E smoke, and production builds.
- Required work: keep CI local-service based; prohibit live model/medical-source network calls; define test-data factories using synthetic identities; cache only safe dependency artifacts.
- Acceptance: each check fails on a deliberate representative defect; CI has no hidden dependency on Bayes Engine Electron packaging; test artifacts contain no real Patient data or secrets.
- Verify: run full pipeline locally or with repository CI runner.
- References: `Plan.md` Packet 0 and project workflow rules.

## Phase 1 — Deployable runtime and identity

### [ ] INS-007 — Create the all-in-one production image skeleton

- Sensitivity/model: **High — Advanced**
- Depends on: INS-003, INS-004, INS-005
- Outcome: one pinned Debian-slim image containing built web assets, Fastify/worker runtime, supervised PostgreSQL, and required external-volume layout.
- Required work: run as least privilege where practical; bind PostgreSQL internally; fail safely for missing/unwritable/incompatible volume; separate database and artifact subdirectories; exclude Electron and development dependencies.
- Acceptance: fresh-volume startup reaches readiness after migrations; missing volume fails closed; container replacement preserves database files; image has no provider credentials.
- Verify: container smoke tests for success and volume failures.
- References: ADR-006, ADR-016, system architecture deployment unit.

### [ ] INS-008 — Implement users, Argon2id passwords, and `admin/admin` bootstrap

- Sensitivity/model: **High — Advanced**
- Depends on: INS-003, INS-004
- Outcome: identity tables/services with normalized unique usernames, fixed roles, versioned Argon2id policy, and mandatory enabled bootstrap Administrator `admin/admin`.
- Required work: enforce 12-character minimum for non-bootstrap password creation/change; never store/log plaintext; prevent disabling the last enabled Administrator; preserve accepted no-forced-change bootstrap behavior and visible risk metadata.
- Acceptance: first migration creates exactly one usable bootstrap Administrator; restart does not recreate/overwrite it; username collisions are case-insensitive; password verification and rehash-on-policy-change work.
- Verify: password, uniqueness, bootstrap, and last-Administrator tests.
- References: ADR-007, ADR-008, domain model `User`.

### [ ] INS-009 — Implement opaque sessions, CSRF, and sign-in throttling

- Sensitivity/model: **High — Advanced**
- Depends on: INS-008
- Outcome: cryptographically random cookie sessions with only token hashes in PostgreSQL, central revocation, idle/absolute expiry, rotation, CSRF protection, and progressive failed-login delay.
- Required work: use `HttpOnly`, `Secure` outside explicit loopback development, restrictive `SameSite`; 30-minute idle and 8-hour absolute expiry; generic auth errors; delay capped at 60 seconds; audit security events without username enumeration.
- Acceptance: logout, password change/reset, and disablement revoke sessions; expired/revoked cookies fail; state-changing requests without valid CSRF fail; concurrent sessions remain allowed.
- Verify: integration tests for cookies, expiry, rotation, revocation, CSRF, and throttling.
- References: ADR-007, ADR-018.

### [ ] INS-010 — Add Administrator user management

- Sensitivity/model: **High — Advanced**
- Depends on: INS-008, INS-009, INS-005
- Outcome: Administrator REST/UI for list, create, rename, enable/disable, password change, temporary reset, and session revocation.
- Required work: temporary reset must revoke all target sessions and set `PASSWORD_CHANGE_REQUIRED`; restricted users can access only password replacement; completing replacement rotates the session; no public signup/email recovery.
- Acceptance: Psychiatrist receives 403 on every admin endpoint; last Administrator cannot be disabled; reset stores no plaintext; security audit events are attributable and sanitized.
- Verify: authorization matrix, reset lifecycle E2E, session-revocation test.
- References: ADR-004, ADR-007, ADR-023.

### [ ] INS-011 — Build sign-in, forced-password-change, and role navigation

- Sensitivity/model: **Low — Economy**
- Depends on: INS-005, INS-009, INS-010
- Outcome: accessible authentication screens and gateway-owned role navigation.
- Required work: Administrator navigation contains Users, Model Endpoint, knowledge areas, BN Manager, Operational Audit, Backup and Restore; Psychiatrist navigation contains Patient Registry/Create Patient and selected-case workflow; show research-use notice before first workspace entry.
- Acceptance: route guards match backend role results; Administrator shell has no Patient links or leaked Patient summaries; refresh restores safe session state; errors do not reveal account existence.
- Verify: component tests and browser role-navigation E2E.
- References: product requirements role experiences, UI context.

### [ ] INS-012 — Add research-environment approval and identified-mode gate

- Sensitivity/model: **High — Advanced**
- Depends on: INS-010, INS-002
- Outcome: Administrator-managed, versioned deployment record for EXT-01 evidence and an explicit gate separating synthetic/de-identified development use from approved identified research use.
- Required work: store responsible authority, basis, approval reference/dates, security-control checklist, environment status, and actor; never claim INSIGHT grants ethics/legal approval; disabled identified mode rejects identified Patient creation.
- Acceptance: activation requires every configured prerequisite; changing/expiring evidence returns mode to disabled; operational audit contains metadata only; Patient content remains unavailable to Administrators.
- Verify: gate transition, authorization, expiry, and audit tests.
- References: ADR-001 through ADR-004, EXT-01.

## Phase 2 — Patient, audit, and workflow core

### [ ] INS-013 — Implement protected fields and official-identifier configuration

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-003, INS-010, INS-012
- Outcome: database-held versioned master key, authenticated encryption service, lookup hashing, masking, and Administrator-configured identifier types/issuers/normalizers.
- Required work: prohibit key/secret exposure through API/logs/errors; store encrypted names, birth date, and normalized official identifier; use a stable lookup hash without exposing plaintext; reject unsupported formats; never place identifiers in URLs.
- Acceptance: round trip works; tampering fails; lookup uniqueness works without plaintext query; key version is recorded; full-database-compromise limitation is documented and visible to Administrators.
- Verify: encryption test vectors, tamper tests, log/API redaction scan.
- References: ADR-003, ADR-012, ADR-018.

### [ ] INS-014 — Implement Patient creation, duplicate overwrite, and one Research Case

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-013, INS-016
- Outcome: transactional Patient service and routes using UUID identity, mandatory first/last name, date of birth, `MALE|FEMALE`, configured official identifier, and unique one-to-one Research Case creation.
- Required work: on duplicate normalized identifier, atomically overwrite submitted demographics without warning and return existing Patient; calculate profile age against today and case age against `startedAt`; use last-write-wins mutable saves; audit before/after values.
- Acceptance: concurrent duplicate creates produce one Patient/Research Case; no incomplete Patient persists; no Encounter/visit table or route exists; Administrator access fails.
- Verify: database concurrency, age boundary/leap-date, overwrite, authorization tests.
- References: ADR-007, ADR-008, ADR-012, ADR-013.

### [ ] INS-015 — Build the shared Patient Registry and profile UI

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-005, INS-014
- Outcome: Psychiatrist-only create/search/list/profile pages for the shared registry.
- Required work: mask official identifiers except for necessary disambiguation; duplicate submission opens the overwritten existing record with no confirmation; display current age; provide loading, empty, invalid, unauthorized, and failure states; do not expose creator-scoped access.
- Acceptance: all Psychiatrists see the same registry; Administrator routes and API calls fail; keyboard-only create/search succeeds; sensitive fields do not appear in URLs or client logs.
- Verify: component tests and two-Psychiatrist/Administrator E2E.
- References: product Patient Registry, UI context.

### [ ] INS-016 — Establish operational and clinical audit persistence

- Sensitivity/model: **High — Advanced**
- Depends on: INS-003, INS-002
- Outcome: ordinary PostgreSQL audit tables and services with strict separation between operational metadata and complete clinical payloads/references.
- Required work: record actor/time/event/target/version/before-after where required; no hash chain or false tamper-evidence claim; prevent normal update/delete APIs; define surviving-Patient-link representation for later hard deletion.
- Acceptance: every identity and Patient mutation can write an audit event in its transaction; Administrator queries can never deserialize clinical payloads.
- Verify: transaction rollback, role-separation, and payload-redaction tests.
- References: ADR-019, ADR-023, domain model `AuditEvent`.

### [ ] INS-017 — Implement the persisted Research Case state machine

- Sensitivity/model: **High — Advanced**
- Depends on: INS-014, INS-002
- Outcome: deterministic, revisioned transition service covering `DATA_COLLECTION` through `FINALIZED`, `REVISION_DRAFT`, and `DELETED` exactly as specified.
- Required work: browser requests transitions but cannot assign state; store revision and transition provenance; enforce required domain-result checks; allow assessment `BYPASSED`; make stale-input invalidation explicit; expose current step and allowed commands.
- Acceptance: illegal skips, stale revisions, forged success, and direct state writes fail; every transition is transactional and auditable; required dependency failure cannot reach `READY_TO_FINALIZE`.
- Verify: exhaustive transition-table tests and database restart persistence test.
- References: system architecture state diagram, ADR-003, ADR-015, MCP state allowlist.

### [ ] INS-018 — Implement immediate Patient hard deletion with surviving audit

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-014, INS-016, INS-017, INS-059
- Outcome: Psychiatrist-only direct deletion that removes the Patient aggregate and non-audit artifacts while preserving complete clinical audit history and Patient/Research Case linkage.
- Required work: no confirmation, re-authentication, delay, second approval, soft delete, or Administrator path; commit database deletion first; make one best-effort file deletion attempt; log file failure without reversing success.
- Acceptance: deleted Patient disappears from ordinary routes; all owned operational records are gone; clinical audit payloads remain authorized/readable; retry is idempotent; failed file removal still reports database success.
- Verify: full aggregate/deletion-residue integration test and role matrix.
- References: ADR-020, ADR-021, ADR-023.

## Phase 3 — Assessments and medical history

### [ ] INS-019 — Create the governed clinical-instrument registry (not implemented)

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-003, INS-010, INS-016
- Outcome: immutable version records for assessment source artifacts, hashes, wording/schema, scoring implementation version, permission/training/reviewer evidence, and lifecycle state.
- Required work: separate `IMPORTED`, `QUARANTINED`, `ACTIVE`, `SUPERSEDED`, and `REJECTED`; require exact content hashes; never infer permission or clinical approval from file presence; provide Administrator metadata management without Patient access.
- Acceptance: only active versions can start a new assessment; existing assessments retain pinned versions; changing wording/scoring creates a new version; missing activation evidence fails safely.
- Verify: lifecycle, version pinning, role, and audit tests.
- References: ADR-001, ADR-005, ADR-022, C-SSRS audit.

### [ ] INS-020 — Implement the DSM-5-TR assessment

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-019, INS-017, EXT-02
- Outcome: versioned DSM-5-TR schema, deterministic calculation service, persistence, REST contract, and accessible stepper screen.
- Required work: store structured answers, calculation result/version, actor, timestamps, and instrument pin; computed result must not overwrite Psychiatrist authority; keep all logic server/shared-domain controlled, not UI-only.
- Acceptance: every approved criterion combination matches reviewer-provided test vectors; incomplete and bypass states remain distinct; no invented wording or scoring is present.
- Verify: clinical golden vectors, schema/property tests, UI flow test, reviewer sign-off reference.
- References: product assessment requirements, ADR-009, EXT-02.

### [ ] INS-021 — Implement the PANSS assessment

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-019, INS-017, EXT-03
- Outcome: exact 30-item PANSS input, deterministic positive/negative/general/total calculations, persistence, API, and accessible screen.
- Required work: use item text, anchors, score range, subscale membership, and scoring rules; pin instrument and calculation versions; prevent partial totals from being presented as completed results.
- Acceptance: every item and subscale matches the artifact; minimum/maximum/mixed golden vectors pass; invalid values and incomplete submissions fail; bypass remains separate.
- Verify: clinical golden tests, boundary/property tests, keyboard UI E2E, reviewer sign-off reference.
- References: product PANSS requirements, ADR-009, EXT-03.

### [ ] INS-022 — Implement C-SSRS Screen Version - Recent

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-019, INS-017, EXT-04 for activation
- Outcome: locally scored, version-pinned six-question C-SSRS screen.
- Required work: always ask 1, 2, and 6; if 2 Yes ask 3–5; if 6 Yes ask past-three-month recency; questions 1–5 use past month; derive highest of `LOW`, `MODERATE`, `HIGH`, or `NO_POSITIVE_RESPONSE`; store traversed branch and exact answers.
- Acceptance: all branch and band-precedence vectors pass; no `NO_RISK` label; result is text plus color, informational only, and never imposes acknowledgement/finalization block; inactive evidence gate prevents research activation.
- Verify: complete decision-table tests, accessibility test, source-hash assertion, clinical review record.
- References: ADR-010, ADR-022, `docs/reviews/cssrs-source-audit.md`.

### [ ] INS-023 — Add shared assessment autosave and bypass behavior

- Sensitivity/model: **High — Advanced**
- Depends on: INS-020, INS-021, INS-022
- Outcome: consistent assessment state UX/API for `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, and `BYPASSED`.
- Required work: autosave structured answers last-write-wins; update deterministic results immediately; bypass requires no reason and atomically deletes every partial answer, including high-risk answers; retain only type/status/actor/case/time; never display bypass as negative, zero, or complete.
- Acceptance: refresh resumes progress; simultaneous saves follow newest-commit-wins with audit; bypass after any partial path deletes answers; all downstream status displays remain explicit.
- Verify: shared contract tests, concurrency test, three-assessment browser E2E.
- References: ADR-007, ADR-009, product shared assessment behavior.

### [ ] INS-024 — Implement medical-history persistence and validation

- Sensitivity/model: **High — Advanced**
- Depends on: INS-014, INS-017, INS-002
- Outcome: Research Case data for presentation status, prior-treatment flag/trials, current medication entries, comorbidity selections, contraindication outputs, and supplemental notes.
- Required work: `FIRST_PRESENTATION` hides/disallows prior trials; `KNOWN_SCHIZOPHRENIA` asks prior treatment; treated Yes requires at least one trial; only trial medication is mandatory; distinguish omitted values from explicit `UNKNOWN`; keep current medications separate.
- Acceptance: invalid conditional combinations fail server-side; switching to first presentation removes or rejects incompatible mutable history per explicit contract; all mutations are attributable.
- Verify: domain matrix, API validation, transaction tests.
- References: ADR-013, ADR-014, domain model.

### [ ] INS-025 — Implement the adverse-effect catalog

- Sensitivity/model: **Moderate — Standard with clinical input**
- Depends on: INS-010, INS-003, INS-016, EXT-06 for production seed
- Outcome: Administrator-owned immutable catalog versions with stable term IDs and immediate activation for new selections.
- Required work: create/manage terms without Patient access; preserve prior versions; pin selections; support multiselect plus `OTHER`; allow empty `OTHER` detail; do not migrate existing selections automatically.
- Acceptance: save creates a new active immutable version; old Research Cases render pinned terms; Psychiatrist cannot modify catalog; Administrator cannot inspect selections.
- Verify: versioning, pinning, role-separation, and `OTHER` tests.
- References: ADR-014, EXT-06.

### [ ] INS-026 — Implement comorbidity and contraindication catalogs/rules

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-010, INS-003, INS-016, EXT-06 for production rules
- Outcome: versioned comorbidity terms and deterministic rules producing contraindications, cautions, monitoring requirements, and BN-routing facts.
- Required work: use stable IDs and immutable versions; frontend receives values/rule results from backend; supplemental free text cannot trigger deterministic rules unless normalized to a governed term; store matched rule provenance.
- Acceptance: rule evaluation is deterministic and order-independent; conflicting/ambiguous rules fail activation; existing results remain pinned; no clinical constants are duplicated in React.
- Verify: clinical golden vectors, ambiguity tests, version-pinning tests, reviewer record.
- References: ADR-022, EXT-06.

### [ ] INS-027 — Build the Medical History workflow screen

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-005, INS-024, INS-025, INS-026
- Outcome: accessible step for presentation status, conditional prior trials, adverse effects, comorbidities, current medicines, and validation summaries.
- Required work: medication plus optional dose/period/response/adverse effects/discontinuation reason/notes; response values exactly Full, Partial, None, Worsened, Unknown; display deterministic cautions with provenance and never color alone.
- Acceptance: conditional sections match persisted choices; only medication is required per trial; `OTHER` detail remains optional; keyboard editing and narrow layout work; stale catalog versions remain readable.
- Verify: component tests and first-presentation/known-treated/known-untreated E2E.
- References: product Medical History, UI context.

## Phase 4 — Model endpoint, durable jobs, and MCP boundary

### [ ] INS-028 — Implement model-endpoint configuration

- Sensitivity/model: **High — Advanced**
- Depends on: INS-010, INS-013, INS-004
- Outcome: Administrator-only versioned base URL/model/write-only credential configuration with `PENDING`, `CHECKING`, `COMPATIBLE`, and `INCOMPATIBLE` states.
- Required work: accept absolute HTTPS except explicit loopback-development HTTP; reject credentials/query/fragment/final `chat/completions`; preserve provider path; strip whitespace/trailing slash; never return masked reversible secret; Replace and Clear only.
- Acceptance: any URL/model/key change invalidates compatibility and dependent AI eligibility; API/UI/log/audit never reveal credential; Administrator still receives no Patient content; provider retention/training/DPA terms are displayed as an accepted risk but are not an activation gate.
- Verify: URL table tests, secret redaction scan, authorization tests, UI E2E.
- References: ADR-016, ADR-017, MCP transport profile.

### [ ] INS-029 — Implement native Chat Completions transport and activation probe

- Sensitivity/model: **High — Advanced**
- Depends on: INS-028, INS-002
- Outcome: native server HTTP client and exact two-request forced-tool compatibility probe.
- Required work: send Bearer auth and minimal `model/messages/tools/tool_choice`; append only `chat/completions`; accept JSON string or decoded object arguments; validate full local schema; preserve assistant tool-call message and matching `tool_call_id`; verify randomized nonce and capture safe model metadata.
- Acceptance: local mock tests cover nested/trailing roots, `401/404/408/429/5xx`, timeouts, malformed JSON, missing tool calls, invalid arguments, secret redaction, and successful round trip; no provider SDK/fallback.
- Verify: complete mock-server matrix and configuration fingerprint invalidation tests.
- References: MCP contract activation probe, ADR-016, ADR-017.

### [ ] INS-030 — Implement PostgreSQL durable jobs and authenticated SSE

- Sensitivity/model: **High — Advanced**
- Depends on: INS-003, INS-004, INS-009
- Outcome: job records, transactional lease claims, progress event log, idempotency, bounded attempts, restart recovery, and resumable `/api/v1` SSE.
- Required work: support `QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED`; stable event IDs and `Last-Event-ID`; reauthorize every connect; sanitize errors; browser refresh must not cancel work; domain result, not worker return, determines success.
- Acceptance: two workers cannot own one live lease; expired lease recovers after restart; duplicate command returns same job/result; event order/resume is exact; cross-user/Administrator access is rejected.
- Verify: concurrency/restart integration tests and browser refresh E2E.
- References: ADR-015, ADR-017, domain model `Job`.

### [ ] INS-031 — Implement the de-identification gateway

- Sensitivity/model: **Critical — Frontier plus privacy review**
- Depends on: INS-013, INS-024, INS-030
- Outcome: state-specific allowlisted projections and `research_case.get_context` using ephemeral `subjectRef`, canonical serialization, redaction/exclusion, and model-visible input fingerprints.
- Required work: implement exact `MEDICATION_NORMALIZATION`, `ASSESSMENT_IMPUTATION`, `CPT_GENERATION`, and `PLAN_DRAFT` projection schemas; prohibit names, official IDs, Patient/Research Case UUIDs, contact/address data, exact birth date, re-identification keys, and identifiers embedded in free text; derive approved age/sex/clinical fields; keep mapping server-side; filter tool results/errors too.
- Acceptance: model cannot request arbitrary fields or a projection for another state; adversarial fixtures with identifiers in every structured/free-text field never cross the client boundary; omitted field classes are recorded; any uncertain redaction fails closed; projections are versioned and reproducible.
- Verify: privacy golden tests, fuzz/property tests, captured mock-endpoint requests, log scan, human privacy review.
- References: ADR-002, ADR-003, ADR-022.

### [ ] INS-032 — Build the internal MCP Gateway and typed tool envelope

- Sensitivity/model: **High — Advanced**
- Depends on: INS-002, INS-017, INS-030, INS-031
- Outcome: in-process gateway with trusted context injection, common `ToolResult`, provenance, warnings, and all specified namespace registrations.
- Required work: model cannot set execution/job/subject/revision/state/role/allowlist/idempotency; validate nested input/output schemas; map all contract error codes; never expose a public listener; prevent arbitrary records, SQL, paths, or backend-only commands.
- Acceptance: forged trusted fields are ignored/rejected; schema-invalid calls never reach domains; successful results hash inputs/outputs and pin versions; raw exceptions and sensitive identifiers are filtered.
- Verify: gateway contract suite and explicit negative tests for every prohibited command class.
- References: full `docs/architecture/mcp-contracts.md`, ADR-015.

### [ ] INS-033 — Implement the server-side model agent runtime

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-029, INS-030, INS-031, INS-032
- Outcome: durable agent executions that expose only state-allowed tools, execute validated model calls/tool results, enforce budgets/retries, and fail closed.
- Required work: pin endpoint config, prompt, schema, tool versions, settings, and Research Case revision; model text has no authority; preserve complete tool round trip; prohibit finalization/deletion/admin tools; no chain-of-thought UI/storage requirement.
- Acceptance: each workflow state exposes exactly the documented allowlist; calls outside it fail before domain execution; endpoint exhaustion creates typed failure with no fallback; stale revision cancels safely.
- Verify: state-by-state allowlist tests and synthetic activated-config workflow against local mock server.
- References: MCP state allowlist/error codes, ADR-003, ADR-015, ADR-017.

## Phase 5 — Medication normalization and DDI

### [ ] INS-034 — Implement the medication catalog and MCP tools

- Sensitivity/model: **Critical — Frontier plus clinical terminology review**
- Depends on: INS-032, INS-010, INS-016, EXT-06 for production seed
- Outcome: immutable canonical medication catalog versions plus `medication.search_candidates` and `medication.commit_mapping`.
- Required work: stable canonical IDs, preferred names, synonyms, search normalization, candidate-set persistence, and exact selected-candidate validation; `null` selection becomes `UNKNOWN`; no confidence threshold or Psychiatrist confirmation.
- Acceptance: commit accepts only candidates returned for that entry/catalog; old mappings stay pinned; Administrator governs catalog without Patient access; provenance stores raw text, candidates, selection, model, prompt/schema, and time.
- Verify: search/normalization golden tests, invalid-candidate tests, version pinning, role tests.
- References: ADR-011, MCP medication contracts, EXT-06.

### [ ] INS-035 — Implement medication capture and normalization jobs

- Sensitivity/model: **High — Advanced**
- Depends on: INS-024, INS-030, INS-033, INS-034
- Outcome: current/previous medication entry API/UI and durable LLM normalization workflow that automatically commits a canonical identity or `UNKNOWN`.
- Required work: store raw text and optional dose/route/frequency; use bounded normalization projection; accept mappings without confirmation; changing raw entry invalidates mapping and downstream artifacts; show progress retry.
- Acceptance: every entry ends `NORMALIZED` or `UNKNOWN`; unknown never blocks workflow; no candidate confirmation UI appears; mapped identity becomes authoritative downstream; stale jobs cannot overwrite newer entries.
- Verify: mocked agent workflow, stale-revision test, UI refresh/resume E2E.
- References: ADR-011, product medication normalization.

### [ ] INS-036 — Build DDI source governance and import pipeline

- Sensitivity/model: **Critical — Frontier plus legal/clinical review**
- Depends on: INS-019, INS-059, EXT-05 for activation
- Outcome: versioned Medscape source manifests, artifact import, deterministic extraction/transform versioning, review lifecycle, and disabled-by-default activation gate.
- Required work: require drug identity, title/URL/publisher, retrieval/content dates, SHA-256, parser version, reviewer/time, permission record, and lifecycle; preserve evidence text references; never fill missing/conflicting content with the LLM.
- Acceptance: unlicensed/incomplete sources cannot activate; same bytes/version import idempotently; changed bytes create a new version; source date/retrieval/review/version remain visible; no live scraping.
- Verify: manifest validation, hash, parser-fixture, lifecycle, authorization tests; legal/clinical approval refs for activation.
- References: ADR-005, ADR-006, ADR-022, EXT-05.

### [ ] INS-037 — Implement deterministic DDI pair evaluation and MCP tool

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-034, INS-036, INS-032
- Outcome: immutable exact-regimen `DdiExecution` and `ddi.evaluate_regimen` for `PRIMARY_FILTER` and `FINAL_RECHECK`.
- Required work: normalize unordered pairs; evaluate current/current and current/proposed or exact final regimen as appropriate; omit all pairs involving `UNKNOWN`; return severity/mechanism/effect/action/source refs; fail for inactive/unavailable/unproven source.
- Acceptance: pair enumeration has no duplicates/omissions among known drugs; Primary filter excludes every drug participating in any finding; final findings are warning-only; unknown omissions count but execution succeeds; source failure blocks.
- Verify: clinical pair golden vectors, combinatorial/property tests, provenance mismatch and disabled-source tests.
- References: ADR-005, ADR-010, ADR-011, MCP DDI contract.

### [ ] INS-038 — Build DDI results and status UI

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-005, INS-030, INS-037
- Outcome: DDI workflow page with job progress, exact regimen snapshot, findings/evidence, rerun, stale state, and final-recheck mode.
- Required work: findings use text/icon plus color; show one small generic warning when any medication is `UNKNOWN`, without naming it or omitted pairs; do not repeat unknown warning on plan/export pages; distinguish failed check from successful finding.
- Acceptance: any severity remains warning-only; dependency failure visibly blocks next state and offers rerun; refresh resumes progress; no page implies success from HTTP status alone.
- Verify: component states and browser E2E for none/finding/unknown/failure/stale.
- References: product DDI requirements, UI context.

## Phase 6 — Bayesian library, governance, CPTs, and inference

### [ ] INS-039 — Extract environment-independent Bayes Engine logic

- Sensitivity/model: **High — Advanced**
- Depends on: INS-001, INS-006
- Outcome: `packages/bayes` contains reusable XMLBIF 0.3 parsing, serialization, secure validation, CPT tensor transforms, graph checks, and deterministic semantic hashing from `Bayesian-Engine/`.
- Required work: preserve existing behavior/tests; remove Electron, IPC, window, and desktop filesystem dependencies; define input-size/depth limits and safe XML parsing; keep standalone source working until migration is verified.
- Acceptance: migrated tests cover parser/serializer round trip, dimensions, normalization, cycles, node/reference rules, transforms, and hash stability; no Electron package appears in transitive production dependency graph.
- Verify: package tests plus parity fixtures from all 13 repository XML files.
- References: ADR-016, existing Bayes Engine tests and README.

### [ ] INS-040 — Implement BN model registry, import, and quarantine

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-039, INS-019, INS-059
- Outcome: immutable `BnModelVersion` records and artifacts with pathway identity, hashes, validation reports, evidence/calibration/review metadata, and lifecycle.
- Required work: import all repository XMLBIF candidates; reject unsupported BIF 1.0, malformed dimensions/normalization, unresolved refs, cycles, invalid utilities, or failed round trip; explicitly quarantine the content-mismatched Akathisia artifact; do not equate structural pass with clinical validity.
- Acceptance: all 13 artifacts receive reproducible reports and are active, if needed make some changes to the bayesian networks to fix them.
- Verify: repository-wide fixture audit, expected quarantine snapshot, artifact/hash tests.
- References: ADR-005, ADR-008, ADR-023, README Known Blockers.

### [ ] INS-041 — Build BN Manager import, diagnostics, and read-only graph views

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-005, INS-010, INS-039, INS-040
- Outcome: Administrator-only upload, version list, diagnostics, read-only graph, node inspector, and source metadata inside React/Vite.
- Required work: adapt existing projections/components without Electron; file operations go through backend artifact APIs; keep shared navigation and approved design tokens; clearly separate software validity from evidence/calibration status.
- Acceptance: representative valid and invalid models upload as immutable versions and render matching diagnostics/graph; Administrator sees no Patient data; keyboard and narrow-width basics work.
- Verify: migrated projection/component tests and browser upload/diagnostics E2E.
- References: ADR-001, ADR-004, ADR-016, Bayes Engine UI behavior.

### [ ] INS-041A — Add BN graph structure editing

- Sensitivity/model: **High — Advanced**
- Depends on: INS-041
- Outcome: Administrator can add/remove/move/connect supported nature, decision, and utility nodes using migrated domain mutations.
- Required work: preserve unique IDs, DAG checks, utility restrictions, dimension effects, deterministic positions, and safe confirmation for lossy edits; persist only as a new candidate version, never overwrite an active artifact.
- Acceptance: every existing graph-mutation regression test passes in web packages; invalid arcs/types fail with diagnostics; cancel leaves source unchanged; saved edit produces new hash/version.
- Verify: mutation/component tests and graph-edit browser E2E.
- References: Bayes Engine mutation/graph tests and ADR-016.

### [ ] INS-041B — Add BN CPT, raw-table, and XML editing

- Sensitivity/model: **High — Advanced**
- Depends on: INS-041A
- Outcome: Administrator can edit node outcomes, CPT/raw tables, and XML source with synchronized validated projections.
- Required work: preserve parent-axis order, table cardinalities, probability validation, finite raw values, parse-draft errors, deterministic serialization, and destructive-change behavior; save creates a new immutable candidate version.
- Acceptance: existing CptEditor/RawValueEditor/XmlCodeView/fidelity regressions pass; malformed draft never replaces last valid model; round trip retains semantic hash where unchanged.
- Verify: migrated editor tests and table/XML browser E2E.
- References: Bayes Engine editor tests and ADR-016.

### [ ] INS-042 — Implement automatic BN activation, disablement, and rollback

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-040, INS-041B, INS-016
- Outcome: newest structurally passing version activates immediately per pathway; prior version becomes superseded; Administrator can disable or roll back to a prior passing version.
- Required work: activation checks exactly supported version/security/IDs/refs/node types/DAG/dimensions/finite nonnegative normalized tables/round trip/hash; evidence/calibration/clinical review stay visible but are not activation gates; in-progress executions pin versions.
- Acceptance: failed model never activates; passing import switches new executions atomically; rollback affects only new executions; finalized provenance remains unchanged; all lifecycle events are audited.
- Verify: lifecycle concurrency tests and UI E2E.
- References: ADR-005, ADR-006.

### [ ] INS-043 — Implement deterministic versioned BN routing

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-017, INS-026, INS-042
- Outcome: backend rule artifact/evaluator mapping approved structured Research Case facts to active pathway IDs, beginning with Pharmacotherapy.
- Required work: rules may use allowed demographics, presentation, assessment state/result, comorbidities, medication history/current regimen; record matched rules and model versions; reject ambiguous or missing required route; LLM cannot name a model.
- Acceptance: same pinned input/rules always select same routes; ambiguity and missing active models fail closed; initial synthetic vertical-slice fixture selects only `BN-Pharmacotherapy.xml`.
- Verify: routing golden table, order-independence/property tests, authorization test.
- References: ADR-022, ADR-023, MCP `bn.get_routed_contracts`.

### [ ] INS-044 — Implement patient-specific CPT generation and snapshot lifecycle

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-033, INS-039, INS-043
- Outcome: `bn.get_routed_contracts`, `bn.submit_cpt_snapshot`, immutable attempts/snapshots, dependency fingerprints, reuse, invalidation, and at most three generation attempts.
- Required work: LLM generates every table; validate exact node refs/order/dimensions/completeness/finiteness/nonnegative/row sums; never clip, repair, normalize, or use base numerical CPTs; return structured diagnostics for two retries; store raw attempts and accepted snapshot; fingerprint an optional imputation snapshot reference that INS-047 later makes mandatory for bypassed assessments.
- Acceptance: unchanged dependencies reuse snapshot without model call; any input/model/prompt/schema/endpoint/settings/imputation change makes it stale; third invalid attempt blocks BN/finalization; snapshots never cross Research Cases.
- Verify: malformed-table matrix, fingerprint/reuse/invalidation tests, mock-agent retry test.
- References: ADR-008, ADR-009, MCP BN contracts.

### [ ] INS-045 — Implement deterministic BN inference

- Sensitivity/model: **Critical — Frontier plus mathematical review**
- Depends on: INS-039, INS-044
- Outcome: `bn.run_inference` computes requested output distributions from the accepted patient-specific snapshot with no Patient evidence clamping.
- Required work: support the discrete node/model types required by activated pathways; validate output node refs; preserve parent/outcome ordering; produce normalized deterministic distributions and immutable provenance; fail safely on unsupported influence-diagram semantics.
- Acceptance: known small-network exact results pass; repeated replay of one snapshot is byte-stable after canonicalization; no clinical input is applied as observed evidence; stale/foreign snapshots fail.
- Verify: hand-calculated networks, normalization/property tests, snapshot replay test.
- References: ADR-008, MCP `bn.run_inference`.

### [ ] INS-046 — Build BN processing and evidence UI

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-030, INS-043, INS-044, INS-045
- Outcome: Psychiatrist view for routed pathways, job progress, CPT status, deterministic outputs, model hash/version, evidence/calibration/review status, and typed rerun failures.
- Required work: label CPTs as LLM-generated patient-specific research values; never imply Bayesian calibration from mathematical validity; hide raw chain-of-thought and identifiers; render stale snapshot and blocking failure clearly.
- Acceptance: page survives refresh; source/version/provenance is inspectable; inactive or failed route blocks progression; visual state uses text, not color alone.
- Verify: component state suite and valid/invalid/stale browser E2E.
- References: ADR-005, ADR-008, product AI/BN processing.

## Phase 7 — Imputation, orchestration, and Treatment Plans

### [ ] INS-047 — Implement hidden AI assessment imputation (did not implement)

- Sensitivity/model: **Critical — Frontier plus clinical/privacy review**
- Depends on: INS-023, INS-030, INS-033
- Outcome: `assessment.submit_imputation` and immutable `AiImputation` snapshots for every officially bypassed assessment.
- Required work: generate complete schema-valid synthetic answers/scores/classification from remaining de-identified context; never recover discarded partial answers or change official `BYPASSED`; store full hidden provenance and shared CPT dependency fingerprint; reuse/invalidate with CPT lifecycle.
- Acceptance: completed assessments are never imputed; all bypassed types are included; imputed high C-SSRS creates no direct warning/block; browser/API never expose details; only Primary Plan later receives a generic boolean notice.
- Verify: schema, privacy/API, invalidation, bypass/completed matrix, mock-agent tests.
- References: ADR-011, MCP assessment contract.

### [ ] INS-048 — Implement the versioned structured Treatment Plan schema and MCP tool

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-032, INS-037, INS-045
- Outcome: plan contracts and `treatment_plan.submit_primary` for regimen medication, dose/unit, route, frequency, titration, monitoring, rationale, warnings, explanation, source refs, and provenance.
- Required work: structured fields remain authoritative; reject unknown schema versions, missing fields, non-candidate medication IDs, Primary-DDI-excluded drugs, unsupported source refs, and provenance mismatch; optional narrative cannot replace structure; tool never finalizes.
- Acceptance: valid synthetic plan persists a mutable draft/revision; stored draft pins all input execution refs and imputation-notice flag.
- Verify: schema golden fixtures, invalid-source/medication/provenance tests, MCP round trip.
- References: ADR-022, MCP Treatment Plan contract.

### [ ] INS-049 — Implement the end-to-end workflow orchestrator

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-017, INS-030, INS-033, INS-035, INS-037, INS-043 through INS-045, INS-047, INS-048
- Outcome: persisted orchestration advances one Research Case through normalization, imputation, routing, CPT generation, inference, Primary DDI, and plan generation using immutable domain results.
- Required work: create idempotent jobs/commands; pin revision/dependencies; validate accepted domain status before transition; cancel stale runs; expose safe rerun; never let LLM/browser declare completion; preserve failed attempts/provenance.
- Acceptance: success reaches `CLINICIAN_REVIEW`; each required failure stops at its owning state; bypass paths still succeed through imputation; restart resumes safely; duplicate requests do not duplicate accepted artifacts.
- Verify: synthetic orchestration integration matrix with mocked endpoint and local governed fixtures.
- References: system architecture lifecycle, ADR-015, ADR-023.

### [ ] INS-050 — Build the Primary Treatment Plan review UI

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-005, INS-046, INS-048, INS-049
- Outcome: structured, explainable draft page with regimen fields, monitoring, rationale links, warnings, provenance, diff baseline, and explicit Psychiatrist-control wording.
- Required work: show one generic AI-imputation notice only when used; never show imputed details; do not show generic unknown-medication warning; display loading/empty/validation/dependency/job/stale states; no prescription/order language.
- Acceptance: every rationale source resolves to an authorized record; incomplete/failed results cannot appear ready; page remains keyboard usable and readable at narrow supported width.
- Verify: component/accessibility tests and successful/bypassed/failure E2E.
- References: product Primary Treatment Plan, UI context.

### [ ] INS-051 — Implement clinician edits and mandatory final-regimen DDI recheck

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-037, INS-048, INS-050
- Outcome: last-write-wins structured edits, explicit diff from generated draft, medication-change invalidation, complete `FINAL_RECHECK`, and readiness evaluation.
- Required work: allow adding any canonical drug, including Primary-filtered severe/contraindicated combinations; require no reason/acknowledgement; any medication change creates new exact-regimen DDI job; findings warning-only; failed/unproven check blocks.
- Acceptance: unchanged regimen can reuse exact eligible check; changed regimen cannot finalize on prior check; successful findings never block; unknown pairs remain omitted; stale concurrent edits cannot bind the wrong DDI execution.
- Verify: regimen fingerprint/concurrency tests and warning/failure browser E2E.
- References: ADR-007, ADR-010, product Psychiatrist review.

### [ ] INS-052 — Implement immutable idempotent finalization

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-016, INS-017, INS-045, INS-048, INS-051
- Outcome: one transaction creates immutable `FinalPlanVersion`, pins exact plan/DDI/CPT/BN/assessment/source/model provenance, audits finalizer/time, and moves state to `FINALIZED`.
- Required work: require Psychiatrist, `READY_TO_FINALIZE`, exact successful final DDI, required routed BN/CPT success, valid schema, no dependency/provenance failure, and unique idempotency key; remove AI-imputation notice from final snapshot; block update APIs/database paths.
- Acceptance: same key returns same version; concurrent different keys create only one active version; DDI findings/high completed C-SSRS do not block; service failure does; finalized content cannot mutate.
- Verify: transactional race/idempotency/immutability and authorization tests.
- References: system finalization transaction, ADR-010, ADR-014.

### [ ] INS-053 — Prove the first complete synthetic vertical slice

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-007 through INS-052 except expansion-only INS-018, INS-025/026 production seeds
- Outcome: one deployable synthetic Patient traverses auth, one Research Case, all three assessment states, current medicines, Pharmacotherapy routing, DDI, CPT generation, inference, Primary Plan, edit/recheck, and Final Plan.
- Required work: use local mock model endpoint and explicitly governed test-only instrument/DDI/catalog fixtures; exercise completed and bypassed assessments; verify audit/provenance; keep production activation gates visibly closed when EXT inputs are absent.
- Acceptance: success, bypass, malformed model output, unavailable dependency, stale input, restart, duplicate command, and idempotent finalization scenarios pass in the production-shaped container.
- Verify: dedicated `test:e2e` vertical-slice suite plus full root checks/build.
- References: ADR-023, `Plan.md` Packet 1.

## Phase 8 — Complete knowledge, revisions, audit, and artifacts

### [ ] INS-054 — Inventory approved DDI sources and freeze import batches

- Sensitivity/model: **Critical — Frontier plus clinical/legal review**
- Depends on: INS-034, INS-036 through INS-038, INS-053, EXT-05, EXT-06
- Outcome: deterministic inventory of the local Medscape archive, reviewed manifest status, canonical sort order, and four immutable import-batch lists.
- Required work: include every eligible text/PDF source exactly once; record unapproved/missing-manifest items as blocked; assign sorted eligible entries 1–32, 33–64, 65–96, and 97–end without changing bytes; produce initial catalog/source/mapping gap report.
- Acceptance: inventory count reconciles to repository files; no active record is created; every omission has an explicit reason; rerun produces identical batch manifests/hashes.
- Verify: inventory snapshot, duplicate/missing check, legal/clinical manifest review.
- References: ADR-005, ADR-006, ADR-022.

### [ ] INS-054A — Import and review DDI batch 1

- Sensitivity/model: **Critical — Frontier plus clinical/legal review**
- Depends on: INS-054
- Outcome: approved sorted manifest entries 1–32 are deterministically extracted, normalized to stable medication IDs, reviewed, and activated or explicitly rejected.
- Required work: preserve source bytes/hash, extraction version, severity/mechanism/effect/action/evidence references, conflicts, and gaps; add regression fixtures; never use live or LLM fallback.
- Acceptance: every batch entry ends active/superseded/rejected with reviewer evidence; every derived pair traces to one source/version; deterministic rebuild matches hashes.
- Verify: batch report, clinical sample review, evaluator regression tests.

### [ ] INS-054B — Import and review DDI batch 2

- Sensitivity/model: **Critical — Frontier plus clinical/legal review**
- Depends on: INS-054A
- Outcome: approved sorted manifest entries 33–64 receive the same governed extraction, normalization, review, and lifecycle treatment as batch 1.
- Required work: follow the frozen INS-054 batch contract; preserve source/version/evidence/conflicts and add batch-specific regression fixtures without changing prior batches.
- Acceptance: no skipped or duplicate manifest entry; all derived records are source-traceable; deterministic rebuild and focused DDI tests pass.
- Verify: batch report, reviewer record, regression suite.

### [ ] INS-054C — Import and review DDI batch 3

- Sensitivity/model: **Critical — Frontier plus clinical/legal review**
- Depends on: INS-054B
- Outcome: sorted manifest entries 65–96 receive governed extraction, normalization, review, and lifecycle treatment.
- Required work: preserve source/version/evidence/conflicts and add batch-specific regression fixtures without changing prior batches.
- Acceptance: no skipped or duplicate manifest entry; all derived records are source-traceable; deterministic rebuild and focused DDI tests pass.
- Verify: batch report, reviewer record, regression suite.

### [ ] INS-054D — Import and review DDI batch 4

- Sensitivity/model: **Critical — Frontier plus clinical/legal review**
- Depends on: INS-054C
- Outcome: approved sorted manifest entries 97–end receive governed extraction, normalization, review, and lifecycle treatment.
- Required work: follow the frozen INS-054 batch contract; preserve source/version/evidence/conflicts and add batch-specific regression fixtures without changing prior batches.
- Acceptance: final batch reconciles to frozen inventory; all derived records are source-traceable; deterministic rebuild and focused DDI tests pass.
- Verify: batch report, reviewer record, regression suite.

### [ ] INS-054E — Reconcile complete DDI coverage and lifecycle behavior

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-054A through INS-054D
- Outcome: final coverage report for catalog drugs, source records, evaluable pairs, unknown/unmapped records, conflicts, and rejected records; eligible reviewed versions are active.
- Required work: add each severity and representative no-match regression; verify retirement/supersession changes new executions only; keep age alone non-expiring; confirm missing permission/manifest still blocks.
- Acceptance: every active derived record traces to bytes/review/permission/transform; all gaps are explicit; full deterministic rebuild matches stored hashes; DDI evaluator suite passes.
- Verify: full coverage report, reviewer sign-off, rebuild/hash comparison.

### [ ] INS-055 — Add the Treatment Setting pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-040 through INS-046, INS-053, EXT-07
- Outcome: reviewed routing rule and execution support for `BNs/Treatment-Setting/BN-Treatment-Setting.xml`.
- Required work: obtain reviewed structured trigger/output mapping; validate/activate eligible artifact; add route rules, CPT contract, requested outputs, evidence metadata, and synthetic golden cases; fail closed on unsupported semantics.
- Acceptance: only reviewed trigger fixtures select the active pinned model; ambiguous/missing route fails; full CPT/inference replay is deterministic; evidence/calibration limitations are visible.
- Verify: route golden table, model/hash check, synthetic end-to-end pathway case, clinical review record.
- References: README Planned Modules/Known Blockers, ADR-002, ADR-022.

### [ ] INS-055A — Add the clozapine treatment-resistance pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055
- Outcome: reviewed route and execution for `BNs/7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml` if structurally eligible.
- Required work: define reviewed structured triggers/outputs, validate artifact, add deterministic rule/CPT/inference fixtures, and expose evidence limits; otherwise retain quarantine with exact blocker.
- Acceptance: only reviewed eligible cases route; inactive/quarantined model is never selected; deterministic replay and provenance pass.
- Verify: clinical route vectors, artifact hash/report, synthetic pathway E2E.

### [ ] INS-055B — Add the clozapine suicide-risk pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055A
- Outcome: reviewed route and execution for `BNs/Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml` if structurally eligible.
- Required work: use official completed/bypassed/imputed states only as approved structured routing facts; do not create a suicide-risk action gate; add deterministic route/CPT/inference fixtures or exact quarantine reason.
- Acceptance: warning-only C-SSRS policy remains unchanged; route is deterministic and model-version pinned; replay/provenance tests pass.
- Verify: clinical vectors including completed high/bypassed states, synthetic E2E.

### [ ] INS-055C — Add the clozapine aggressive-behavior pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055B
- Outcome: reviewed route and execution for `BNs/9 - Clozapine in Aggressive Behavior _/gemini-code-1783422744909.xml` if structurally eligible.
- Required work: define structured trigger data and outputs; no free-text-only trigger; add deterministic fixtures or preserve quarantine with blocker.
- Acceptance: routing cannot be selected by LLM or unnormalized notes; active version/hash and evidence limits are pinned; replay passes.
- Verify: route vectors, artifact report, synthetic pathway E2E.

### [ ] INS-055D — Add the continuing-medication pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055C
- Outcome: reviewed route and execution for `BNs/5 - Continuing Medications/gemini-code-1783421787562.xml` if structurally eligible.
- Required work: define inputs/outputs and relationship to plan revisions; add deterministic fixtures or exact quarantine state.
- Acceptance: prior/current medication facts and plan state are version-pinned; routing is deterministic; replay/provenance pass.
- Verify: route vectors and synthetic pathway E2E.

### [ ] INS-055E — Add the continuing-same-medication pathway (not implementing)

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055D
- Outcome: reviewed route and execution for `BNs/6 - Continuing the Same Medication/gemini-code-1783439886327.xml` if structurally eligible.
- Required work: define non-overlapping/ordered behavior relative to INS-055D; ambiguous simultaneous routes fail unless the reviewed rule set explicitly permits both.
- Acceptance: route conflict table passes; selected model version/hash is pinned; CPT/inference replay passes.
- Verify: overlap/precedence vectors and synthetic E2E.

### [ ] INS-055F — Add the long-acting injectable pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055E
- Outcome: reviewed route and execution for `BNs/10 - Long Acting Antipsychotic Medications/gemini-code-1783423101383.xml` if structurally eligible.
- Required work: route only from adherence/history/regimen facts; add deterministic fixtures or exact quarantine reason.
- Acceptance: no LLM-selected route; active model/evidence metadata pinned; replay and synthetic case pass.
- Verify: clinical route vectors and pathway E2E.

### [ ] INS-055G — Add the acute-dystonia pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055F
- Outcome: reviewed route and execution for `BNs/11 - Acute Dystonia & anticholinergic therapy/gemini-code-1783438905589.xml` if structurally eligible.
- Required work: route from governed adverse-effect term/rules only; add fixtures or quarantine reason.
- Acceptance: structured catalog pin and matched rule provenance are present; replay passes.
- Verify: rule/route vectors and synthetic E2E.

### [ ] INS-055H — Add the parkinsonism pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055G
- Outcome: reviewed route and execution for `BNs/12 - Treatments for Parkinsonism/gemini-code-1783423778176.xml` if structurally eligible.
- Required work: route from governed adverse-effect term/rules only; reject unsupported influence-diagram semantics; add fixtures or quarantine reason.
- Acceptance: selected semantics are explicitly supported and tested; otherwise model stays non-active; replay passes when enabled.
- Verify: validation report, clinical vectors, synthetic E2E.

### [ ] INS-055I — Resolve and add or permanently reject the Akathisia pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055H
- Outcome: the known content mismatch in `BNs/13 - Treatments for Akathesia/gemini-code-1783423969512.xml` is resolved with a corrected governed artifact or permanently rejected with no route.
- Required work: never activate current mismatched content; if corrected source is supplied, treat it as a new version and add governed route/CPT/inference fixtures.
- Acceptance: current hash remains quarantined; no Akathisia trigger can select it; any replacement has independent review, hash, and full tests.
- Verify: quarantine regression and, if supplied, corrected-pathway E2E.

### [ ] INS-055J — Add the VMAT2/tardive-dyskinesia pathway

- Sensitivity/model: **Critical — Frontier plus clinical review**
- Depends on: INS-055I
- Outcome: reviewed route and execution for `BNs/14 - VMAT2 Medications for Tardive Dyskinesia/vmat2_tardive_dyskinesia_bn.xml` if structurally eligible.
- Required work: route from governed adverse-effect/medication facts; support only validated semantics; add fixtures or quarantine reason.
- Acceptance: deterministic structured route, pinned model/evidence metadata, and replay pass.
- Verify: clinical vectors and synthetic E2E.

### [ ] INS-055K — Gate the involuntary-treatment pathway behind jurisdiction policy

- Sensitivity/model: **Critical — Frontier plus legal/clinical review**
- Depends on: INS-055J
- Outcome: `BNs/Involuntary-Treatment-Considerations/BN-Involuntary-Treatment-Considerations.xml` remains unroutable by default and becomes eligible only under a future explicitly selected, versioned jurisdiction policy package.
- Required work: implement policy-package gate and deterministic route hook; do not invent universal legal criteria; pin policy/model versions and evidence if a package is supplied.
- Acceptance: no-policy deployments can never select the model; LLM cannot override; enabled policy fixtures route deterministically without changing core jurisdiction-neutral behavior.
- Verify: default-deny tests and optional supplied-policy golden vectors.
- References: ADR-002, ADR-022.

### [ ] INS-056 — Implement Final Plan revisions and supersession

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-052, INS-053
- Outcome: Psychiatrist creates `REVISION_DRAFT` seeded from active Final Plan; new final version atomically supersedes predecessor inside the same Research Case.
- Required work: no reason/acknowledgement field; preserve sequence/predecessor/status/author/time/full provenance; rerun invalidated imputation/CPT/BN/DDI/plan steps when dependencies changed; old versions remain immutable/readable.
- Acceptance: exactly one active version; idempotent retry returns same version; no second Research Case; unchanged source final remains byte-identical; concurrent supersession race has deterministic winner and no overwrite.
- Verify: version-chain, race, invalidation, immutability tests and browser E2E.
- References: ADR-014, product Final Treatment Plan.

### [ ] INS-057 — Build Final Plan history, print, and export

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-056, INS-059
- Outcome: authorized version-history, detailed final view, print stylesheet, and generated export artifact for each immutable plan.
- Required work: show active/superseded status and predecessor; include exact structured regimen and permitted provenance; omit generic AI-imputation notice/details and generic `UNKNOWN` warning; calculate age against Research Case start; mask identifiers appropriately.
- Acceptance: exported/printed values match immutable snapshot; superseded versions remain accessible; Administrator cannot access exports; export hash/metadata are pinned; no mutable draft controls appear.
- Verify: export content snapshot, visual print/PDF check, authorization tests.
- References: ADR-011, ADR-012, ADR-014, ADR-019.

### [ ] INS-058 — Build separated operational and clinical audit views

- Sensitivity/model: **High — Advanced**
- Depends on: INS-016, INS-053
- Outcome: Administrator operational-audit UI with sanitized metadata and Psychiatrist clinical-audit UI with authorized Patient history, including deletion survivors.
- Required work: enforce separation in query/service layer, not only UI; support pagination/filtering/timezone display; clinical view shows attributable before/after and provenance references; ordinary audit-table limitations remain explicit.
- Acceptance: Administrator responses contain no Patient UUID/name/identifier/free text/clinical value/plan; Psychiatrist can inspect surviving deleted-Patient audit only through authorized audit path; no edit/delete actions exist.
- Verify: fixture leakage scan, authorization matrix, pagination/filter tests, browser E2E.
- References: ADR-007, ADR-019, ADR-023.

### [ ] INS-059 — Implement the artifact service and best-effort lifecycle

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-003, INS-007, INS-013, INS-016
- Outcome: module-owned artifact metadata and authorized file storage for XMLBIF, DDI sources, exports, and large provenance payloads.
- Required work: UUID relative paths only; validate media type/size; write final target file first, then metadata; store bytes/SHA-256/access class/version; never overwrite; safe path resolution prevents traversal/symlink escape; no staging/atomic rename/orphan scanner.
- Acceptance: file failure prevents metadata; metadata failure may leave documented orphan; reads verify hash and owner authorization; browser cannot request paths; Patient deletion makes one later best-effort removal attempt.
- Verify: traversal/symlink/hash/partial-failure/authorization integration tests.
- References: ADR-019, ADR-020, domain model `Artifact`.

## Phase 9 — Operations, hardening, and release proof

### [ ] INS-060 — Implement manual PostgreSQL-only backup

- Sensitivity/model: **Critical — Frontier**
- Depends on: INS-010, INS-003, INS-007, INS-016
- Outcome: Administrator-triggered complete custom-format database dump plus JSON manifest, audited and exported outside the live database directory.
- Required work: manifest includes app version, PostgreSQL major, migration head, timestamp, byte length, and SHA-256; include master key/ciphertext as inherent DB content; no Patient preview/selective export; no schedule/retention/off-site copy/archive encryption/artifact backup.
- Acceptance: only Administrator can start/download status; clinical content never enters UI/logs; produced hash verifies; documentation states backup is incomplete without independently surviving artifact volume.
- Verify: create and inspect backup in production-shaped container, authorization/error tests.
- References: ADR-018, ADR-020.

### [ ] INS-061 — Implement full-replacement restore in maintenance mode

- Sensitivity/model: **Critical — Frontier plus operator review**
- Depends on: INS-060, INS-059, INS-017
- Outcome: explicit maintenance operation validates and replaces the whole PostgreSQL database, then runs allowed forward migrations/integrity checks before reopening traffic.
- Required work: validate format/manifest/hash/PostgreSQL major/app/schema compatibility/readability; block normal requests/jobs; never merge or selectively restore; verify artifact references against existing volume and report missing/mismatched files; never restore during normal startup.
- Acceptance: corrupt/incompatible backup leaves live database untouched; valid restore replaces all rows and preserves key usability; failed post-check keeps maintenance mode; no claim that missing artifacts were recovered.
- Verify: disposable full backup/modify/restore comparison, corruption/version/artifact-loss tests, documented recovery rollback.
- References: ADR-019, ADR-020.

### [ ] INS-062 — Complete process lifecycle, health, maintenance, and network controls

- Sensitivity/model: **High — Advanced**
- Depends on: INS-007, INS-030, INS-061
- Outcome: production supervisor starts/stops Fastify, worker, and PostgreSQL safely; readiness distinguishes components; maintenance mode and intended egress boundaries are operational.
- Required work: migration lock before readiness; request drain; stop claims/expire leases safely; PostgreSQL checkpoint before exit; database internal bind; HTTPS deployment guidance; egress guidance limited to configured model host; no horizontal-scaling claim.
- Acceptance: SIGTERM produces orderly shutdown; crash/restart recovers jobs; database-down is unhealthy/not ready; maintenance blocks ordinary traffic; absent/corrupt/incompatible volume fails closed.
- Verify: container fault-injection and shutdown/startup tests.
- References: ADR-006, ADR-015, ADR-021.

### [ ] INS-063 — Complete the server authorization and object-access matrix

- Sensitivity/model: **Critical — Frontier plus security/privacy review**
- Depends on: INS-053, INS-058, INS-062
- Outcome: explicit allow/deny classification and tests for every REST, SSE, job, MCP, audit, artifact, backup, restore, and workflow command.
- Required work: prevent direct-object-reference and role-confusion access; enforce current account/session and workflow state at service boundary; prove Administrators cannot reach Patient/clinical payloads and Psychiatrists cannot administer the system; retain shared cross-Psychiatrist Patient authority.
- Acceptance: every route/tool has a matrix row; all negative tests pass; hiding navigation is never the only control; accepted immediate Psychiatrist deletion/shared-registry rules remain unchanged.
- Verify: generated authorization inventory, automated matrix suite, human security review.
- References: all trust-boundary ADRs, system architecture accepted risks.

### [ ] INS-063A — Complete privacy, de-identification, and logging hardening

- Sensitivity/model: **Critical — Frontier plus privacy review**
- Depends on: INS-031, INS-058, INS-063
- Outcome: direct identifiers, clinical payloads, credentials, master key, session tokens, and internal paths are absent from every unauthorized model/API/UI/log/error/audit surface.
- Required work: run adversarial free-text/structured projection tests; scan captured model requests, application/worker/PostgreSQL-facing logs, SSE events, diagnostics, OpenAPI examples, and operational audit; verify clinical audit remains complete but role-separated.
- Acceptance: no seeded canary secret/identifier crosses a forbidden boundary; uncertain de-identification fails closed; accepted provider retention/training policy is documented without weakening field exclusion.
- Verify: canary leakage suite, log/artifact scan, privacy review record.

### [ ] INS-063B — Complete input, parser, transport, and abuse hardening

- Sensitivity/model: **High — Advanced**
- Depends on: INS-029, INS-039, INS-059, INS-063A
- Outcome: bounded request/file/XML/model payloads, secure headers/cookies/CSRF/rate limits, dependency review, and injection/path defenses.
- Required work: test SQL/XML/path/symlink/header/JSON nesting attacks; cap body, upload, XML depth/node count, tool arguments, progress payloads, and timeouts; preserve loopback-development exceptions explicitly; add safe `429`/limit errors.
- Acceptance: malicious fixtures fail without resource exhaustion or sensitive diagnostics; TLS guidance and production cookie headers are correct; dependency audit findings are resolved or documented.
- Verify: automated abuse suite, dependency audit, container resource-limit smoke test.

### [ ] INS-064 — Harden durable-job and dependency failure recovery

- Sensitivity/model: **High — Advanced**
- Depends on: INS-053, INS-062
- Outcome: resilient leases, retries, cleanup/indexes, cancellation, stale-input handling, and typed failure UX for model/imputation/CPT/BN/DDI/plan jobs.
- Required work: bound retry categories exactly; preserve failed executions; prevent lease theft/duplicate accepted results; expire abandoned streams safely; do not convert worker success into domain success; never retry non-retryable clinical/provenance failures automatically.
- Acceptance: restart at each workflow stage recovers safely; `401/404` compatibility failures do not spin; `408/429/5xx` obey bounded policy; user rerun creates a new execution where required; finalization remains blocked after exhaustion.
- Verify: fault-injection matrix and database index/query-plan check.
- References: ADR-005, ADR-009, ADR-015, ADR-017, MCP error table.

### [ ] INS-065 — Complete accessibility and universal page states

- Sensitivity/model: **Low — Economy**
- Depends on: INS-053, INS-057, INS-058
- Outcome: every data/workflow page implements loading, empty, validation, unauthorized, dependency unavailable, queued/running/failed/succeeded, and stale-input states with accessible desktop-first behavior.
- Required work: semantic landmarks/labels/tables; keyboard operation; visible focus; reduced motion; no color-only C-SSRS/DDI status; persistent urgent information; content-shaped skeletons only where useful; supported narrow-width layouts.
- Acceptance: automated accessibility scan has no serious violations; critical flows complete by keyboard; status text remains understandable without color; refresh/reconnect state is announced appropriately.
- Verify: component state inventory, accessibility automation, manual keyboard and narrow-width pass.
- References: product loading/accessibility requirements, UI context.

### [ ] INS-066 — Establish capacity and resource benchmarks

- Sensitivity/model: **Moderate — Standard**
- Depends on: INS-054E, INS-055K, INS-062
- Outcome: measured supported single-instance envelope for users, Patients, audit events, jobs, artifact sizes, database/volume growth, memory, CPU, and response/job latency.
- Required work: synthetic benchmark only; test PostgreSQL and application sharing container resources; identify required indexes/limits; measure SSE reconnect and restart recovery; avoid unmeasured claims and premature distributed architecture.
- Acceptance: repeatable benchmark script/report records hardware/container limits and pass thresholds; documented ceilings fail safely; no multi-replica support is implied.
- Verify: two repeat runs with comparable results and stored summary.
- References: ADR-006 implementation defaults, single-instance architecture.

### [ ] INS-067 — Run final release acceptance and close the backlog

- Sensitivity/model: **Critical — Frontier plus human clinical/security/operations review**
- Depends on: INS-018, INS-054A through INS-054E, INS-055 through INS-055K, INS-056 through INS-066, INS-063A, INS-063B, and every required EXT gate for intended deployment mode
- Outcome: fully functioning INSIGHT research prototype, production-shaped image, complete synthetic acceptance evidence, activation-gate report, and reconciled user/operator/developer documentation.
- Required work: run all checks, migrations, OpenAPI drift, browser E2E, vertical slice, pathway/DDI matrices, accessibility, security/privacy, backup/restore, artifact-loss, job restart, model failure, DDI failure, and sole-Administrator-loss procedure review; inventory accepted risks and unresolved clinical limitations.
- Acceptance: every issue is `[x]` or explicitly excluded by a new accepted decision; no required gate is falsely marked satisfied; all external-input hashes/approvals are pinned for the intended mode; clean deployment, use, restart, backup, restore, and finalization succeed with synthetic data.
- Verify: signed release checklist with exact commands/results, image/version/migration head, hashes, reviewers, known limitations, and rollback procedure.
- References: `Plan.md` Packet 8, all ADRs and implementation specifications.

## Dependency-order note

Issue numbers group related work but dependencies are authoritative. In particular:

- INS-016 must precede INS-014 because Patient overwrite requires transactional clinical audit.
- INS-044 first supports an optional imputation reference; INS-047 must complete its bypassed-assessment integration before INS-049.
- INS-059 must precede INS-018, INS-036, INS-040, and INS-057 because those issues require artifact deletion/storage.
- INS-041A and INS-041B complete the BN Manager editor after INS-041 establishes upload/diagnostic views.
- INS-054A–INS-054E and INS-055A–INS-055K are independent session-sized expansions; none may be collapsed into one unchecked bulk session.
- INS-063A and INS-063B complete privacy and abuse hardening after the authorization matrix.
- External inputs close production activation gates but must never be fabricated to make an issue appear complete.

## Definition of fully functioning

The backlog is complete when a fresh deployment can:

1. start safely from the required external volume and expose healthy React/Fastify/PostgreSQL services;
2. authenticate and administer users with the fixed role and session policies;
3. register or resolve one Patient, preserve one Research Case, and enforce Administrator isolation;
4. complete or bypass governed assessments and capture governed medical history;
5. normalize medication identities, run deterministic governed DDI, route governed BN models, generate/validate/reuse patient-specific CPTs, and replay deterministic inference;
6. create an explainable structured Primary Plan, accept Psychiatrist edits, recheck the exact regimen, and finalize an immutable version;
7. supersede a plan without rewriting history, inspect authorized audit/provenance, export a final plan, and immediately hard-delete a Patient while preserving complete clinical audit;
8. survive refresh/restart, reject stale or unauthorized actions, fail closed on required dependency failures, and never leak direct identifiers to the hosted model;
9. govern model/source/catalog versions, operate manual database-only backup and full restore, and accurately report missing artifact recovery;
10. pass synthetic functional, clinical-vector, privacy, security, accessibility, failure-recovery, and operations acceptance suites while presenting every accepted research risk and external activation gate honestly.

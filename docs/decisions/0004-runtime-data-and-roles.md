# ADR-004: Web Runtime, PostgreSQL, and Roles

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** client runtime, primary datastore, access-control roles

## Context

INSIGHT needs a multi-user clinical research workspace, centralized identified records, a hosted-model gateway, and an integrated administrator-facing BN Manager. The existing Bayes Engine is an Electron application, but INSIGHT's target runtime and persistence layer had not been selected.

## Decision

### Desktop-first web application

INSIGHT is a browser-based, desktop-first web application. Frontend and backend application components ship as one versioned Docker image. Browser routes and API calls remain relative to the application gateway.

ADR-016 selects TypeScript end-to-end: React with Vite for the browser application and Node.js with Fastify for the backend modular monolith.

The integrated BN Manager uses the same web application, authentication context, audit system, and navigation as other INSIGHT modules. The existing Electron Bayes Engine remains a source implementation while its reusable TypeScript domain logic and administrator workflows are adapted for the web application; INSIGHT will not require a separate Electron client.

Desktop-first does not mean fixed-width. Core workflows must remain usable at narrower supported widths, but mobile-first clinical use is not an initial goal.

ADR-021 makes the application single-tenant: a deployment contains one research organization/project and does not partition data among institutions.

### PostgreSQL system of record

PostgreSQL is the authoritative datastore for identified research records, configuration, model metadata, workflow state, final plans, and audit records. ADR-019 stores large binary artifacts on the external persistent volume with PostgreSQL metadata and hashes.

The modular monolith uses one PostgreSQL service with explicit module ownership of tables and versioned migrations. Modules may share transactions through documented application services, but they must not rely on undocumented cross-module table writes.

Database requirements include:

- UUID primary identities and database constraints for uniqueness and references;
- a unique normalized official-identifier tuple per deployment;
- explicit schema versions and forward-only production migrations, with rollback or recovery procedures exercised against every migration before release;
- transactional treatment-plan finalization and idempotency keys;
- append-only final-plan revisions and attributable audit events;
- UTC timestamps plus the user's display timezone;
- encrypted sensitive fields using the database-held master-key architecture selected by ADR-018;
- backup, restore, retention, and integrity-check procedures.

ADR-006 places PostgreSQL inside the all-in-one application container. ADR-018 stores the application encryption master key in PostgreSQL itself and defines manual-only backups.

ADR-015 places one internal MCP Gateway and a PostgreSQL-backed durable job worker inside the same deployment. The browser reaches only the backend application API; it never connects directly to the hosted model, MCP tools, or PostgreSQL.

### Two fixed roles

INSIGHT defines exactly two application roles initially:

#### Administrator

- provisions and disables accounts;
- manages system and research-environment configuration;
- records external research-approval metadata and enables identified research mode;
- manages DDI and Bayesian knowledge artifacts, automatic-activation policy, disablement, and rollback;
- reviews operational, security, MCP, and non-clinical audit metadata without patient content;
- performs backup and restore operations.

Administrator status does not grant authority to create, approve, or finalize a patient's treatment plan. ADR-007 prohibits all Administrator access to patient clinical content and provides no break-glass path.

#### Psychiatrist

- creates and locates patient records;
- works in the Patient's single Research Case and completes or explicitly bypasses permitted assessments;
- uses the LLM/MCP workflow;
- reviews evidence and DDI results;
- accepts or modifies draft recommendations with attributable rationale;
- explicitly finalizes treatment plans.

Psychiatrists cannot provision users or change system-wide knowledge configuration. Model activation is automatic under ADR-005 rather than a Psychiatrist action.

Role permissions are fixed in the initial release; custom role construction is out of scope. There is no public signup. ADR-008 supersedes the secure-bootstrap requirement: every installation creates `admin/admin`, and the product does not force a password change.

Formal ethics or institutional approval remains external to INSIGHT. The Administrator records approval evidence and activates the corresponding configuration but does not grant that approval.

## Consequences

- Existing Electron UI code is not the final INSIGHT shell; useful domain behavior must be separated from Electron-specific file and window APIs during integration.
- PostgreSQL migrations and recovery tests become part of every persisted-schema change.
- All authorization checks must be enforced server-side, not only by hiding UI controls.
- The two-role model creates a deliberate limitation: independent in-app research oversight and read-only clinical auditing are unavailable.
- Administrator patient-content access is prohibited by ADR-007.

## Resolution Map

- PostgreSQL deployment: ADR-006;
- authentication, sessions, Administrator access, and concurrency: ADR-007, ADR-008, ADR-018, and ADR-023;
- encryption-key storage and backup: ADR-018 through ADR-020;
- application stack, API, jobs, MCP, and browser boundary: ADR-015 through ADR-017.

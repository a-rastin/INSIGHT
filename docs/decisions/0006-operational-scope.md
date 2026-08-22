# ADR-006: Immediate Activation, Manual Freshness, and All-in-One Deployment

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** model release scope, DDI freshness, deployment topology

## Context

ADR-005 established automatic model activation and blocking failures but left activation scope and DDI freshness open. ADR-004 selected a web application and PostgreSQL but did not decide whether PostgreSQL runs separately.

## Decision

### Immediate activation in Psychiatrist workflows

The newest Bayesian-model version that passes every required software check becomes active immediately in the Psychiatrist workflow. There is no sandbox-only promotion gate, scheduled release window, or clinical-approval prerequisite.

The active version's evidence, calibration, and clinical-review status must remain visible. Those fields inform the Psychiatrist but do not delay activation. Each Research Case pins the active version when the pathway first runs so a later automatic activation cannot silently change an in-progress draft.

An Administrator may disable an active model or roll back to an earlier passing version. Disablement and rollback are attributable events and affect new executions; existing finalized plans retain their original model version and content hash.

### Manual DDI freshness

DDI knowledge has no fixed maximum age and does not become stale solely because time passes. An active source record remains eligible until an Administrator explicitly retires, rejects, or supersedes it.

Every DDI result and evidence view must still display the source date when known, retrieval timestamp, last review timestamp, and active version. Absence of a time-based expiry does not waive the permission and manifest gate in ADR-005.

Finalization remains blocked when the DDI knowledge base is disabled, unlicensed, missing required manifest data, rejected, retired without a replacement, unavailable, or unable to produce attributable results. Age alone does not trigger that block.

This policy permits outdated interaction guidance to remain active indefinitely if no Administrator intervenes. That is an accepted limitation of the selected manual-retirement policy.

### All-in-one container

INSIGHT's frontend assets, application gateway, backend process, MCP servers, and PostgreSQL server are packaged and run in one container. One container does not mean one process or erased module boundaries.

Operational requirements:

- a minimal process supervisor starts, monitors, and gracefully stops application and PostgreSQL processes;
- PostgreSQL listens only on the container-internal interface unless explicitly configured otherwise;
- database files live on a required external persistent volume and never only in the container's writable layer;
- startup fails safely when the volume is missing, unwritable, corrupt, or incompatible;
- the PostgreSQL major version is pinned and upgrades require an explicit backup and migration procedure;
- schema migrations run under a database lock before application readiness;
- health and readiness report application and database status separately;
- shutdown drains requests, stops background work, checkpoints PostgreSQL, and then exits;
- backup files are written outside the live database directory and can be exported from the container;
- restore runs as an explicit maintenance operation, never during ordinary startup;
- resource limits account for both application and database memory and storage needs.

The single image is optimized for one-site research deployment, not horizontal application scaling. Scaling the container would create multiple independent PostgreSQL instances and is unsupported.

## Consequences

- A software-compatible but clinically unsound model may reach Psychiatrist workflows immediately.
- No automated DDI age control protects against an Administrator failing to retire old material.
- Container replacement is safe only when the persistent volume and encryption keys are preserved.
- Application and database failures share one container lifecycle and maintenance window.
- Horizontal scaling and managed-database failover are deferred.

## Implementation Defaults

- use a pinned Debian-slim base and a minimal process supervisor for Fastify/worker and PostgreSQL lifecycle;
- use the manual PostgreSQL-only export and restore contract in ADR-018 through ADR-020;
- keep the database-held master key fixed in the initial release; automatic rotation is out of scope;
- establish resource minimums and supported data volume through the Packet 8 acceptance benchmark rather than claiming unmeasured capacity;
- pin the PostgreSQL major version; upgrades require a manual backup, maintenance mode, compatibility preflight, and forward migrations.

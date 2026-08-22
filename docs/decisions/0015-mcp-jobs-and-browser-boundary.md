# ADR-015: Internal MCP Gateway, Durable Jobs, and Browser Boundary

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** MCP topology, long-running execution, browser/server trust boundary

## Context

INSIGHT is a modular monolith deployed as one container with PostgreSQL. The hosted LLM acts as the logical MCP client, while a deterministic backend state machine owns workflow authorization. LLM generation, assessment imputation, CPT generation, BN inference, DDI evaluation, and plan generation can outlive a normal browser request and must remain recoverable after a process restart.

## Decision

### One internal MCP Gateway

INSIGHT exposes one server-side MCP Gateway containing namespaced tools for the modular-monolith domains, including:

- `assessment.*` for deterministic DSM-5-TR, PANSS, and suicide-risk operations;
- `medication.*` for canonical catalog search and normalization validation;
- `ddi.*` for versioned interaction evaluation;
- `bn.*` for model retrieval, CPT validation, snapshot persistence, and deterministic inference;
- `treatment_plan.*` for draft assembly support and structured plan validation.

These namespaces are module boundaries inside one application, not independently deployed MCP servers. The backend state machine supplies a per-state tool allowlist. The server-side agent runtime sends the allowlisted schemas to the hosted model, receives structured tool requests, validates them, invokes the internal gateway, filters the result through the de-identification boundary, and returns the permitted result to the model.

The MCP Gateway has no public listener or browser-accessible endpoint. Domain tools cannot bypass their owning module's authorization, transaction, provenance, or validation rules. The gateway cannot finalize a plan; finalization remains an application state transition initiated by an authenticated Psychiatrist.

### PostgreSQL-backed durable jobs

Potentially long-running AI and clinical-computation operations execute as durable jobs persisted in PostgreSQL. No Redis, external queue, or additional service is required. A worker running in the same application/container claims jobs with transactional leases.

Each job records:

- job type and owning Research Case;
- input and dependency fingerprint;
- requested-by actor and workflow state;
- status: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, or `CANCELLED`;
- attempt count, lease owner, lease expiry, and retry eligibility;
- typed progress events and sanitized error diagnostics;
- idempotency key and result/provenance references;
- creation, start, completion, and update timestamps.

Expired leases allow safe recovery after restart. Idempotency and immutable execution identifiers prevent a retried browser action from creating duplicate accepted snapshots or Final Treatment Plans. Module-specific retry and fail-closed rules remain authoritative; the job system does not convert a failed clinical dependency into success.

The UI starts an operation through the backend, receives a job identifier, and obtains progress through authenticated Server-Sent Events on the versioned REST API defined by ADR-017. Closing or refreshing the browser does not cancel durable work.

### Browser communicates only with backend

The browser calls only authenticated INSIGHT backend endpoints. It never calls the hosted model, MCP Gateway, module tools, or PostgreSQL directly. Hosted-model API keys, database credentials, de-identification mappings, and tool authorization remain server-side.

The backend validates every request against the authenticated role and current persisted workflow state. Browser state is advisory and cannot unlock tools, advance the workflow, forge a successful job, or finalize a plan.

## Consequences

- One MCP surface preserves explicit tool contracts without introducing a distributed microservice system.
- Tool-call authorization is centralized at the backend state-machine boundary.
- Browser code contains no hosted-model secret and cannot directly expand model-visible Patient context.
- Durable work survives refreshes and process restarts without adding Redis.
- PostgreSQL carries transactional data and queue load; the single-instance deployment needs lease, cleanup, and index discipline.
- Individual MCP modules cannot be scaled or deployed independently without a later architecture change.

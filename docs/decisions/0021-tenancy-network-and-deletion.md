# ADR-021: Single Tenancy, LLM-Only Egress, and Immediate Deletion

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** deployment tenancy, runtime network boundary, deletion interaction

## Context

INSIGHT runs as one modular-monolith deployment whose Psychiatrists share all Patients. The hosted model requires network access, while clinical knowledge and computation are local. Patient hard deletion is permitted and needs an interaction rule.

## Decision

### One organization/project per deployment

One deployment belongs to exactly one research organization or project. All users, Patients, Research Cases, configuration, knowledge artifacts, and audit records belong to that implicit tenant. Domain tables do not contain a tenant identifier, sessions cannot switch organizations, and APIs do not route by tenant.

A second organization requires a separate container deployment, PostgreSQL database, persistent volume, credentials, and model configuration.

### Hosted-model endpoint is the only runtime egress

DDI sources, Bayesian models, assessment artifacts, database operations, and filesystem artifacts remain local. Runtime does not scrape live medical websites or automatically download knowledge updates.

The backend's only required outbound traffic is HTTPS to the active OpenAI-compatible endpoint. The browser never calls it directly. Deployment infrastructure should limit egress to the configured host where practical.

### Immediate deletion by one Psychiatrist

Any enabled Psychiatrist session may request permanent Patient deletion. INSIGHT does not require password re-entry, a confirmation dialog, typed Patient identity, delay, second Psychiatrist approval, or Administrator participation.

The request proceeds directly to the deletion workflow in ADR-020. A mistaken click and a compromised Psychiatrist session therefore possess the same deletion authority as an intentional action. ADR-023 defines the clinical audit history that survives.

## Consequences

- Multi-tenant isolation code is absent from the application and schema.
- Separate organizations require separate deployments.
- General internet connectivity is unnecessary beyond the hosted-model endpoint.
- Any active Psychiatrist session can erase any shared Patient without an interaction safeguard.

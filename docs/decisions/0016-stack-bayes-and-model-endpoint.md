# ADR-016: TypeScript Stack, Bayes Integration, and Model Endpoint

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** application stack, Bayes Engine migration, hosted-model client boundary

## Context

The repository's only executable component is an Electron application built with React and TypeScript for XMLBIF editing. INSIGHT needs a browser application, backend workflow engine, PostgreSQL persistence, internal MCP Gateway, durable workers, and hosted-model tool calling. The implementation stack and reuse boundary determine whether the existing Bayes Engine can be integrated without running a second application.

## Decision

### TypeScript end-to-end

INSIGHT uses:

- React and Vite for the browser frontend;
- Node.js and Fastify for the backend modular monolith and internal worker;
- PostgreSQL for domain persistence, workflow state, provenance, audit references, and durable jobs;
- TypeScript packages shared only for stable schemas and pure domain logic that are safe on both sides of the browser boundary.

The frontend does not import server modules or gain access to secrets, database code, MCP execution, or patient de-identification mappings. Runtime validation remains required at every HTTP, job, model, MCP, XMLBIF, and database boundary even when TypeScript types are shared.

### Bayes Engine becomes an integrated BN Manager

Production INSIGHT does not launch, embed, or depend on Electron. Reusable Bayes Engine code is separated into environment-independent TypeScript modules, beginning with XMLBIF parsing, serialization, structural validation, CPT dimension and normalization checks, graph transforms, and deterministic model hashing.

Electron file-system, window, IPC, and desktop lifecycle code does not enter the server domain package. Administrator-facing graph and table workflows are rebuilt as routes and React views inside the authenticated INSIGHT shell. Model file operations pass through backend APIs, authorization, validation, versioning, activation, and audit rules.

The standalone Electron source may remain as a legacy development reference until migration is complete, but it is not shipped in the INSIGHT runtime image and does not operate on the production database or model store.

### Direct OpenAI-compatible model client

The backend connects directly to one configured OpenAI-compatible base URL using a configured model identifier and credential. INSIGHT does not define a vendor-neutral provider interface or per-provider adapters. ADR-017 places configuration ownership in the Administrator UI and defines failure without automatic fallback.

The endpoint must support the Chat Completions tool-calling behavior required by MCP orchestration and CPT schemas. INSIGHT uses native server-side HTTP with Bearer authentication and the minimal transport profile defined in `docs/architecture/mcp-contracts.md`; it does not depend on a provider SDK, provider-specific headers, the Responses API, or provider-side structured-output enforcement. Structured clinical outputs travel as function arguments. Before execution, the backend checks the complete argument payload against the applicable MCP runtime input schema.

The configured base URL is an API root. INSIGHT preserves its path and appends only `chat/completions`; it never guesses or rewrites a `/v1` segment. “OpenAI-compatible” is a configuration claim, not proof of semantic compatibility. Deployment validation must exercise the exact configured credential, model, request path, forced tool calls, tool-result round trip, local schema validation, error mapping, and model-identity capture before enabling AI workflows.

Every execution stores the configured base-URL identity without embedded credentials, requested model identifier, returned model metadata when available, prompt/schema versions, settings, tool calls, and raw/accepted structured outputs. Changing the endpoint, model, or relevant capability configuration invalidates dependent AI imputations and CPT snapshots.

## Consequences

- Frontend, backend, shared contracts, MCP schemas, and reusable Bayesian logic use one programming language.
- Existing React and TypeScript Bayes Engine work can be migrated without shipping Electron.
- Fastify remains the single browser-facing application boundary and worker host.
- Any endpoint implementing the documented Chat Completions transport profile can be changed through deployment configuration without code changes; incompatible behavior is handled as failure rather than through a specialized adapter.
- Provider-specific capabilities cannot be supported cleanly without revisiting this decision.

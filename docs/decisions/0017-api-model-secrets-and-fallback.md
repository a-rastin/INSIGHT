# ADR-017: REST API, Administrator Model Secrets, and No Fallback

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** browser API, model endpoint configuration, credential storage, model failure behavior

## Context

The browser communicates only with the Fastify backend, durable operations report progress, and the backend targets one OpenAI-compatible model endpoint. The system needs a stable browser/server contract, an owner for endpoint credentials, and deterministic behavior when the configured model is unavailable.

## Decision

### Versioned REST API and Server-Sent Events

Fastify exposes a versioned REST/JSON API. Request bodies, parameters, responses, error objects, and authorization requirements are defined with runtime schemas from which OpenAPI documentation is generated. TypeScript client types may be generated from the same published contract, but runtime validation remains authoritative.

Authenticated Server-Sent Events deliver ordered durable-job progress and terminal status. Each event has a stable event identifier so a reconnecting browser can resume after its last received event. State changes continue to use normal idempotent REST commands; SSE is not a command channel and does not replace PostgreSQL as the source of job state.

### Administrator-managed model endpoint and credential

Administrators configure the active OpenAI-compatible base URL, model identifier, non-secret capability settings, and API credential through the Administrator UI. The backend validates the endpoint shape and required structured tool behavior before the configuration can become active.

Saving does not activate a configuration. The backend first normalizes the base URL under the transport rules in `docs/architecture/mcp-contracts.md`, stores the credential as write-only encrypted data, and runs the exact two-request tool-call compatibility probe. A configuration is eligible for activation only when the probe passes with its saved base URL, model, and credential. Any change to those values invalidates the prior result and blocks new AI jobs until the replacement passes.

ADR-022 explicitly removes provider retention, no-training, and data-processing terms from activation criteria. Compatibility and local de-identification checks still apply.

The credential is encrypted before being stored in PostgreSQL. It is write-only: API responses, UI reloads, audit events, job diagnostics, and logs never return its plaintext or a reversible masked value. An Administrator may replace or clear it but cannot retrieve the stored plaintext. Configuration history stores non-secret metadata, actor, timestamps, and encrypted-secret references.

Administrator access to model configuration does not grant access to Patient content. ADR-018 stores the encryption master key in the same database and selects manual Administrator-triggered exports.

### No automatic endpoint or model fallback

Each AI job pins the active endpoint-configuration version and requested model at creation. Transient errors receive a bounded retry policy. When retries are exhausted, the job fails with a typed diagnostic and the applicable fail-closed workflow rule applies.

INSIGHT has no ordered fallback endpoints, automatic model substitution, or indefinite retry. An Administrator may later activate a different configuration, but a user-initiated rerun becomes a new execution with the new pinned configuration and provenance; the failed execution remains immutable.

## Consequences

- OpenAPI provides a language-neutral, testable browser/backend boundary.
- SSE supports restartable progress display without introducing bidirectional socket state.
- Administrators can deploy or rotate hosted-model access without container environment changes.
- Compatible Chat Completions endpoints require no provider-specific adapter, while partial or text-only compatibility fails before clinical data is sent.
- Because ADR-018 stores the master key in PostgreSQL, full database compromise exposes both the encrypted model credential and the material needed to decrypt it.
- Model outage blocks AI-dependent finalization instead of silently changing providers or models.
- Switching configuration changes reproducibility inputs and invalidates dependent AI artifacts on the next execution.

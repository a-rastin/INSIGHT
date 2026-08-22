# ADR-005: DDI Source, Model Activation, and Failure Policy

- **Status:** Accepted with external permission gate
- **Date:** 2026-08-21
- **Scope:** DDI authority, Bayesian-model activation, required dependency failures

## Context

The repository contains a local archive of 121 Medscape text files and 8 Medscape PDFs collected for DDI work. The files do not have a repository-wide manifest covering source URL, retrieval time, content version, hash, reuse permission, or review status.

Medscape's official permissions guidance directs users to request permission for reuse, and its help page states that its site material is copyright-protected. The archive therefore cannot safely become an operational application dependency until the required permission is recorded. See [Medscape's permissions guidance](https://help.medscape.com/hc/en-us/articles/360001561611-Citing-Medscape-and-permission-to-use-published-content).

The Bayesian-model archive also contains placeholder probabilities and malformed tables. A repeated basic audit found 6 of 13 XMLBIF artifacts with CPT dimension or normalization failures; a separate seventh artifact declares unsupported BIF `1.0`.

## Decision

### Local Medscape archive as DDI authority

The current local Medscape archive is the selected authoritative source for INSIGHT's initial DDI knowledge base. It is a versioned local snapshot; INSIGHT will not depend on live Medscape scraping at runtime.

Selection does not establish permission to reproduce, transform, distribute, or operationalize the content. DDI capability remains disabled until an Administrator records written permission or another documented legal basis that covers the intended storage, transformation, and research-system use.

ADR-022 records the product premise that the required Medscape permission will be available. INSIGHT therefore defines no alternative DDI source and no LLM-generated fallback. The existing activation gate remains mandatory until the permission record is actually stored.

Before any archive item is imported, it requires a manifest entry containing:

- canonical drug identity;
- source title and URL;
- publisher;
- retrieval timestamp;
- content date or revision date when available;
- SHA-256 content hash;
- parser or extraction version;
- reviewer and review timestamp;
- permission record;
- lifecycle state: `quarantined`, `reviewed`, `active`, `superseded`, or `rejected`.

Derived DDI records must preserve source traceability, interaction severity, mechanism, clinical effect, recommended action, evidence text reference, source revision, and transformation version. Missing or conflicting source data must remain explicit; the LLM may not fill gaps from memory.

### Automatic Bayesian-model activation

A newly imported Bayesian-model version becomes active automatically when all configured software checks pass. Psychiatrist clinical approval is not required for activation.

Required checks include:

- supported XMLBIF version;
- secure parsing within input limits;
- unique and resolvable identifiers;
- valid node types, references, and utility-node restrictions;
- acyclic graph structure;
- complete table dimensions;
- finite numeric values;
- normalized non-negative nature-node distributions;
- deterministic serialization and round-trip semantic equality;
- immutable content hash and model-version record.

Failure of any required check places the version in `rejected`; it cannot become active. Passing checks establishes software compatibility only. It does not establish clinical accuracy, evidence quality, calibration, fairness, or patient-care suitability. The UI must display those evidence states separately.

Automatic activation makes the newest passing version immediately active for its declared pathway in the Psychiatrist workflow. There is no sandbox-only gate or scheduled release window. The prior version remains immutable and available for Administrator rollback. Each draft and Final Treatment Plan records the exact model content hash and version used.

### Required dependency failures block finalization

Treatment-plan finalization is blocked when any dependency required for that Research Case:

- fails or times out;
- is unavailable;
- has no active compatible version;
- returns a blocking diagnostic;
- is stale under its configured freshness policy;
- fails de-identification or authorization checks;
- produces a result that cannot be linked to its input and version provenance.

The incomplete draft may be saved. The UI must identify the failed dependency and offer a safe rerun. The Psychiatrist cannot override the block inside INSIGHT. Urgent clinical care must proceed through ordinary clinical and emergency processes outside reliance on this research prototype.

ADR-010 distinguishes an unavailable or failed DDI check from a successfully returned DDI finding. A failed required check remains blocking; a detected interaction of any severity is warning-only and is not a blocking diagnostic.

ADR-011 adds another explicit distinction: an individual medication that cannot be normalized is recorded as `UNKNOWN` and excluded from interaction evaluation. This incomplete pair coverage does not make the DDI execution a failed dependency and does not block finalization.

## Consequences

- The existing Medscape files remain quarantined until permission and manifest requirements are satisfied.
- No DDI lookup can be marked successful merely because matching text exists in the archive.
- Current malformed or unsupported XMLBIF files will not activate.
- A structurally passing but clinically unsound model can activate automatically; visible evidence and calibration status are therefore essential, but not activation gates under this decision.
- DDI content has no time-based expiry under ADR-006; active content remains usable until an Administrator retires or supersedes it.

## Resolution and External Gate

- Medscape availability is an accepted product premise; repository evidence of permission remains an external activation prerequisite;
- review interval, activation scope, release timing, and no time-based DDI expiry are resolved by ADR-006;
- MCP compatibility, typed errors, retries, and state allowlists are defined in ADR-015, ADR-017, and `docs/architecture/mcp-contracts.md`.

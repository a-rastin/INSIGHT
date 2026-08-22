# ADR-001: Product Foundation

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** product stage, Bayes Engine relationship, initial architecture

## Context

The repository describes a broad INSIGHT clinical decision-support product, but only the standalone Bayes Engine XMLBIF editor is implemented. Clinical Bayesian-network artifacts remain qualitative, several are structurally invalid, and repository-wide privacy, model-governance, and medical-source policies are not yet defined.

Documenting a production clinical system or a distributed service architecture now would imply capabilities and assurances that do not exist.

## Decision

### Research-only stage

INSIGHT is a research prototype. Until later governance explicitly changes this status:

- use only synthetic or properly de-identified data by default; ADR-002 permits identified records inside a formally approved and secured research environment;
- do not rely on outputs for diagnosis, prescribing, emergency triage, or patient care;
- do not describe models as clinically approved merely because they parse or pass software tests;
- preserve visible clinician-control and research-use notices in every recommendation workflow.

### Integrated BN Manager

Bayes Engine capabilities belong inside INSIGHT's administrator-facing BN Manager. That module will own model import, editing, structural checking, review, versioning, activation, rollback, and audit history.

The existing Electron application is a source implementation, not yet the integrated runtime. Reuse, adaptation, or migration will be decided after the main INSIGHT client runtime is selected.

### Modular monolith

INSIGHT will begin as a modular monolith: one application boundary with explicit internal modules and versioned contracts. This minimizes deployment and coordination cost while preserving later extraction paths.

Initial logical modules are:

- authentication;
- administration;
- patient identity and one Research Case per Patient;
- diagnosis;
- PANSS severity;
- medical history and medications;
- DDI evaluation;
- BN Manager and model execution;
- Treatment Plan orchestration and review;
- audit, provenance, backup, and restore.

Module boundaries must remain explicit. ADR-008 deliberately assigns patient-specific CPT generation to the LLM; its prompt, schema, output, and provenance must therefore be versioned rather than hidden in ad hoc chat. Other clinical logic must not be hidden inside UI components or unversioned database queries.

## Consequences

- Documentation must distinguish implemented behavior, planned behavior, and clinically substantiated behavior.
- One deployable application is preferred initially; this does not permit modules to share undocumented data structures.
- Every persisted or exchanged clinical dataset requires an explicit versioned schema.
- Models require separate software lifecycle states and clinical-evidence metadata. ADR-005 makes software checks, not clinical approval, the activation gate.
- The psychiatrist remains the final decision-maker. System output is an explainable draft, never an autonomous order.
- Microservices are deferred until measured operational or organizational needs justify extraction.

## Resolution Map

- official identifiers and de-identification: ADR-002 and ADR-003;
- LLM, state-machine, and MCP responsibilities: ADR-003, ADR-015, and the MCP contract;
- DDI source and activation: ADR-005 and ADR-022; permission evidence remains external;
- runtime, deployment, persistence, artifact, and audit architecture: ADR-004, ADR-006, and ADR-015 through ADR-021;
- model validation, activation, and patient-specific CPT behavior: ADR-005, ADR-006, ADR-008, and ADR-009;
- suicide-risk instrument and workflow behavior: ADR-009 through ADR-011 and ADR-022.

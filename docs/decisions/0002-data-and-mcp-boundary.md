# ADR-002: Jurisdiction, Research Data, and MCP Client Boundary

- **Status:** Accepted with external deployment prerequisite
- **Date:** 2026-08-21
- **Scope:** jurisdiction, identified research records, LLM connectivity

## Context

The initial requirements mandate an Iranian National Code while also describing legal and clinical workflows that vary across countries. The product now has no selected jurisdiction. The research-data choice permits identified records, which raises security and model-disclosure questions. The LLM has been assigned an MCP-client role, but that role alone does not define its clinical authority.

## Decision

This decision refines ADR-001's default data restriction without changing INSIGHT's research-only product stage.

### Jurisdiction-neutral core

INSIGHT will not select a governing jurisdiction at product-core level. Country-specific identifiers, laws, language, calendars, consent rules, and involuntary-treatment pathways must not be hard-coded as universal behavior.

No-jurisdiction status does not remove applicable legal obligations. Any research deployment remains responsible for the laws, ethics approval, institutional policy, and data-governance rules that apply where it operates.

ADR-021 defines one research organization/project per deployment and allows runtime egress only to the configured hosted-model endpoint.

Jurisdiction-dependent recommendations must fail closed unless a future, explicitly selected policy package supplies the applicable rules and version.

### Identified research records

INSIGHT may store identified research records, including names and an official identifier, only when a deployment has documented formal approval and has enabled the required security controls. The default development and demonstration environment continues to use synthetic data.

Identified-data capability must remain disabled until later documentation defines at least:

- lawful or ethics-approved research basis;
- participant consent or approved waiver;
- role-based access and administrator separation;
- encryption in transit and at rest;
- access, change, export, and deletion audit trails;
- retention, deletion, backup, and breach-response rules;
- restrictions on model training and external disclosure;
- environment separation between development, demonstration, and approved research use.

### LLM as MCP client

The LLM is an MCP client. It discovers and invokes narrow, typed MCP tools exposed by INSIGHT modules. MCP servers mediate access to patient, assessment, DDI, Bayesian-model, evidence, and treatment-plan capabilities.

MCP connectivity does not itself authorize the LLM to make clinical decisions, access every field, or receive direct identifiers. Tool permissions, data minimization, clinical authority, confirmation requirements, and model hosting remain separate decisions.

Every clinically relevant MCP tool contract must be versioned. Calls and results that contribute to a draft plan must be attributable and reproducible without relying solely on free-form chat history.

## Consequences

- Iranian National Code cannot remain a universal mandatory field without contradicting the jurisdiction-neutral decision.
- Involuntary-treatment logic cannot present a jurisdiction-specific legal action unless an applicable policy package is selected.
- Identified research mode needs an explicit activation gate; ordinary development mode cannot silently become identified-data mode.
- MCP servers require least-privilege tool exposure, structured schemas, authentication context, audit metadata, timeouts, and failure behavior.
- The LLM's recommendation authority and identifier boundary are resolved by ADR-003, ADR-015, ADR-022, and the implementation-facing MCP contract.

## External Deployment Prerequisite

Identity, orchestration, hosting, and model disclosure are resolved in later ADRs. Each real deployment must still document its responsible approval authority and applicable security-control baseline because the jurisdiction-neutral product cannot invent those external requirements.

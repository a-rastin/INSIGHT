# INSIGHT Product and Workflow Requirements

## Product boundary

INSIGHT is a research-only schizophrenia decision-support prototype. It is not a medical device claim, prescribing system, emergency service, longitudinal health record, or autonomous clinical decision-maker.

One deployment serves one research project. It has two roles, one Patient registry shared by all Psychiatrists, and exactly one Research Case per Patient.

## Role experiences

### Administrator

Administrator navigation contains:

- Users
- Model Endpoint
- Medication and Comorbidity Knowledge
- DDI Sources
- Adverse-Effect Catalog
- BN Manager
- Operational Audit
- Backup and Restore

It never exposes Patient search, Patient names/identifiers, Research Cases, assessments, medications, plans, or clinical audit payloads.

Every installation starts with enabled `admin/admin`. No forced change occurs. Administrators create users, change usernames/passwords, disable accounts, issue temporary passwords, and revoke sessions.

### Model Endpoint

The page accepts an OpenAI-compatible API base URL, model identifier, and API key. The API key is write-only: after save, the UI shows only whether a credential is configured and offers Replace or Clear. It never displays a masked secret that could be reversed.

Save starts a server-side compatibility check and does not activate the configuration immediately. The UI shows `PENDING`, `CHECKING`, `COMPATIBLE`, or `INCOMPATIBLE`, the last check time, normalized non-secret endpoint identity, model, and a safe failure category. It provides a Retry Check action. AI-dependent workflows remain disabled unless the current configuration fingerprint is `COMPATIBLE`; replacing the URL, model, or credential returns it to `PENDING`.

Helper text defines the field as the API root, including any provider path such as `/v1`; users must not paste the final `/chat/completions` path. The backend preserves the supplied path and appends only `chat/completions`.

### Psychiatrist

Psychiatrist navigation contains:

- Patient Registry
- Create Patient
- the selected Patient's Research Case workflow
- Final Plan version history
- authorized clinical audit history

Every Psychiatrist can access and modify every Patient. Creator identity is attribution only.

## Patient Registry

### Create/search fields

- first name, required;
- last name, required;
- date of birth, required;
- sex, required and limited to Male/Female;
- official identifier type, issuer, and value, required.

The profile calculates age against today. Research Case artifacts calculate age against `ResearchCase.startedAt`.

The normalized official identifier is unique. If it already exists, INSIGHT opens the existing Patient and automatically overwrites any submitted first name, last name, birth date, or sex difference without confirmation.

### Permanent delete

Any Psychiatrist can activate Delete on any Patient. It executes immediately without confirmation, password re-entry, delay, or second approval. Primary records and non-audit artifacts are removed; complete clinical audit history remains.

## Single Research Case workflow

The UI uses one stepper backed by the persisted backend state machine:

1. Patient demographics
2. DSM-5-TR schizophrenia criteria
3. PANSS
4. C-SSRS suicide-risk screen
5. Medical history
6. Current medications and normalization
7. AI/BN processing
8. DDI and Primary Treatment Plan
9. Psychiatrist review and final recheck
10. Final Treatment Plan

There is no New Visit, Encounter list, or second Research Case action.

## Assessment screens

### Shared behavior

- Structured answers autosave as mutable Research Case data.
- Deterministic results update immediately as answers change.
- Each assessment offers Bypass with no reason field.
- Bypass after partial completion deletes all partial answers.
- A bypassed assessment remains visibly `BYPASSED`; it is not displayed as normal, negative, or zero.
- The LLM later imputes hidden answers/scores for computation.

### DSM-5-TR

- Display the governed schizophrenia diagnostic criteria and structured selectable responses.
- Calculate the deterministic criteria result locally.
- Bypass represents the Psychiatrist's certainty and requires no explanation.

Exact criterion wording and calculation require a governed source artifact before Packet 3 implementation.

### PANSS

- Display every governed PANSS item and permitted response value.
- Calculate total/subscale outputs deterministically.
- Permit unrestricted bypass.

Exact PANSS source/version, permission, wording, and scoring must be governed before Packet 3 implementation.

### C-SSRS Screen Version - Recent

- Ask questions 1 and 2.
- If question 2 is Yes, ask 3, 4, 5, and 6.
- If question 2 is No, skip directly to 6.
- If question 6 is Yes, ask whether behavior occurred within the past three months.
- Show the derived text band, not color alone.
- Permit bypass and the warning-only result behavior selected in ADR-010.

The complete transcription and source gaps are in the C-SSRS audit.

## Medical history

The Psychiatrist must choose:

- `FIRST_PRESENTATION`; or
- `KNOWN_SCHIZOPHRENIA`.

For First Presentation, previous-treatment inputs are hidden. For Known Schizophrenia, ask whether the Patient was treated previously. If Yes, require at least one antipsychotic trial; only medication is mandatory in that trial.

Optional trial fields are dose, period, response, adverse effects, discontinuation reason, and notes. Response values are Full, Partial, None, Worsened, and Unknown. Adverse effects are multi-select from the pinned catalog plus `OTHER`; detail is optional.

Comorbidities are multi-select from the governed catalog. Supplemental free text is allowed but deterministic rules apply only to structured selections.

## Current medications and normalization

The Psychiatrist enters one or more medication strings and optional regimen details. A durable LLM job:

1. receives the bounded medication projection;
2. searches the canonical catalog through MCP;
3. chooses and commits one returned identity or `UNKNOWN`;
4. proceeds without Psychiatrist confirmation.

If any entry is `UNKNOWN`, the DDI page shows one small generic warning. It does not identify the medicine or enumerate omitted pairs, and it is absent from plan screens and exports.

## AI, Bayesian, and DDI processing

The UI shows durable-job progress but not hidden chain-of-thought or raw secrets.

- Bypassed assessments are imputed first.
- Backend routing selects BN pathways.
- The LLM generates every CPT.
- Invalid CPT output receives at most two retries after the first attempt.
- Accepted snapshot inference is deterministic and does not clamp evidence nodes.
- DDI checks use normalized current/proposed medicines and omit `UNKNOWN` pairs.

Failures display a typed safe message and a user-controlled rerun action. Required failure blocks finalization. A successful DDI finding never blocks finalization.

## Primary Treatment Plan

The plan is a structured object with:

- medication;
- dose/unit;
- route;
- frequency;
- titration;
- monitoring;
- rationale;
- warnings;
- source and execution provenance.

Automatic generation excludes every candidate medicine with any detected DDI. The page shows one generic AI-imputation notice when imputation was used, but never shows the imputed answers, scores, classification, or reasoning.

## Psychiatrist review

The Psychiatrist may change or add any medication, including one excluded for a severe or contraindicated interaction. No acknowledgement, reason, or override rationale is required.

Any medication change triggers a complete final-regimen DDI job. Findings are displayed as warnings only. Unknown pairs remain unchecked. A failed DDI job blocks finalization; a successful job with findings does not.

## Final Treatment Plan

Finalization creates an immutable structured version. The final/exported plan:

- pins the exact final regimen and computation provenance;
- omits the generic AI-imputation notice;
- can contain any DDI finding;
- can coexist with completed high C-SSRS risk;
- cannot be edited in place.

A later plan version may supersede it inside the same Research Case. Supersession needs no reason. All old versions remain readable until the Patient is hard-deleted.

## Loading, empty, and failure states

Every data page must define:

- loading state;
- empty state;
- validation state;
- unauthorized state;
- dependency unavailable state;
- durable job queued/running/failed/succeeded state;
- stale-input state requiring a new execution.

No page may imply clinical success because a request returned HTTP 200; accepted domain status and provenance are required.

## Accessibility and desktop behavior

- Desktop-first layout with supported narrower widths, not mobile-first workflows.
- Never communicate C-SSRS or DDI severity by color alone.
- Keyboard-accessible controls and visible focus.
- Semantic labels for assessment inputs.
- Long jobs survive refresh and resume through SSE identifiers.
- Sensitive identifiers remain masked unless needed for disambiguation.

## Explicitly out of scope

- multiple organizations in one deployment;
- multiple Research Cases, visits, or Encounters;
- Administrator access to Patient content;
- MFA, SSO, public signup, or email recovery;
- mobile-first use;
- microservices, Redis, or object storage;
- live medical-source scraping;
- automated backups or artifact backups;
- autonomous plan finalization;
- clinical approval gates for structurally passing BN models;
- hard safety blocks for DDI findings or suicide-risk results.

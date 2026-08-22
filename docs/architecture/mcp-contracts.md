# INSIGHT MCP Contract

## OpenAI-compatible transport profile

INSIGHT supports any Administrator-configured endpoint that implements the following OpenAI Chat Completions subset. Provider branding or a successful text-only request is not sufficient compatibility.

The Administrator supplies a base URL, model identifier, and write-only API key. The backend:

- requires an absolute HTTPS base URL, except loopback HTTP in an explicit development mode;
- rejects embedded credentials, query strings, fragments, and a URL ending in `/chat/completions`;
- removes surrounding whitespace and trailing slashes, preserves every provider path segment, and resolves `chat/completions` relative to that root;
- never inserts, removes, or duplicates `/v1`; the Administrator-provided root is authoritative;
- sends the API key only as `Authorization: Bearer <key>` and sends JSON request bodies;
- uses Node's native HTTP client rather than provider-specific SDK behavior or headers.

For example, `https://model.example/v1` resolves to `https://model.example/v1/chat/completions`, while `https://model.example/openai/v1/` resolves to `https://model.example/openai/v1/chat/completions`.

Production requests use the smallest interoperable payload: `model`, `messages`, `tools`, and `tool_choice` when a tool must be forced. INSIGHT does not require `response_format`, streaming, parallel tool calls, `strict`, `seed`, service tiers, or provider-specific request fields. Authoritative structured output is carried in tool-call arguments. Before execution, the backend checks every argument and nested value against the complete runtime input schema used by the MCP Gateway. Provider-side schema enforcement is never trusted.

The response decoder accepts standard JSON-encoded function arguments and may tolerate an already-decoded JSON object. It requires a tool-call identifier and function name, validates every argument locally, returns tool results with the matching `tool_call_id`, and preserves the assistant tool-call message in the next request. Text claiming that a tool succeeded has no authority.

### Activation probe

A new or changed endpoint configuration remains inactive until a server-side probe succeeds using its exact base URL, model, and credential. The probe contains no Patient data and must verify:

1. authenticated Chat Completions access;
2. one forced function call with a randomized nonce and production-shaped JSON Schema;
3. valid function arguments and tool-call identifier handling;
4. a second request containing the assistant tool call and matching tool result;
5. one forced completion tool whose arguments pass the complete local runtime schema and contain the same nonce;
6. capture of requested and returned model metadata when available.

The backend stores the normalized non-secret endpoint identity, model, capability-test version, configuration fingerprint, result, timestamp, and sanitized diagnostic. It never stores probe messages containing the API key and never returns or logs the credential. Changing the base URL, model, API key, or compatibility-test version returns the configuration to `PENDING` and disables AI jobs until a new probe passes.

HTTP `408`, `429`, `5xx`, network failures, and timeouts are retryable only within the bounded job policy. Authentication failures, unsupported paths or fields, malformed JSON, absent tool calls, invalid arguments, and broken tool-result round trips are non-retryable compatibility failures. Runtime failure never changes endpoint, model, path, credential, or request dialect automatically.

Required automated coverage includes URL resolution with nested roots and trailing slashes; Bearer authentication; the complete two-request tool round trip; string and object argument decoding; secret redaction; timeout and malformed-response handling; `401`, `404`, `429`, and `5xx` mapping; configuration invalidation after rotation; and one synthetic MCP workflow through the activated Administrator configuration. CI uses local mock servers; the Administrator probe tests the real configured endpoint.

## Non-negotiable boundary

The hosted LLM is the logical MCP client. The server-side agent runtime is the only physical executor. It provides state-allowed tool schemas to the model, receives structured calls, injects trusted context, invokes one internal MCP Gateway, filters the result, and returns it to the model.

The model cannot:

- connect to PostgreSQL or the artifact volume;
- choose a Patient, Research Case, user, tenant, endpoint, knowledge version, or BN outside trusted backend context;
- supply its own authorization role or workflow state;
- request arbitrary record fields;
- call finalization, deletion, user administration, model activation, backup, or restore tools;
- bypass a tool error by claiming a successful result in text.

## Gateway namespaces

| Namespace | Owning module | Purpose |
|---|---|---|
| `research_case.*` | Patient orchestration | Read a bounded de-identified projection for the current state |
| `assessment.*` | Assessment | Submit schema-valid AI imputations for bypassed assessments |
| `medication.*` | Medication terminology | Search the canonical catalog and commit LLM-selected mappings |
| `ddi.*` | DDI | Evaluate exact normalized regimens against the pinned source |
| `bn.*` | Bayesian | Obtain routed generation contracts, validate CPTs, and run inference |
| `treatment_plan.*` | Treatment Plan | Validate and persist the LLM's structured Primary Plan draft |

One gateway serves all namespaces in-process. Namespace separation is a code and ownership boundary, not a network or deployment boundary.

## Trusted execution envelope

The backend injects this envelope; the model cannot set or modify it:

```ts
type TrustedToolContext = {
  executionId: string;
  jobId: string;
  subjectRef: string; // ephemeral, not Patient or Research Case UUID
  researchCaseRevision: number;
  workflowState: WorkflowState;
  actorRole: "PSYCHIATRIST";
  allowedToolNames: string[];
  idempotencyKey: string;
};
```

Every tool response uses a common result shape:

```ts
type ToolResult<T> =
  | {
      ok: true;
      data: T;
      provenance: {
        toolName: string;
        toolVersion: string;
        inputHash: string;
        outputHash: string;
        knowledgeVersions: string[];
        executedAt: string;
      };
      warnings: ToolWarning[];
    }
  | {
      ok: false;
      error: {
        code: ToolErrorCode;
        retryable: boolean;
        safeMessage: string;
        diagnostics?: unknown;
      };
    };
```

Raw exceptions, SQL details, absolute paths, credentials, internal UUIDs, names, and official identifiers never appear in a model-visible result.

## Model-callable tools

### `research_case.get_context`

Returns the projection fixed by the current workflow state. The model cannot request arbitrary fields.

```ts
type GetContextInput = Record<string, never>;

type GetContextOutput = {
  subjectRef: string;
  projectionType:
    | "MEDICATION_NORMALIZATION"
    | "ASSESSMENT_IMPUTATION"
    | "CPT_GENERATION"
    | "PLAN_DRAFT";
  projectionVersion: string;
  data: unknown;
  omittedFieldClasses: string[];
};
```

Projection examples:

- medication normalization: raw medication strings and local entry references only;
- assessment imputation: calculated age, binary sex, presentation status, completed/bypassed assessment states, medical history, comorbidities, current and previous medicines;
- CPT generation: the complete de-identified Research Case context plus accepted AI imputations;
- plan draft: structured inputs, BN outputs, DDI findings, omissions, warnings, and provenance references.

### `medication.search_candidates`

Searches the pinned canonical medication catalog.

```ts
type SearchCandidatesInput = {
  medicationEntryRef: string;
  query: string;
};

type SearchCandidatesOutput = {
  catalogVersion: string;
  candidates: Array<{
    canonicalId: string;
    preferredName: string;
    synonyms: string[];
  }>;
};
```

No confidence threshold has authority. The LLM chooses a candidate or `UNKNOWN`.

### `medication.commit_mapping`

Persists the model's selection without Psychiatrist confirmation.

```ts
type CommitMappingInput = {
  medicationEntryRef: string;
  catalogVersion: string;
  selectedCanonicalId: string | null; // null means UNKNOWN
};

type CommitMappingOutput = {
  normalizationState: "NORMALIZED" | "UNKNOWN";
  canonicalId?: string;
  preferredName?: string;
};
```

The backend requires the selection to be one of the returned candidates. If there is no usable candidate, `UNKNOWN` is accepted and the workflow continues.

### `assessment.submit_imputation`

Submits synthetic answers and results for every assessment currently `BYPASSED`.

```ts
type SubmitImputationInput = {
  imputations: Array<{
    assessmentType: "DSM5TR" | "PANSS" | "CSSRS_RECENT";
    instrumentVersion: string;
    generatedAnswers: unknown;
    generatedScores: unknown;
    generatedClassification: string;
  }>;
};

type SubmitImputationOutput = {
  imputationSnapshotRef: string;
  dependencyFingerprint: string;
  acceptedAssessmentTypes: string[];
};
```

This tool validates schema completeness and provenance. It does not convert the official assessment from `BYPASSED` to `COMPLETED`. Imputed C-SSRS high risk creates no direct alert.

### `ddi.evaluate_regimen`

Runs deterministic pair evaluation for an exact regimen.

```ts
type EvaluateRegimenInput = {
  purpose: "PRIMARY_FILTER" | "FINAL_RECHECK";
  medicationEntryRefs: string[];
};

type EvaluateRegimenOutput = {
  executionRef: string;
  sourceVersion: string;
  evaluatedCanonicalIds: string[];
  unknownMedicationEntryRefs: string[];
  omittedPairCount: number;
  findings: Array<{
    leftCanonicalId: string;
    rightCanonicalId: string;
    severity: string;
    mechanism?: string;
    clinicalEffect?: string;
    recommendedAction?: string;
    sourceRecordRef: string;
  }>;
};
```

For `PRIMARY_FILTER`, every drug participating in any finding is unavailable to automatic plan generation. For `FINAL_RECHECK`, every finding is warning-only. An `UNKNOWN` medicine is omitted from pairs and does not fail the execution. Missing/disabled source, timeout, or invalid provenance fails the tool and blocks finalization.

### `bn.get_routed_contracts`

Returns only models selected by the deterministic backend routing artifact.

```ts
type GetRoutedContractsInput = Record<string, never>;

type BnGenerationContract = {
  routeRuleRef: string;
  modelRef: string;
  modelVersion: string;
  modelHash: string;
  nodes: Array<{
    nodeRef: string;
    outcomes: string[];
    orderedParentRefs: string[];
    requiredTableLength: number;
  }>;
};
```

Base-model numerical CPT values are not returned as authoritative patient tables. Topology, outcomes, parent order, and dimensions are authoritative.

### `bn.submit_cpt_snapshot`

Validates the LLM-generated complete CPT set.

```ts
type SubmitCptSnapshotInput = {
  modelRef: string;
  tables: Array<{
    nodeRef: string;
    probabilities: number[];
  }>;
};

type SubmitCptSnapshotOutput = {
  status: "ACCEPTED";
  snapshotRef: string;
  snapshotHash: string;
};
```

On invalid output, the tool returns `CPT_VALIDATION_FAILED` with per-node dimension, missing-value, finiteness, negativity, and row-normalization diagnostics. The agent may retry no more than twice after the first attempt. The backend does not clip, repair, fill, or normalize an invalid table.

### `bn.run_inference`

Runs deterministic inference over an accepted snapshot.

```ts
type RunInferenceInput = {
  snapshotRef: string;
  requestedOutputNodeRefs: string[];
};

type RunInferenceOutput = {
  inferenceRef: string;
  snapshotRef: string;
  distributions: Array<{
    nodeRef: string;
    outcomes: Array<{ outcome: string; probability: number }>;
  }>;
};
```

No Patient fact is entered as evidence and no node is clamped. A snapshot belongs to the one Research Case and can be reused only while its dependency fingerprint remains unchanged.

### `treatment_plan.submit_primary`

Validates and persists the structured plan returned by the model.

```ts
type SubmitPrimaryPlanInput = {
  schemaVersion: string;
  regimen: Array<{
    canonicalMedicationId: string;
    dose: { value: number; unit: string };
    route: string;
    frequency: string;
    titration?: string;
    monitoring: string[];
    rationale: Array<{ kind: string; sourceRef: string; text: string }>;
    warningRefs: string[];
  }>;
  generalMonitoring: string[];
  explanation: string;
  sourceExecutionRefs: string[];
};

type SubmitPrimaryPlanOutput = {
  draftRef: string;
  draftRevision: number;
  aiImputationNoticeVisible: boolean;
};
```

The tool rejects medication identities absent from normalized candidate inputs, drugs excluded by the Primary DDI filter, missing required fields, nonexistent provenance references, and unsupported schema versions. It never creates a Final Treatment Plan.

## Backend-only commands

The following operations are never presented to the model as tools:

- create/update/delete Patient;
- reveal or normalize official identifiers;
- create/disable/reset users;
- authenticate, revoke sessions, or assign roles;
- activate/retire knowledge or BN versions;
- configure model endpoint credentials;
- create/restore backups;
- change workflow state directly;
- approve clinician edits;
- finalize or supersede a plan;
- hard-delete a Patient;
- read clinical audit history.

## State allowlist

| Workflow state | Model-callable tools |
|---|---|
| `DATA_COLLECTION` | none |
| `NORMALIZING_MEDICATIONS` | `research_case.get_context`, `medication.search_candidates`, `medication.commit_mapping` |
| `IMPUTING_BYPASSED_ASSESSMENTS` | `research_case.get_context`, `assessment.submit_imputation` |
| `ROUTING_BN` | none; backend routing only |
| `GENERATING_CPTS` | `research_case.get_context`, `bn.get_routed_contracts`, `bn.submit_cpt_snapshot` |
| `RUNNING_BN` | `bn.run_inference` |
| `CHECKING_PRIMARY_DDI` | `ddi.evaluate_regimen` |
| `GENERATING_PRIMARY_PLAN` | `research_case.get_context`, `treatment_plan.submit_primary` |
| `CLINICIAN_REVIEW` | none |
| `RECHECKING_FINAL_DDI` | `ddi.evaluate_regimen` |
| `READY_TO_FINALIZE` | none |
| `FINALIZED` | none |
| `DELETED` | none |

Calls outside the allowlist fail with `TOOL_NOT_ALLOWED_IN_STATE` and are not sent to a domain module.

## Error codes

| Code | Retryable | Workflow effect |
|---|---:|---|
| `TOOL_NOT_ALLOWED_IN_STATE` | No | agent execution fails |
| `STALE_RESEARCH_CASE_REVISION` | No | cancel job; user starts a new execution |
| `INVALID_TOOL_INPUT` | No | agent may correct within its remaining turn budget |
| `DEPENDENCY_UNAVAILABLE` | Yes, bounded | fail closed after job retries |
| `KNOWLEDGE_VERSION_INACTIVE` | No | block dependent workflow |
| `MEDICATION_CANDIDATE_INVALID` | No | model must select returned candidate or `UNKNOWN` |
| `DDI_SOURCE_DISABLED` | No | block finalization |
| `CPT_VALIDATION_FAILED` | Yes, max two diagnostic retries | block BN and finalization after third invalid attempt |
| `CPT_SNAPSHOT_STALE` | No | create new imputation/CPT execution |
| `PLAN_SCHEMA_INVALID` | Yes, bounded within job | no clinician draft until valid |
| `PROVENANCE_MISMATCH` | No | block finalization |
| `MODEL_ENDPOINT_FAILED` | Yes, bounded | fail closed; no endpoint fallback |

## Required provenance

Every successful tool call records:

- tool name and semantic version;
- trusted execution/job/Research Case references;
- de-identified input hash and output hash;
- module and knowledge versions;
- endpoint/model metadata when the LLM contributed;
- prompt and schema versions;
- timestamps, attempt number, and initiating Psychiatrist;
- immutable result references used by downstream computations.

Free-form conversation text is never sufficient provenance and never becomes an authoritative clinical field.

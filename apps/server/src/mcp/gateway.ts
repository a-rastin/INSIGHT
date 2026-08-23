import { createHash } from "node:crypto";

import {
  CssrsAnswersSchema,
  CssrsCalculationSchema,
  Dsm5trAnswersSchema,
  Dsm5trCalculationSchema,
  PanssAnswersSchema,
  PanssCalculationSchema,
  stableSerialize,
  type JsonValue,
} from "@insight/contracts";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TrustedToolContext } from "../deidentification/gateway.js";
import { MODEL_VISIBLE_PROJECTION_SCHEMA } from "../deidentification/projections.js";
import { MODEL_TOOLS_BY_STATE, WORKFLOW_STATES } from "../patient/workflow.js";

export const TOOL_ERROR_CODES = [
  "TOOL_NOT_ALLOWED_IN_STATE",
  "STALE_RESEARCH_CASE_REVISION",
  "INVALID_TOOL_INPUT",
  "DEPENDENCY_UNAVAILABLE",
  "KNOWLEDGE_VERSION_INACTIVE",
  "MEDICATION_CANDIDATE_INVALID",
  "DDI_SOURCE_DISABLED",
  "CPT_VALIDATION_FAILED",
  "CPT_SNAPSHOT_STALE",
  "PLAN_SCHEMA_INVALID",
  "PROVENANCE_MISMATCH",
  "MODEL_ENDPOINT_FAILED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolWarning {
  readonly code: string;
  readonly safeMessage: string;
}

export type ToolResult<T extends JsonValue = JsonValue> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly provenance: {
        readonly toolName: ToolName;
        readonly toolVersion: string;
        readonly inputHash: string;
        readonly outputHash: string;
        readonly knowledgeVersions: readonly string[];
        readonly executedAt: string;
      };
      readonly warnings: readonly ToolWarning[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ToolErrorCode;
        readonly retryable: boolean;
        readonly safeMessage: string;
        readonly diagnostics?: JsonValue;
      };
    };

const ref = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._:-]{0,199}$" });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const shortText = Type.String({ minLength: 1, maxLength: 500 });
const emptyInput = (id: string) => Type.Object({}, { $id: id, additionalProperties: false });

const assessmentImputation = (assessmentType: string, answers: TSchema, scores: TSchema) =>
  Type.Object(
    {
      assessmentType: Type.Literal(assessmentType),
      instrumentVersion: ref,
      generatedAnswers: answers,
      generatedScores: scores,
      generatedClassification: shortText,
    },
    { additionalProperties: false },
  );

const TOOL_DEFINITIONS = {
  "research_case.get_context": {
    version: "1.0.0",
    description: "Return the state-fixed de-identified Research Case projection.",
    inputSchema: emptyInput("insight.mcp.research-case-get-context-input.v1"),
    outputSchema: MODEL_VISIBLE_PROJECTION_SCHEMA,
  },
  "assessment.submit_imputation": {
    version: "1.0.0",
    description: "Submit complete synthetic values for currently bypassed assessments.",
    inputSchema: Type.Object(
      {
        imputations: Type.Array(
          Type.Union([
            assessmentImputation("DSM5TR", Dsm5trAnswersSchema, Dsm5trCalculationSchema),
            assessmentImputation("PANSS", PanssAnswersSchema, PanssCalculationSchema),
            assessmentImputation("CSSRS_RECENT", CssrsAnswersSchema, CssrsCalculationSchema),
          ]),
          { minItems: 1, maxItems: 3 },
        ),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        imputationSnapshotRef: ref,
        dependencyFingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        acceptedAssessmentTypes: Type.Array(
          Type.Union(
            ["DSM5TR", "PANSS", "CSSRS_RECENT"].map((value) => Type.Literal(value)),
          ),
          { minItems: 1, maxItems: 3, uniqueItems: true },
        ),
      },
      { additionalProperties: false },
    ),
  },
  "medication.search_candidates": {
    version: "1.0.0",
    description: "Search the pinned canonical medication catalog.",
    inputSchema: Type.Object(
      { medicationEntryRef: ref, query: Type.String({ minLength: 1, maxLength: 200 }) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        catalogVersion: ref,
        candidates: Type.Array(
          Type.Object(
            {
              canonicalId: ref,
              preferredName: shortText,
              synonyms: Type.Array(shortText, { maxItems: 100 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  "medication.commit_mapping": {
    version: "1.0.0",
    description: "Commit one candidate returned by the pinned catalog or UNKNOWN.",
    inputSchema: Type.Object(
      {
        medicationEntryRef: ref,
        catalogVersion: ref,
        selectedCanonicalId: Type.Union([ref, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Union([
      Type.Object(
        { normalizationState: Type.Literal("UNKNOWN") },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          normalizationState: Type.Literal("NORMALIZED"),
          canonicalId: ref,
          preferredName: shortText,
        },
        { additionalProperties: false },
      ),
    ]),
  },
  "ddi.evaluate_regimen": {
    version: "1.0.0",
    description: "Evaluate an exact normalized regimen against the pinned DDI source.",
    inputSchema: Type.Object(
      {
        purpose: Type.Union([Type.Literal("PRIMARY_FILTER"), Type.Literal("FINAL_RECHECK")]),
        medicationEntryRefs: Type.Array(ref, { minItems: 1, maxItems: 200, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        executionRef: ref,
        sourceVersion: ref,
        evaluatedCanonicalIds: Type.Array(ref, { maxItems: 200, uniqueItems: true }),
        unknownMedicationEntryRefs: Type.Array(ref, { maxItems: 200, uniqueItems: true }),
        omittedPairCount: Type.Integer({ minimum: 0 }),
        findings: Type.Array(
          Type.Object(
            {
              leftCanonicalId: ref,
              rightCanonicalId: ref,
              severity: shortText,
              mechanism: Type.Optional(text),
              clinicalEffect: Type.Optional(text),
              recommendedAction: Type.Optional(text),
              sourceRecordRef: ref,
            },
            { additionalProperties: false },
          ),
          { maxItems: 20_000 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  "bn.get_routed_contracts": {
    version: "1.0.0",
    description: "Return only deterministically routed Bayesian generation contracts.",
    inputSchema: emptyInput("insight.mcp-bn-get-routed-contracts-input.v1"),
    outputSchema: Type.Array(
      Type.Object(
        {
          routeRuleRef: ref,
          modelRef: ref,
          modelVersion: ref,
          modelHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          nodes: Type.Array(
            Type.Object(
              {
                nodeRef: ref,
                outcomes: Type.Array(shortText, { minItems: 2, maxItems: 100, uniqueItems: true }),
                orderedParentRefs: Type.Array(ref, { maxItems: 100, uniqueItems: true }),
                requiredTableLength: Type.Integer({ minimum: 2 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 10_000 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  "bn.submit_cpt_snapshot": {
    version: "1.0.0",
    description: "Validate and persist one complete generated CPT set.",
    inputSchema: Type.Object(
      {
        modelRef: ref,
        tables: Type.Array(
          Type.Object(
            {
              nodeRef: ref,
              probabilities: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
                minItems: 2,
                maxItems: 1_000_000,
              }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 10_000 },
        ),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        status: Type.Literal("ACCEPTED"),
        snapshotRef: ref,
        snapshotHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      },
      { additionalProperties: false },
    ),
  },
  "bn.run_inference": {
    version: "1.0.0",
    description: "Run deterministic inference over an accepted current snapshot.",
    inputSchema: Type.Object(
      {
        snapshotRef: ref,
        requestedOutputNodeRefs: Type.Array(ref, {
          minItems: 1,
          maxItems: 10_000,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        inferenceRef: ref,
        snapshotRef: ref,
        distributions: Type.Array(
          Type.Object(
            {
              nodeRef: ref,
              outcomes: Type.Array(
                Type.Object(
                  { outcome: shortText, probability: Type.Number({ minimum: 0, maximum: 1 }) },
                  { additionalProperties: false },
                ),
                { minItems: 2, maxItems: 100 },
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 10_000 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  "treatment_plan.submit_primary": {
    version: "1.0.0",
    description: "Validate and persist a structured Primary Treatment Plan draft.",
    inputSchema: Type.Object(
      {
        schemaVersion: ref,
        regimen: Type.Array(
          Type.Object(
            {
              canonicalMedicationId: ref,
              dose: Type.Object(
                { value: Type.Number({ exclusiveMinimum: 0 }), unit: shortText },
                { additionalProperties: false },
              ),
              route: shortText,
              frequency: shortText,
              titration: Type.Optional(text),
              monitoring: Type.Array(text, { maxItems: 100 }),
              rationale: Type.Array(
                Type.Object(
                  { kind: ref, sourceRef: ref, text },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 100 },
              ),
              warningRefs: Type.Array(ref, { maxItems: 100, uniqueItems: true }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 100 },
        ),
        generalMonitoring: Type.Array(text, { maxItems: 100 }),
        explanation: text,
        sourceExecutionRefs: Type.Array(ref, { minItems: 1, maxItems: 100, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        draftRef: ref,
        draftRevision: Type.Integer({ minimum: 1 }),
        aiImputationNoticeVisible: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;
export const MODEL_TOOL_NAMES = Object.freeze(Object.keys(TOOL_DEFINITIONS) as ToolName[]);

export interface ToolHandlerSuccess {
  readonly data: JsonValue;
  readonly knowledgeVersions?: readonly string[];
  readonly warnings?: readonly ToolWarning[];
  readonly sensitiveValues?: readonly string[];
}

export type ToolHandler = (
  context: TrustedToolContext,
  input: JsonValue,
) => Promise<ToolHandlerSuccess> | ToolHandlerSuccess;

export type ToolHandlers = Partial<Readonly<Record<ToolName, ToolHandler>>>;

const RETRYABLE: Readonly<Record<ToolErrorCode, boolean>> = Object.freeze({
  TOOL_NOT_ALLOWED_IN_STATE: false,
  STALE_RESEARCH_CASE_REVISION: false,
  INVALID_TOOL_INPUT: false,
  DEPENDENCY_UNAVAILABLE: true,
  KNOWLEDGE_VERSION_INACTIVE: false,
  MEDICATION_CANDIDATE_INVALID: false,
  DDI_SOURCE_DISABLED: false,
  CPT_VALIDATION_FAILED: true,
  CPT_SNAPSHOT_STALE: false,
  PLAN_SCHEMA_INVALID: true,
  PROVENANCE_MISMATCH: false,
  MODEL_ENDPOINT_FAILED: true,
});

const SAFE_MESSAGES: Readonly<Record<ToolErrorCode, string>> = Object.freeze({
  TOOL_NOT_ALLOWED_IN_STATE: "Tool is not allowed in the current state.",
  STALE_RESEARCH_CASE_REVISION: "Research Case context is stale.",
  INVALID_TOOL_INPUT: "Tool input is invalid.",
  DEPENDENCY_UNAVAILABLE: "A required dependency is unavailable.",
  KNOWLEDGE_VERSION_INACTIVE: "Required knowledge version is inactive.",
  MEDICATION_CANDIDATE_INVALID: "Medication selection is not a returned candidate.",
  DDI_SOURCE_DISABLED: "DDI source is disabled.",
  CPT_VALIDATION_FAILED: "Generated CPT values are invalid.",
  CPT_SNAPSHOT_STALE: "CPT snapshot is stale.",
  PLAN_SCHEMA_INVALID: "Primary plan is invalid.",
  PROVENANCE_MISMATCH: "Tool provenance is invalid.",
  MODEL_ENDPOINT_FAILED: "Model endpoint failed.",
});

const TRUSTED_INPUT_KEYS =
  /^(?:execution(?:Id)?|job(?:Id)?|subject(?:Ref)?|researchCaseRevision|revision|workflowState|state|actorRole|role|allowedToolNames|allowlist|idempotency(?:Key)?)$/i;
const FORBIDDEN_INPUT_KEYS = /^(?:sql|queryText|path|filePath|record|records|command)$/i;
const SQL = /\b(?:select|insert|update|delete|drop|alter|truncate|grant|revoke)\b[\s\S]*\b(?:from|into|table|set|on)\b/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const SECRET = /\b(?:bearer\s+\S+|password|credential|api[_ -]?key|private[_ -]?key)\b/i;

function failure(code: ToolErrorCode, diagnostics?: JsonValue): ToolResult<never> {
  return {
    ok: false,
    error: {
      code,
      retryable: RETRYABLE[code],
      safeMessage: SAFE_MESSAGES[code],
      ...(diagnostics === undefined ? {} : { diagnostics }),
    },
  };
}

function hash(value: JsonValue): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasProhibitedModelInput(value: unknown): boolean {
  if (typeof value === "string") return ABSOLUTE_PATH.test(value) || SQL.test(value);
  if (Array.isArray(value)) return value.some(hasProhibitedModelInput);
  if (!isPlainRecord(value)) return value !== null && typeof value === "object";
  return Object.entries(value).some(
    ([key, child]) =>
      TRUSTED_INPUT_KEYS.test(key) ||
      FORBIDDEN_INPUT_KEYS.test(key) ||
      hasProhibitedModelInput(child),
  );
}

function isSafeVisible(value: unknown, sensitiveValues: readonly string[]): value is JsonValue {
  const forbidden = sensitiveValues
    .map((entry) => entry.normalize("NFKC").trim().toLocaleLowerCase("en-US"))
    .filter((entry) => entry.length > 1);
  const visit = (entry: unknown): boolean => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") {
      return typeof entry !== "number" || Number.isFinite(entry);
    }
    if (typeof entry === "string") {
      if (UUID.test(entry) || SECRET.test(entry) || ABSOLUTE_PATH.test(entry) || SQL.test(entry)) return false;
      const folded = entry.normalize("NFKC").trim().toLocaleLowerCase("en-US");
      return entry.length <= 4000 && !forbidden.some((value) => folded.includes(value));
    }
    if (Array.isArray(entry)) return entry.every((item) => visit(item));
    if (!isPlainRecord(entry)) return false;
    return Object.entries(entry).every(
      ([childKey, child]) =>
        !/(?:patient|research.?case|user|actor|official|identifier|credential|secret|sql|path)/i.test(
          childKey,
        ) && visit(child),
    );
  };
  return visit(value);
}

function collectVersions(value: JsonValue, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectVersions(entry, output));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      if (typeof entry === "string" && /version$/i.test(key)) output.add(`${key}:${entry}`);
      else collectVersions(entry, output);
    });
  }
  return output;
}

function safeDiagnostics(value: JsonValue | undefined): JsonValue | undefined {
  return value !== undefined && isSafeVisible(value, []) ? value : undefined;
}

export class McpToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    readonly diagnostics?: JsonValue,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "McpToolError";
  }
}

export interface ModelToolDefinition {
  readonly name: ToolName;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: TSchema;
}

export class InternalMcpGateway {
  constructor(
    private readonly handlers: ToolHandlers,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listTools(context: TrustedToolContext): readonly ModelToolDefinition[] {
    if (!this.isTrustedContextValid(context)) return [];
    const stateTools = MODEL_TOOLS_BY_STATE[context.workflowState];
    return MODEL_TOOL_NAMES.filter(
      (name) => stateTools.includes(name) && context.allowedToolNames.includes(name),
    ).map((name) => ({
      name,
      version: TOOL_DEFINITIONS[name].version,
      description: TOOL_DEFINITIONS[name].description,
      inputSchema: TOOL_DEFINITIONS[name].inputSchema,
    }));
  }

  async invoke(context: TrustedToolContext, request: unknown): Promise<ToolResult> {
    if (!isPlainRecord(request) || Object.keys(request).some((key) => !["name", "input"].includes(key))) {
      return failure("INVALID_TOOL_INPUT");
    }
    const name = request.name;
    if (typeof name !== "string" || !MODEL_TOOL_NAMES.includes(name as ToolName)) {
      return failure("TOOL_NOT_ALLOWED_IN_STATE");
    }
    if (!this.isToolAllowed(context, name as ToolName)) {
      return failure("TOOL_NOT_ALLOWED_IN_STATE");
    }
    const definition = TOOL_DEFINITIONS[name as ToolName];
    if (hasProhibitedModelInput(request.input) || !Value.Check(definition.inputSchema, request.input)) {
      return failure("INVALID_TOOL_INPUT");
    }
    const handler = this.handlers[name as ToolName];
    if (!handler) return failure("DEPENDENCY_UNAVAILABLE");

    try {
      const input = request.input as JsonValue;
      const outcome = await handler(context, input);
      if (!isPlainRecord(outcome) || !Value.Check(definition.outputSchema, outcome.data)) {
        return failure("PROVENANCE_MISMATCH");
      }
      const warnings = outcome.warnings ?? [];
      if (
        !Array.isArray(warnings) ||
        warnings.some(
          (warning) =>
            !isPlainRecord(warning) ||
            !/^[A-Z][A-Z0-9_]{0,99}$/.test(String(warning.code)) ||
            typeof warning.safeMessage !== "string",
        ) ||
        !isSafeVisible(outcome.data, outcome.sensitiveValues ?? []) ||
        !isSafeVisible(warnings as unknown as JsonValue, outcome.sensitiveValues ?? [])
      ) {
        return failure("PROVENANCE_MISMATCH");
      }
      const data = JSON.parse(stableSerialize(outcome.data)) as JsonValue;
      const knowledgeVersions = [
        ...(outcome.knowledgeVersions ?? []),
        ...collectVersions(input),
        ...collectVersions(data),
      ].filter((value, index, values) => values.indexOf(value) === index);
      if (!isSafeVisible(knowledgeVersions, outcome.sensitiveValues ?? [])) {
        return failure("PROVENANCE_MISMATCH");
      }
      return {
        ok: true,
        data,
        provenance: {
          toolName: name as ToolName,
          toolVersion: definition.version,
          inputHash: hash(input),
          outputHash: hash(data),
          knowledgeVersions,
          executedAt: this.now().toISOString(),
        },
        warnings: JSON.parse(stableSerialize(warnings as unknown as JsonValue)) as ToolWarning[],
      };
    } catch (error) {
      if (error instanceof McpToolError) return failure(error.code, safeDiagnostics(error.diagnostics));
      return failure("DEPENDENCY_UNAVAILABLE");
    }
  }

  private isToolAllowed(context: TrustedToolContext, name: ToolName): boolean {
    return (
      this.isTrustedContextValid(context) &&
      MODEL_TOOLS_BY_STATE[context.workflowState].includes(name) &&
      context.allowedToolNames.includes(name)
    );
  }

  private isTrustedContextValid(context: TrustedToolContext): boolean {
    return (
      isPlainRecord(context) &&
      context.actorRole === "PSYCHIATRIST" &&
      typeof context.executionId === "string" &&
      typeof context.jobId === "string" &&
      typeof context.subjectRef === "string" &&
      Number.isInteger(context.researchCaseRevision) &&
      WORKFLOW_STATES.includes(context.workflowState) &&
      Array.isArray(context.allowedToolNames) &&
      typeof context.idempotencyKey === "string"
    );
  }
}

import { FormatRegistry, Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const CURRENT_SCHEMA_VERSION = "1" as const;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const TIMESTAMP_PATTERN =
  "^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const ERROR_CODE_PATTERN = "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$";

const timestampParts = new RegExp(TIMESTAMP_PATTERN);

function isRfc3339Timestamp(value: string): boolean {
  if (timestampParts.exec(value) === null) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return day >= 1 && day <= daysInMonth[month - 1]!;
}

const isUuid = (value: string): boolean => new RegExp(UUID_PATTERN).test(value);

function registerContractFormats(): void {
  FormatRegistry.Set("uuid", isUuid);
  FormatRegistry.Set("date-time", isRfc3339Timestamp);
}

registerContractFormats();

export const UuidSchema = Type.String({
  title: "INSIGHT UUID v1",
  format: "uuid",
  pattern: UUID_PATTERN,
});
export type Uuid = Static<typeof UuidSchema>;

export const TimestampSchema = Type.String({
  title: "INSIGHT timestamp v1",
  format: "date-time",
  pattern: TIMESTAMP_PATTERN,
});
export type Timestamp = Static<typeof TimestampSchema>;

export const Sha256Schema = Type.String({
  title: "INSIGHT SHA-256 v1",
  pattern: SHA256_PATTERN,
});
export type Sha256 = Static<typeof Sha256Schema>;

export const RoleSchema = Type.Union(
  [Type.Literal("ADMINISTRATOR"), Type.Literal("PSYCHIATRIST")],
  { title: "INSIGHT role v1" },
);
export type Role = Static<typeof RoleSchema>;

export const SchemaVersionSchema = Type.Literal(CURRENT_SCHEMA_VERSION, {
  description: "Runtime contract schema version",
});
export type SchemaVersion = Static<typeof SchemaVersionSchema>;

export const ApiErrorIssueSchema = Type.Object(
  {
    path: Type.String({ maxLength: 512 }),
    code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
    message: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type ApiErrorIssue = Static<typeof ApiErrorIssueSchema>;

export const ApiErrorSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    error: Type.Object(
      {
        status: Type.Integer({ minimum: 400, maximum: 599 }),
        code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
        message: Type.String({ minLength: 1, maxLength: 1000 }),
        requestId: UuidSchema,
        issues: Type.Optional(Type.Array(ApiErrorIssueSchema, { maxItems: 100 })),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "insight.api-error.v1", additionalProperties: false },
);
export type ApiError = Static<typeof ApiErrorSchema>;

export const PaginationQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  },
  { $id: "insight.pagination-query.v1", additionalProperties: false },
);
export type PaginationQuery = Static<typeof PaginationQuerySchema>;

export const PaginationSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { title: "INSIGHT pagination v1", additionalProperties: false },
);
export type Pagination = Static<typeof PaginationSchema>;

export function paginatedResponseSchema<T extends TSchema>(itemSchema: T) {
  return Type.Object(
    {
      schemaVersion: SchemaVersionSchema,
      items: Type.Array(itemSchema),
      pagination: PaginationSchema,
    },
    { additionalProperties: false },
  );
}

export const ProvenanceSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    executionId: UuidSchema,
    source: Type.String({ minLength: 1, maxLength: 200 }),
    sourceVersion: Type.String({ minLength: 1, maxLength: 200 }),
    inputHash: Sha256Schema,
    outputHash: Sha256Schema,
    recordedAt: TimestampSchema,
  },
  { $id: "insight.provenance.v1", additionalProperties: false },
);
export type Provenance = Static<typeof ProvenanceSchema>;

export const TREATMENT_PLAN_SCHEMA_VERSION = "1.0.0" as const;
const TreatmentPlanRefSchema = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._:-]{0,199}$" });
const TreatmentPlanTextSchema = Type.String({ minLength: 1, maxLength: 4000 });
const TreatmentPlanShortTextSchema = Type.String({ minLength: 1, maxLength: 500 });

export const PrimaryTreatmentPlanInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(TREATMENT_PLAN_SCHEMA_VERSION),
    regimen: Type.Array(
      Type.Object(
        {
          canonicalMedicationId: TreatmentPlanRefSchema,
          dose: Type.Object(
            {
              value: Type.Number({ exclusiveMinimum: 0 }),
              unit: TreatmentPlanShortTextSchema,
            },
            { additionalProperties: false },
          ),
          route: TreatmentPlanShortTextSchema,
          frequency: TreatmentPlanShortTextSchema,
          titration: Type.Optional(TreatmentPlanTextSchema),
          monitoring: Type.Array(TreatmentPlanTextSchema, { maxItems: 100 }),
          rationale: Type.Array(
            Type.Object(
              {
                kind: TreatmentPlanRefSchema,
                sourceRef: TreatmentPlanRefSchema,
                text: TreatmentPlanTextSchema,
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 100 },
          ),
          warningRefs: Type.Array(TreatmentPlanRefSchema, {
            maxItems: 100,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    generalMonitoring: Type.Array(TreatmentPlanTextSchema, { maxItems: 100 }),
    explanation: TreatmentPlanTextSchema,
    sourceExecutionRefs: Type.Array(TreatmentPlanRefSchema, {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { $id: "insight.treatment-plan-primary-input.v1", additionalProperties: false },
);
export type PrimaryTreatmentPlanInput = Static<typeof PrimaryTreatmentPlanInputSchema>;

export const PrimaryTreatmentPlanOutputSchema = Type.Object(
  {
    draftRef: TreatmentPlanRefSchema,
    draftRevision: Type.Integer({ minimum: 1 }),
    aiImputationNoticeVisible: Type.Boolean(),
  },
  { $id: "insight.treatment-plan-primary-output.v1", additionalProperties: false },
);
export type PrimaryTreatmentPlanOutput = Static<typeof PrimaryTreatmentPlanOutputSchema>;

export const ClinicianRegimenMedicationSchema = Type.Object(
  {
    canonicalMedicationId: TreatmentPlanRefSchema,
    dose: Type.Object(
      {
        value: Type.Number({ exclusiveMinimum: 0 }),
        unit: TreatmentPlanShortTextSchema,
      },
      { additionalProperties: false },
    ),
    route: TreatmentPlanShortTextSchema,
    frequency: TreatmentPlanShortTextSchema,
    titration: Type.Optional(TreatmentPlanTextSchema),
    monitoring: Type.Array(TreatmentPlanTextSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type ClinicianRegimenMedication = Static<typeof ClinicianRegimenMedicationSchema>;

export const ClinicianRegimenInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    regimen: Type.Array(ClinicianRegimenMedicationSchema, { minItems: 1, maxItems: 100 }),
  },
  { $id: "insight.clinician-regimen-input.v1", additionalProperties: false },
);
export type ClinicianRegimenInput = Static<typeof ClinicianRegimenInputSchema>;

export const HealthResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, status: Type.Literal("ok") },
  { $id: "insight.health-response.v1", additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

const ReadinessCheckSchema = Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]);

export const ReadinessResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]),
    checks: Type.Object(
      {
        application: ReadinessCheckSchema,
        database: ReadinessCheckSchema,
        worker: ReadinessCheckSchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: "insight.readiness-response.v1", additionalProperties: false },
);
export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;

export const MODEL_ENDPOINT_STATUSES = [
  "PENDING",
  "CHECKING",
  "COMPATIBLE",
  "INCOMPATIBLE",
] as const;
export const MODEL_ENDPOINT_FAILURE_CATEGORIES = [
  "AUTHENTICATION",
  "ENDPOINT",
  "RATE_LIMITED",
  "PROVIDER",
  "TIMEOUT",
  "MALFORMED_RESPONSE",
  "TOOL_CALL",
  "TOOL_ROUND_TRIP",
] as const;

export const ModelEndpointReplaceRequestSchema = Type.Object(
  {
    baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
    model: Type.String({ minLength: 1, maxLength: 500 }),
    credential: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { $id: "insight.model-endpoint-replace-request.v1", additionalProperties: false },
);
export type ModelEndpointReplaceRequest = Static<typeof ModelEndpointReplaceRequestSchema>;

export const ModelEndpointConfigurationSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
    model: Type.String({ minLength: 1, maxLength: 500 }),
    credentialConfigured: Type.Boolean(),
    status: Type.Union(MODEL_ENDPOINT_STATUSES.map((value) => Type.Literal(value))),
    aiEligible: Type.Boolean(),
    compatibilityTestVersion: Type.String({ minLength: 1, maxLength: 100 }),
    configurationFingerprint: Sha256Schema,
    failureCategory: Type.Union([
      ...MODEL_ENDPOINT_FAILURE_CATEGORIES.map((value) => Type.Literal(value)),
      Type.Null(),
    ]),
    returnedModel: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    lastCheckedAt: Type.Union([TimestampSchema, Type.Null()]),
    createdAt: TimestampSchema,
  },
  { $id: "insight.model-endpoint-configuration.v1", additionalProperties: false },
);
export type ModelEndpointConfiguration = Static<typeof ModelEndpointConfigurationSchema>;

export const ModelEndpointConfigurationResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    configuration: Type.Union([ModelEndpointConfigurationSchema, Type.Null()]),
  },
  { $id: "insight.model-endpoint-configuration-response.v1", additionalProperties: false },
);

export interface ContractValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly ContractValidationIssue[];

  constructor(issues: readonly ContractValidationIssue[]) {
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export class UnsupportedSchemaVersionError extends Error {
  readonly received: unknown;
  readonly supported = CURRENT_SCHEMA_VERSION;

  constructor(received: unknown) {
    const description =
      received === null || ["boolean", "number", "string", "undefined"].includes(typeof received)
        ? String(received)
        : `<${typeof received}>`;
    super(`Unsupported schema version: ${description}`);
    this.name = "UnsupportedSchemaVersionError";
    this.received = received;
  }
}

export function isContract<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  registerContractFormats();
  return Value.Check(schema, value);
}

export function parseContract<T extends TSchema>(schema: T, value: unknown): Static<T> {
  registerContractFormats();
  if (Value.Check(schema, value)) return value as Static<T>;

  const issues = [...Value.Errors(schema, value)]
    .map(({ path, message }) => ({ path: path || "/", message }))
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      if (left.message === right.message) return 0;
      return left.message < right.message ? -1 : 1;
    });
  throw new ContractValidationError(issues);
}

export function assertSupportedSchemaVersion(
  value: unknown,
): asserts value is { schemaVersion: SchemaVersion } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractValidationError([
      { path: "/schemaVersion", message: "Expected a versioned object" },
    ]);
  }

  const received = (value as Record<string, unknown>).schemaVersion;
  if (received === undefined) {
    throw new ContractValidationError([
      { path: "/schemaVersion", message: "Expected schemaVersion" },
    ]);
  }
  if (received !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(received);
  }
}

export function parseVersionedContract<T extends TSchema>(schema: T, value: unknown): Static<T> {
  assertSupportedSchemaVersion(value);
  return parseContract(schema, value);
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const ASSESSMENT_TYPES = ["DSM5TR", "PANSS", "CSSRS_RECENT"] as const;
export const ASSESSMENT_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "BYPASSED"] as const;

export const AssessmentTypeSchema = Type.Union(
  ASSESSMENT_TYPES.map((value) => Type.Literal(value)),
  { $id: "insight.assessment-type.v1" },
);
export type AssessmentType = Static<typeof AssessmentTypeSchema>;

export const AssessmentStatusSchema = Type.Union(
  ASSESSMENT_STATUSES.map((value) => Type.Literal(value)),
  { $id: "insight.assessment-status.v1" },
);
export type AssessmentStatus = Static<typeof AssessmentStatusSchema>;

export const AssessmentStateSchema = Type.Object(
  {
    researchCaseId: UuidSchema,
    assessmentType: AssessmentTypeSchema,
    status: AssessmentStatusSchema,
    updatedByUserId: Type.Union([UuidSchema, Type.Null()]),
    updatedAt: Type.Union([TimestampSchema, Type.Null()]),
  },
  { $id: "insight.assessment-state.v1", additionalProperties: false },
);
export type AssessmentState = Static<typeof AssessmentStateSchema>;

export const DSM5TR_INSTRUMENT_PIN = Object.freeze({
  instrumentId: "DSM5TR_SCHIZOPHRENIA",
  instrumentVersion: "DSM-5-TR-2022",
  schemaVersion: "1.0.0",
  calculationVersion: "1.0.0",
  sourceReference: "https://doi.org/10.1176/appi.books.9780890425787.x02_Schizophrenia_Spectrum",
  reviewReference: "ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW",
} as const);

export const DSM5TR_CRITERION_A_KEYS = [
  "delusions",
  "hallucinations",
  "disorganizedSpeech",
  "disorganizedOrCatatonicBehavior",
  "negativeSymptoms",
] as const;

export const DSM5TR_DEFINITION = Object.freeze({
  title: "DSM-5-TR schizophrenia criteria assessment",
  sections: [
    {
      criterion: "A",
      title: "Core symptoms",
      instruction:
        "Record whether each symptom was present for a significant part of the active-phase period.",
      questions: [
        { id: "a-delusions", answerPath: "criterionA.delusions", label: "Delusions" },
        {
          id: "a-hallucinations",
          answerPath: "criterionA.hallucinations",
          label: "Hallucinations",
        },
        {
          id: "a-disorganized-speech",
          answerPath: "criterionA.disorganizedSpeech",
          label: "Disorganized speech",
        },
        {
          id: "a-disorganized-behavior",
          answerPath: "criterionA.disorganizedOrCatatonicBehavior",
          label: "Grossly disorganized or catatonic behavior",
        },
        {
          id: "a-negative-symptoms",
          answerPath: "criterionA.negativeSymptoms",
          label: "Negative symptoms",
        },
      ],
    },
    {
      criterion: "B",
      title: "Functional decline",
      instruction: "Record whether the functional-decline requirement is met.",
      questions: [
        {
          id: "b-functional-decline",
          answerPath: "criterionBFunctionalDecline",
          label: "Functional-decline requirement met",
        },
      ],
    },
    {
      criterion: "C",
      title: "Duration",
      instruction: "Record whether the duration requirement is met.",
      questions: [
        {
          id: "c-duration",
          answerPath: "criterionCDuration",
          label: "Duration requirement met",
        },
      ],
    },
    {
      criterion: "D",
      title: "Mood-disorder exclusion",
      instruction: "Record whether the mood-disorder exclusion requirement is met.",
      questions: [
        {
          id: "d-mood-exclusion",
          answerPath: "criterionDMoodDisorderExclusion",
          label: "Mood-disorder exclusion requirement met",
        },
      ],
    },
    {
      criterion: "E",
      title: "Substance or medical-condition exclusion",
      instruction: "Record whether the substance or medical-condition exclusion is met.",
      questions: [
        {
          id: "e-substance-medical-exclusion",
          answerPath: "criterionESubstanceOrMedicalExclusion",
          label: "Substance or medical-condition exclusion requirement met",
        },
      ],
    },
    {
      criterion: "F",
      title: "Developmental-disorder relationship",
      instruction: "Record developmental history and the conditional psychosis requirement.",
      questions: [
        {
          id: "f-developmental-history",
          answerPath: "criterionFDevelopmentalHistory",
          label: "History of autism spectrum disorder or childhood communication disorder",
        },
        {
          id: "f-prominent-psychosis",
          answerPath: "criterionFProminentDelusionsOrHallucinations",
          label: "Prominent delusions or hallucinations meet the required duration",
          dependsOn: { answerPath: "criterionFDevelopmentalHistory", value: true },
        },
      ],
    },
  ],
} as const);

export const Dsm5trDefinitionSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    sections: Type.Array(
      Type.Object(
        {
          criterion: Type.Union([
            Type.Literal("A"),
            Type.Literal("B"),
            Type.Literal("C"),
            Type.Literal("D"),
            Type.Literal("E"),
            Type.Literal("F"),
          ]),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          instruction: Type.String({ minLength: 1, maxLength: 500 }),
          questions: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 100 }),
                answerPath: Type.String({ minLength: 1, maxLength: 100 }),
                label: Type.String({ minLength: 1, maxLength: 300 }),
                dependsOn: Type.Optional(
                  Type.Object(
                    {
                      answerPath: Type.String({ minLength: 1, maxLength: 100 }),
                      value: Type.Boolean(),
                    },
                    { additionalProperties: false },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 6, maxItems: 6 },
    ),
  },
  { $id: "insight.dsm5tr-definition.v1", additionalProperties: false },
);

export const Dsm5trAnswersSchema = Type.Object(
  {
    criterionA: Type.Object(
      {
        delusions: Type.Optional(Type.Boolean()),
        hallucinations: Type.Optional(Type.Boolean()),
        disorganizedSpeech: Type.Optional(Type.Boolean()),
        disorganizedOrCatatonicBehavior: Type.Optional(Type.Boolean()),
        negativeSymptoms: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    criterionBFunctionalDecline: Type.Optional(Type.Boolean()),
    criterionCDuration: Type.Optional(Type.Boolean()),
    criterionDMoodDisorderExclusion: Type.Optional(Type.Boolean()),
    criterionESubstanceOrMedicalExclusion: Type.Optional(Type.Boolean()),
    criterionFDevelopmentalHistory: Type.Optional(Type.Boolean()),
    criterionFProminentDelusionsOrHallucinations: Type.Optional(Type.Boolean()),
  },
  { $id: "insight.dsm5tr-answers.v1", additionalProperties: false },
);
export type Dsm5trAnswers = Static<typeof Dsm5trAnswersSchema>;

export const Dsm5trPsychiatristDecisionSchema = Type.Union([
  Type.Literal("UNDECIDED"),
  Type.Literal("SCHIZOPHRENIA_CONFIRMED"),
  Type.Literal("SCHIZOPHRENIA_NOT_CONFIRMED"),
]);
export type Dsm5trPsychiatristDecision = Static<typeof Dsm5trPsychiatristDecisionSchema>;

export const Dsm5trCriterionResultSchema = Type.Union([
  Type.Literal("INCOMPLETE"),
  Type.Literal("MET"),
  Type.Literal("NOT_MET"),
]);
export type Dsm5trCriterionResult = Static<typeof Dsm5trCriterionResultSchema>;

export const Dsm5trCalculationSchema = Type.Object(
  {
    calculationVersion: Type.Literal(DSM5TR_INSTRUMENT_PIN.calculationVersion),
    disposition: Type.Union([
      Type.Literal("INCOMPLETE"),
      Type.Literal("CRITERIA_MET"),
      Type.Literal("CRITERIA_NOT_MET"),
    ]),
    criteria: Type.Object(
      {
        A: Dsm5trCriterionResultSchema,
        B: Dsm5trCriterionResultSchema,
        C: Dsm5trCriterionResultSchema,
        D: Dsm5trCriterionResultSchema,
        E: Dsm5trCriterionResultSchema,
        F: Dsm5trCriterionResultSchema,
      },
      { additionalProperties: false },
    ),
    criterionASymptomCount: Type.Union([Type.Integer({ minimum: 0, maximum: 5 }), Type.Null()]),
    criterionAHasCoreSymptom: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { $id: "insight.dsm5tr-calculation.v1", additionalProperties: false },
);
export type Dsm5trCalculation = Static<typeof Dsm5trCalculationSchema>;

function booleanCriterion(value: boolean | undefined): Dsm5trCriterionResult {
  return value === undefined ? "INCOMPLETE" : value ? "MET" : "NOT_MET";
}

export function calculateDsm5tr(answers: Dsm5trAnswers): Dsm5trCalculation {
  const symptomValues = DSM5TR_CRITERION_A_KEYS.map((key) => answers.criterionA[key]);
  const criterionAComplete = symptomValues.every((value) => value !== undefined);
  const symptomCount = criterionAComplete
    ? symptomValues.filter((value) => value === true).length
    : null;
  const hasCoreSymptom = criterionAComplete
    ? answers.criterionA.delusions === true ||
      answers.criterionA.hallucinations === true ||
      answers.criterionA.disorganizedSpeech === true
    : null;
  const criterionA: Dsm5trCriterionResult = !criterionAComplete
    ? "INCOMPLETE"
    : symptomCount! >= 2 && hasCoreSymptom
      ? "MET"
      : "NOT_MET";
  const criterionF: Dsm5trCriterionResult =
    answers.criterionFDevelopmentalHistory === undefined
      ? "INCOMPLETE"
      : answers.criterionFDevelopmentalHistory === false
        ? "MET"
        : booleanCriterion(answers.criterionFProminentDelusionsOrHallucinations);
  const criteria = {
    A: criterionA,
    B: booleanCriterion(answers.criterionBFunctionalDecline),
    C: booleanCriterion(answers.criterionCDuration),
    D: booleanCriterion(answers.criterionDMoodDisorderExclusion),
    E: booleanCriterion(answers.criterionESubstanceOrMedicalExclusion),
    F: criterionF,
  } as const;
  const values = Object.values(criteria);
  const disposition = values.includes("INCOMPLETE")
    ? "INCOMPLETE"
    : values.every((value) => value === "MET")
      ? "CRITERIA_MET"
      : "CRITERIA_NOT_MET";
  return {
    calculationVersion: DSM5TR_INSTRUMENT_PIN.calculationVersion,
    disposition,
    criteria,
    criterionASymptomCount: symptomCount,
    criterionAHasCoreSymptom: hasCoreSymptom,
  };
}

export const CSSRS_SOURCE_SHA256 =
  "8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2" as const;

export const CSSRS_INSTRUMENT_PIN = Object.freeze({
  instrumentId: "C_SSRS_SCREEN_RECENT",
  instrumentVersion: `LOCAL-PDF-SHA256-${CSSRS_SOURCE_SHA256}`,
  schemaVersion: "1.0.0",
  calculationVersion: "1.0.0",
  sourceReference: "medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf",
  sourceSha256: CSSRS_SOURCE_SHA256,
  reviewReference: "CSSRS-CLINICAL-REVIEW-2026-08-22-PENDING",
} as const);

export const CSSRS_ACTIVATION_GATE = Object.freeze({
  status: "INACTIVE",
  permissionRecord: false,
  trainingRecord: false,
  transcriptionApproval: false,
  clinicalReviewApproval: false,
} as const);

export const CSSRS_BANDS = Object.freeze({
  LOW: { label: "Low", color: "#fff200" },
  MODERATE: { label: "Moderate", color: "#ffbf00" },
  HIGH: { label: "High", color: "#ff0000" },
  NO_POSITIVE_RESPONSE: { label: "No positive response", color: "#6b7280" },
} as const);

export type CssrsBand = keyof typeof CSSRS_BANDS;

export const CSSRS_DEFINITION = Object.freeze({
  title: "C-SSRS Screen Version - Recent",
  instruction: "Ask questions 1, 2, and 6. Ask questions 3 through 5 only when question 2 is Yes.",
  questions: [
    {
      id: "Q1",
      number: 1,
      answerPath: "q1WishDead",
      timeframe: "PAST_MONTH",
      text: "Have you wished you were dead or wished you could go to sleep and not wake up?",
    },
    {
      id: "Q2",
      number: 2,
      answerPath: "q2SuicidalThoughts",
      timeframe: "PAST_MONTH",
      text: "Have you actually had any thoughts of killing yourself?",
    },
    {
      id: "Q3",
      number: 3,
      answerPath: "q3Method",
      timeframe: "PAST_MONTH",
      text: "Have you been thinking about how you might do this?",
    },
    {
      id: "Q4",
      number: 4,
      answerPath: "q4Intent",
      timeframe: "PAST_MONTH",
      text: "Have you had these thoughts and had some intention of acting on them?",
    },
    {
      id: "Q5",
      number: 5,
      answerPath: "q5Plan",
      timeframe: "PAST_MONTH",
      text: "Have you started to work out or worked out the details of how to kill yourself? Do you intend to carry out this plan?",
    },
    {
      id: "Q6",
      number: 6,
      answerPath: "q6Behavior",
      timeframe: "LIFETIME",
      text: "Have you ever done anything, started to do anything, or prepared to do anything to end your life?",
    },
  ],
  recencyFollowUp: {
    id: "Q6_RECENCY",
    answerPath: "q6WithinThreeMonths",
    timeframe: "PAST_THREE_MONTHS",
    text: "Was this within the past three months?",
  },
} as const);

const cssrsQuestionSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("Q1"),
      Type.Literal("Q2"),
      Type.Literal("Q3"),
      Type.Literal("Q4"),
      Type.Literal("Q5"),
      Type.Literal("Q6"),
    ]),
    number: Type.Integer({ minimum: 1, maximum: 6 }),
    answerPath: Type.String({ minLength: 1, maxLength: 100 }),
    timeframe: Type.Union([Type.Literal("PAST_MONTH"), Type.Literal("LIFETIME")]),
    text: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);

export const CssrsDefinitionSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    instruction: Type.String({ minLength: 1, maxLength: 300 }),
    questions: Type.Array(cssrsQuestionSchema, { minItems: 6, maxItems: 6 }),
    recencyFollowUp: Type.Object(
      {
        id: Type.Literal("Q6_RECENCY"),
        answerPath: Type.Literal("q6WithinThreeMonths"),
        timeframe: Type.Literal("PAST_THREE_MONTHS"),
        text: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "insight.cssrs-definition.v1", additionalProperties: false },
);

export const CssrsAnswersSchema = Type.Object(
  {
    q1WishDead: Type.Optional(Type.Boolean()),
    q2SuicidalThoughts: Type.Optional(Type.Boolean()),
    q3Method: Type.Optional(Type.Boolean()),
    q4Intent: Type.Optional(Type.Boolean()),
    q5Plan: Type.Optional(Type.Boolean()),
    q6Behavior: Type.Optional(Type.Boolean()),
    q6WithinThreeMonths: Type.Optional(Type.Boolean()),
  },
  { $id: "insight.cssrs-answers.v1", additionalProperties: false },
);
export type CssrsAnswers = Static<typeof CssrsAnswersSchema>;

export const CssrsBandSchema = Type.Union([
  Type.Literal("LOW"),
  Type.Literal("MODERATE"),
  Type.Literal("HIGH"),
  Type.Literal("NO_POSITIVE_RESPONSE"),
]);

export const CssrsCalculationSchema = Type.Object(
  {
    calculationVersion: Type.Literal(CSSRS_INSTRUMENT_PIN.calculationVersion),
    status: Type.Union([Type.Literal("INCOMPLETE"), Type.Literal("COMPLETE")]),
    band: Type.Union([CssrsBandSchema, Type.Null()]),
    traversedBranch: Type.Union([
      Type.Literal("Q2_UNANSWERED"),
      Type.Literal("Q2_NO_SKIP_TO_Q6"),
      Type.Literal("Q2_YES_ASK_Q3_TO_Q5"),
    ]),
    traversedQuestions: Type.Array(
      Type.Union([
        Type.Literal("Q1"),
        Type.Literal("Q2"),
        Type.Literal("Q3"),
        Type.Literal("Q4"),
        Type.Literal("Q5"),
        Type.Literal("Q6"),
        Type.Literal("Q6_RECENCY"),
      ]),
      { minItems: 3, maxItems: 7 },
    ),
  },
  { $id: "insight.cssrs-calculation.v1", additionalProperties: false },
);
export type CssrsCalculation = Static<typeof CssrsCalculationSchema>;

export function calculateCssrs(answers: CssrsAnswers): CssrsCalculation {
  if (!isContract(CssrsAnswersSchema, answers)) throw new Error("Invalid C-SSRS answers.");
  if (
    answers.q2SuicidalThoughts !== true &&
    [answers.q3Method, answers.q4Intent, answers.q5Plan].some((answer) => answer !== undefined)
  ) {
    throw new Error("C-SSRS questions 3 through 5 require a Yes answer to question 2.");
  }
  if (answers.q6Behavior !== true && answers.q6WithinThreeMonths !== undefined) {
    throw new Error("C-SSRS question 6 recency requires a Yes answer to question 6.");
  }

  const traversedBranch =
    answers.q2SuicidalThoughts === true
      ? "Q2_YES_ASK_Q3_TO_Q5"
      : answers.q2SuicidalThoughts === false
        ? "Q2_NO_SKIP_TO_Q6"
        : "Q2_UNANSWERED";
  const traversedQuestions = [
    "Q1",
    "Q2",
    ...(answers.q2SuicidalThoughts === true ? (["Q3", "Q4", "Q5"] as const) : []),
    "Q6",
    ...(answers.q6Behavior === true ? (["Q6_RECENCY"] as const) : []),
  ] as CssrsCalculation["traversedQuestions"];
  const complete =
    answers.q1WishDead !== undefined &&
    answers.q2SuicidalThoughts !== undefined &&
    answers.q6Behavior !== undefined &&
    (answers.q2SuicidalThoughts !== true ||
      [answers.q3Method, answers.q4Intent, answers.q5Plan].every(
        (answer) => answer !== undefined,
      )) &&
    (answers.q6Behavior !== true || answers.q6WithinThreeMonths !== undefined);

  if (!complete) {
    return {
      calculationVersion: CSSRS_INSTRUMENT_PIN.calculationVersion,
      status: "INCOMPLETE",
      band: null,
      traversedBranch,
      traversedQuestions,
    };
  }

  const band: CssrsBand =
    answers.q4Intent === true ||
    answers.q5Plan === true ||
    (answers.q6Behavior === true && answers.q6WithinThreeMonths === true)
      ? "HIGH"
      : answers.q3Method === true ||
          (answers.q6Behavior === true && answers.q6WithinThreeMonths === false)
        ? "MODERATE"
        : answers.q1WishDead === true || answers.q2SuicidalThoughts === true
          ? "LOW"
          : "NO_POSITIVE_RESPONSE";

  return {
    calculationVersion: CSSRS_INSTRUMENT_PIN.calculationVersion,
    status: "COMPLETE",
    band,
    traversedBranch,
    traversedQuestions,
  };
}

export const PANSS_INSTRUMENT_PIN = Object.freeze({
  instrumentId: "PANSS_30",
  instrumentVersion: "KAY-OPLER-FISZBEIN-1987",
  schemaVersion: "1.0.0",
  calculationVersion: "1.0.0",
  sourceReference: "https://doi.org/10.1093/schbul/13.2.261",
  reviewReference: "ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW",
} as const);

export const PANSS_ANCHORS = Object.freeze([
  { score: 1, label: "Absent" },
  { score: 2, label: "Minimal" },
  { score: 3, label: "Mild" },
  { score: 4, label: "Moderate" },
  { score: 5, label: "Moderate severe" },
  { score: 6, label: "Severe" },
  { score: 7, label: "Extreme" },
] as const);

export const PANSS_ITEMS = Object.freeze([
  { id: "P1", subscale: "POSITIVE", text: "Delusions" },
  { id: "P2", subscale: "POSITIVE", text: "Conceptual disorganization" },
  { id: "P3", subscale: "POSITIVE", text: "Hallucinatory behavior" },
  { id: "P4", subscale: "POSITIVE", text: "Excitement" },
  { id: "P5", subscale: "POSITIVE", text: "Grandiosity" },
  { id: "P6", subscale: "POSITIVE", text: "Suspiciousness/persecution" },
  { id: "P7", subscale: "POSITIVE", text: "Hostility" },
  { id: "N1", subscale: "NEGATIVE", text: "Blunted affect" },
  { id: "N2", subscale: "NEGATIVE", text: "Emotional withdrawal" },
  { id: "N3", subscale: "NEGATIVE", text: "Poor rapport" },
  { id: "N4", subscale: "NEGATIVE", text: "Passive/apathetic social withdrawal" },
  { id: "N5", subscale: "NEGATIVE", text: "Difficulty in abstract thinking" },
  { id: "N6", subscale: "NEGATIVE", text: "Lack of spontaneity and flow of conversation" },
  { id: "N7", subscale: "NEGATIVE", text: "Stereotyped thinking" },
  { id: "G1", subscale: "GENERAL", text: "Somatic concern" },
  { id: "G2", subscale: "GENERAL", text: "Anxiety" },
  { id: "G3", subscale: "GENERAL", text: "Guilt feelings" },
  { id: "G4", subscale: "GENERAL", text: "Tension" },
  { id: "G5", subscale: "GENERAL", text: "Mannerisms and posturing" },
  { id: "G6", subscale: "GENERAL", text: "Depression" },
  { id: "G7", subscale: "GENERAL", text: "Motor retardation" },
  { id: "G8", subscale: "GENERAL", text: "Uncooperativeness" },
  { id: "G9", subscale: "GENERAL", text: "Unusual thought content" },
  { id: "G10", subscale: "GENERAL", text: "Disorientation" },
  { id: "G11", subscale: "GENERAL", text: "Poor attention" },
  { id: "G12", subscale: "GENERAL", text: "Lack of judgment and insight" },
  { id: "G13", subscale: "GENERAL", text: "Disturbance of volition" },
  { id: "G14", subscale: "GENERAL", text: "Poor impulse control" },
  { id: "G15", subscale: "GENERAL", text: "Preoccupation" },
  { id: "G16", subscale: "GENERAL", text: "Active social avoidance" },
] as const);

export type PanssItemId = (typeof PANSS_ITEMS)[number]["id"];
export type PanssSubscale = (typeof PANSS_ITEMS)[number]["subscale"];

export const PANSS_DEFINITION = Object.freeze({
  title: "Positive and Negative Syndrome Scale (PANSS)",
  instruction: "Rate every item from 1 (Absent) to 7 (Extreme).",
  anchors: PANSS_ANCHORS,
  items: PANSS_ITEMS,
} as const);

export const PanssDefinitionSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    instruction: Type.String({ minLength: 1, maxLength: 300 }),
    anchors: Type.Array(
      Type.Object(
        {
          score: Type.Integer({ minimum: 1, maximum: 7 }),
          label: Type.String({ minLength: 1, maxLength: 50 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 7, maxItems: 7 },
    ),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^(P[1-7]|N[1-7]|G(?:[1-9]|1[0-6]))$" }),
          subscale: Type.Union([
            Type.Literal("POSITIVE"),
            Type.Literal("NEGATIVE"),
            Type.Literal("GENERAL"),
          ]),
          text: Type.String({ minLength: 1, maxLength: 200 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 30, maxItems: 30 },
    ),
  },
  { $id: "insight.panss-definition.v1", additionalProperties: false },
);

const panssScore = () => Type.Optional(Type.Integer({ minimum: 1, maximum: 7 }));
export const PanssAnswersSchema = Type.Object(
  {
    P1: panssScore(),
    P2: panssScore(),
    P3: panssScore(),
    P4: panssScore(),
    P5: panssScore(),
    P6: panssScore(),
    P7: panssScore(),
    N1: panssScore(),
    N2: panssScore(),
    N3: panssScore(),
    N4: panssScore(),
    N5: panssScore(),
    N6: panssScore(),
    N7: panssScore(),
    G1: panssScore(),
    G2: panssScore(),
    G3: panssScore(),
    G4: panssScore(),
    G5: panssScore(),
    G6: panssScore(),
    G7: panssScore(),
    G8: panssScore(),
    G9: panssScore(),
    G10: panssScore(),
    G11: panssScore(),
    G12: panssScore(),
    G13: panssScore(),
    G14: panssScore(),
    G15: panssScore(),
    G16: panssScore(),
  },
  { $id: "insight.panss-answers.v1", additionalProperties: false },
);
export type PanssAnswers = Static<typeof PanssAnswersSchema>;

const completePanssScoresSchema = Type.Object(
  {
    positive: Type.Integer({ minimum: 7, maximum: 49 }),
    negative: Type.Integer({ minimum: 7, maximum: 49 }),
    general: Type.Integer({ minimum: 16, maximum: 112 }),
    total: Type.Integer({ minimum: 30, maximum: 210 }),
  },
  { additionalProperties: false },
);

export const PanssCalculationSchema = Type.Union(
  [
    Type.Object(
      {
        calculationVersion: Type.Literal(PANSS_INSTRUMENT_PIN.calculationVersion),
        status: Type.Literal("INCOMPLETE"),
        answeredCount: Type.Integer({ minimum: 0, maximum: 29 }),
        scores: Type.Null(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        calculationVersion: Type.Literal(PANSS_INSTRUMENT_PIN.calculationVersion),
        status: Type.Literal("COMPLETE"),
        answeredCount: Type.Literal(30),
        scores: completePanssScoresSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "insight.panss-calculation.v1" },
);
export type PanssCalculation = Static<typeof PanssCalculationSchema>;

export function calculatePanss(answers: PanssAnswers): PanssCalculation {
  const answered = PANSS_ITEMS.filter(({ id }) => answers[id] !== undefined);
  for (const { id } of answered) {
    const value = answers[id]!;
    if (!Number.isInteger(value) || value < 1 || value > 7) {
      throw new RangeError(`${id} must be an integer from 1 to 7.`);
    }
  }
  if (answered.length !== PANSS_ITEMS.length) {
    return {
      calculationVersion: PANSS_INSTRUMENT_PIN.calculationVersion,
      status: "INCOMPLETE",
      answeredCount: answered.length,
      scores: null,
    };
  }

  const sum = (subscale: PanssSubscale) =>
    PANSS_ITEMS.filter((item) => item.subscale === subscale).reduce(
      (total, { id }) => total + answers[id]!,
      0,
    );
  const positive = sum("POSITIVE");
  const negative = sum("NEGATIVE");
  const general = sum("GENERAL");
  return {
    calculationVersion: PANSS_INSTRUMENT_PIN.calculationVersion,
    status: "COMPLETE",
    answeredCount: PANSS_ITEMS.length,
    scores: { positive, negative, general, total: positive + negative + general },
  };
}

function serializeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot serialize non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot serialize JSON value of type ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Cannot serialize cyclic JSON value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serializeJson(entry, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cannot serialize non-plain object as JSON");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJson(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableSerialize(value: JsonValue): string {
  return serializeJson(value, new Set());
}

export const PRESENTATION_STATUSES = ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"] as const;
export const TRIAL_RESPONSES = [
  "FULL_RESPONSE",
  "PARTIAL_RESPONSE",
  "NO_RESPONSE",
  "WORSENED",
  "UNKNOWN",
] as const;
export const COMORBIDITY_RULE_RESULT_KINDS = [
  "CONTRAINDICATION",
  "CAUTION",
  "MONITORING_REQUIREMENT",
  "BN_ROUTING_FACT",
] as const;

const optionalClinicalText = (maxLength: number) =>
  Type.Optional(Type.String({ minLength: 1, maxLength }));

export const AdverseEffectTermInputSchema = Type.Object(
  {
    termId: Type.String({
      pattern: "^(?:OTHER|[A-Za-z0-9][A-Za-z0-9._-]{0,199})$",
      maxLength: 200,
    }),
    label: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { $id: "insight.adverse-effect-term-input.v1", additionalProperties: false },
);
export type AdverseEffectTermInput = Static<typeof AdverseEffectTermInputSchema>;

export const AdverseEffectCatalogInputSchema = Type.Object(
  { terms: Type.Array(AdverseEffectTermInputSchema, { minItems: 1, maxItems: 500 }) },
  { $id: "insight.adverse-effect-catalog-input.v1", additionalProperties: false },
);
export type AdverseEffectCatalogInput = Static<typeof AdverseEffectCatalogInputSchema>;

export const AdverseEffectCatalogVersionSchema = Type.Object(
  {
    id: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    terms: Type.Array(AdverseEffectTermInputSchema, { minItems: 1, maxItems: 500 }),
    createdByUserId: UuidSchema,
    createdAt: TimestampSchema,
    active: Type.Boolean(),
  },
  { $id: "insight.adverse-effect-catalog-version.v1", additionalProperties: false },
);
export type AdverseEffectCatalogVersion = Static<typeof AdverseEffectCatalogVersionSchema>;

const governedIdSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$",
  maxLength: 200,
});

export const MedicationCatalogEntryInputSchema = Type.Object(
  {
    canonicalId: governedIdSchema,
    preferredName: Type.String({ minLength: 1, maxLength: 500 }),
    synonyms: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { $id: "insight.medication-catalog-entry-input.v1", additionalProperties: false },
);
export type MedicationCatalogEntryInput = Static<typeof MedicationCatalogEntryInputSchema>;

export const MedicationCatalogInputSchema = Type.Object(
  { entries: Type.Array(MedicationCatalogEntryInputSchema, { minItems: 1, maxItems: 10_000 }) },
  { $id: "insight.medication-catalog-input.v1", additionalProperties: false },
);
export type MedicationCatalogInput = Static<typeof MedicationCatalogInputSchema>;

export const MedicationCatalogVersionSchema = Type.Object(
  {
    id: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    entries: Type.Array(MedicationCatalogEntryInputSchema, { minItems: 1, maxItems: 10_000 }),
    createdByUserId: UuidSchema,
    createdAt: TimestampSchema,
    active: Type.Boolean(),
  },
  { $id: "insight.medication-catalog-version.v1", additionalProperties: false },
);
export type MedicationCatalogVersion = Static<typeof MedicationCatalogVersionSchema>;

export const MedicationCatalogResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, catalog: MedicationCatalogVersionSchema },
  { $id: "insight.medication-catalog-response.v1", additionalProperties: false },
);

export const MedicationCatalogHistoryResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, versions: Type.Array(MedicationCatalogVersionSchema) },
  { $id: "insight.medication-catalog-history-response.v1", additionalProperties: false },
);

export const AdverseEffectCatalogResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    catalog: Type.Union([AdverseEffectCatalogVersionSchema, Type.Null()]),
  },
  { $id: "insight.adverse-effect-catalog-response.v1", additionalProperties: false },
);

export const AdverseEffectCatalogHistoryResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    versions: Type.Array(AdverseEffectCatalogVersionSchema),
  },
  { $id: "insight.adverse-effect-catalog-history-response.v1", additionalProperties: false },
);

export const ComorbidityTermInputSchema = Type.Object(
  {
    termId: governedIdSchema,
    label: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { $id: "insight.comorbidity-term-input.v1", additionalProperties: false },
);
export type ComorbidityTermInput = Static<typeof ComorbidityTermInputSchema>;

export const ComorbidityRuleResultDefinitionSchema = Type.Object(
  {
    kind: Type.Union(COMORBIDITY_RULE_RESULT_KINDS.map((value) => Type.Literal(value))),
    targetId: governedIdSchema,
    value: Type.String({ minLength: 1, maxLength: 500 }),
    explanation: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type ComorbidityRuleResultDefinition = Static<typeof ComorbidityRuleResultDefinitionSchema>;

export const ComorbidityRuleInputSchema = Type.Object(
  {
    ruleId: governedIdSchema,
    allOfTermIds: Type.Array(governedIdSchema, { minItems: 1, maxItems: 100 }),
    results: Type.Array(ComorbidityRuleResultDefinitionSchema, { minItems: 1, maxItems: 100 }),
  },
  { $id: "insight.comorbidity-rule-input.v1", additionalProperties: false },
);
export type ComorbidityRuleInput = Static<typeof ComorbidityRuleInputSchema>;

export const ClinicalReviewerRecordSchema = Type.Object(
  {
    reviewerId: Type.String({ minLength: 1, maxLength: 200 }),
    reviewedAt: TimestampSchema,
    recordReference: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type ClinicalReviewerRecord = Static<typeof ClinicalReviewerRecordSchema>;

export const ComorbidityKnowledgeInputSchema = Type.Object(
  {
    sourceReference: Type.String({ minLength: 1, maxLength: 1000 }),
    reviewerRecord: ClinicalReviewerRecordSchema,
    terms: Type.Array(ComorbidityTermInputSchema, { minItems: 1, maxItems: 500 }),
    rules: Type.Array(ComorbidityRuleInputSchema, { maxItems: 1000 }),
  },
  { $id: "insight.comorbidity-knowledge-input.v1", additionalProperties: false },
);
export type ComorbidityKnowledgeInput = Static<typeof ComorbidityKnowledgeInputSchema>;

export const ComorbidityKnowledgeVersionSchema = Type.Object(
  {
    id: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    ...ComorbidityKnowledgeInputSchema.properties,
    createdByUserId: UuidSchema,
    createdAt: TimestampSchema,
    active: Type.Boolean(),
  },
  { $id: "insight.comorbidity-knowledge-version.v1", additionalProperties: false },
);
export type ComorbidityKnowledgeVersion = Static<typeof ComorbidityKnowledgeVersionSchema>;

export const ComorbidityKnowledgeResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    knowledge: Type.Union([ComorbidityKnowledgeVersionSchema, Type.Null()]),
  },
  { $id: "insight.comorbidity-knowledge-response.v1", additionalProperties: false },
);

export const ComorbidityKnowledgeHistoryResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    versions: Type.Array(ComorbidityKnowledgeVersionSchema),
  },
  { $id: "insight.comorbidity-knowledge-history-response.v1", additionalProperties: false },
);

export const DDI_SOURCE_LIFECYCLES = [
  "quarantined",
  "reviewed",
  "active",
  "superseded",
  "rejected",
] as const;

export const DdiPermissionRecordSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("granted"), Type.Literal("not_granted")]),
    basis: Type.String({ minLength: 1, maxLength: 2000 }),
    recordReference: Type.String({ minLength: 1, maxLength: 1000 }),
    coversStorage: Type.Boolean(),
    coversTransformation: Type.Boolean(),
    coversResearchUse: Type.Boolean(),
  },
  { $id: "insight.ddi-permission-record.v1", additionalProperties: false },
);
export type DdiPermissionRecord = Static<typeof DdiPermissionRecordSchema>;

export const DdiSourceManifestSchema = Type.Object(
  {
    drugIdentity: governedIdSchema,
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    url: Type.String({ minLength: 1, maxLength: 2000 }),
    publisher: Type.String({ minLength: 1, maxLength: 500 }),
    retrievedAt: TimestampSchema,
    contentDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    parserVersion: Type.String({ minLength: 1, maxLength: 200 }),
    transformVersion: Type.String({ minLength: 1, maxLength: 200 }),
    reviewerId: Type.String({ minLength: 1, maxLength: 200 }),
    reviewedAt: TimestampSchema,
    reviewReference: Type.String({ minLength: 1, maxLength: 1000 }),
    permission: DdiPermissionRecordSchema,
    lifecycle: Type.Literal("quarantined"),
  },
  { $id: "insight.ddi-source-manifest.v1", additionalProperties: false },
);
export type DdiSourceManifest = Static<typeof DdiSourceManifestSchema>;

export const DdiEvidenceReferenceSchema = Type.Object(
  {
    sourceSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    lineStart: Type.Integer({ minimum: 1 }),
    lineEnd: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const DdiExtractedInteractionSchema = Type.Object(
  {
    interactingDrugIdentity: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    severity: Type.Union([
      Type.Literal("contraindicated"),
      Type.Literal("serious"),
      Type.Literal("monitor_closely"),
      Type.Literal("minor"),
    ]),
    evidenceText: Type.String({ minLength: 1, maxLength: 20_000 }),
    mechanism: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    clinicalEffect: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    recommendedAction: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    evidenceReference: DdiEvidenceReferenceSchema,
  },
  { additionalProperties: false },
);
export type DdiExtractedInteraction = Static<typeof DdiExtractedInteractionSchema>;

export const DdiSourceVersionSchema = Type.Object(
  {
    id: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    manifest: DdiSourceManifestSchema,
    artifact: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        mediaType: Type.Literal("text/plain; charset=utf-8"),
        byteLength: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    interactions: Type.Array(DdiExtractedInteractionSchema, { maxItems: 10_000 }),
    lifecycle: Type.Union(DDI_SOURCE_LIFECYCLES.map((value) => Type.Literal(value))),
    importedByUserId: UuidSchema,
    importedAt: TimestampSchema,
    legalApprovalReference: Type.Union([
      Type.String({ minLength: 1, maxLength: 1000 }),
      Type.Null(),
    ]),
    clinicalApprovalReference: Type.Union([
      Type.String({ minLength: 1, maxLength: 1000 }),
      Type.Null(),
    ]),
  },
  { $id: "insight.ddi-source-version.v1", additionalProperties: false },
);
export type DdiSourceVersion = Static<typeof DdiSourceVersionSchema>;

export const DdiSourceResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, source: DdiSourceVersionSchema },
  { $id: "insight.ddi-source-response.v1", additionalProperties: false },
);

export const DdiSourceHistoryResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, sources: Type.Array(DdiSourceVersionSchema) },
  { $id: "insight.ddi-source-history-response.v1", additionalProperties: false },
);

export const BnGovernanceMetadataSchema = Type.Object(
  {
    status: Type.String({ minLength: 1, maxLength: 200 }),
    reference: Type.String({ minLength: 1, maxLength: 1000 }),
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type BnGovernanceMetadata = Static<typeof BnGovernanceMetadataSchema>;

export const BnDiagnosticSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 200 }),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
    category: Type.Union(
      ["xml", "structure", "reference", "probability", "value", "compatibility"].map((value) =>
        Type.Literal(value),
      ),
    ),
    message: Type.String({ minLength: 1 }),
    networkIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    variableName: Type.Optional(Type.String()),
    definitionFor: Type.Optional(Type.String()),
    parentConfigurationIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    tableIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    path: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    column: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const BnGraphNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("nature"), Type.Literal("decision"), Type.Literal("utility")]),
    outcomes: Type.Array(Type.String(), { maxItems: 10_000 }),
    parents: Type.Array(Type.String(), { maxItems: 10_000 }),
    properties: Type.Array(Type.String(), { maxItems: 10_000 }),
    tableValueCount: Type.Integer({ minimum: 0 }),
    position: Type.Union([
      Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const BnGraphNetworkSchema = Type.Object(
  {
    name: Type.String(),
    nodes: Type.Array(BnGraphNodeSchema, { maxItems: 10_000 }),
    edges: Type.Array(
      Type.Object(
        {
          source: Type.String({ minLength: 1 }),
          target: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100_000 },
    ),
  },
  { additionalProperties: false },
);

export const BnModelVersionSchema = Type.Object(
  {
    id: UuidSchema,
    pathwayIdentity: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
    version: Type.Integer({ minimum: 1 }),
    lifecycle: Type.Union(
      ["IMPORTED", "REJECTED", "QUARANTINED", "ACTIVE", "SUPERSEDED", "DISABLED"].map((value) =>
        Type.Literal(value),
      ),
    ),
    quarantineReason: Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()]),
    source: Type.Object(
      {
        fileName: Type.String({ minLength: 1, maxLength: 500 }),
        mediaType: Type.Literal("application/xml"),
        byteLength: Type.Integer({ minimum: 1 }),
        contentSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        semanticSha256: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
        topologySha256: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
        importerVersion: Type.String({ minLength: 1, maxLength: 200 }),
        importedByUserId: UuidSchema,
        importedAt: TimestampSchema,
      },
      { additionalProperties: false },
    ),
    validation: Type.Object(
      {
        softwareCompatible: Type.Boolean(),
        clinicalValidity: Type.Literal("NOT_ESTABLISHED"),
        checks: Type.Array(
          Type.Object(
            {
              code: Type.String({ minLength: 1, maxLength: 200 }),
              passed: Type.Boolean(),
              detail: Type.String({ minLength: 1, maxLength: 4000 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 1000 },
        ),
        diagnostics: Type.Array(BnDiagnosticSchema, { maxItems: 100_000 }),
      },
      { additionalProperties: false },
    ),
    evidence: BnGovernanceMetadataSchema,
    calibration: BnGovernanceMetadataSchema,
    clinicalReview: BnGovernanceMetadataSchema,
    networks: Type.Array(BnGraphNetworkSchema, { maxItems: 100 }),
  },
  { $id: "insight.bn-model-version.v1", additionalProperties: false },
);
export type BnModelVersion = Static<typeof BnModelVersionSchema>;

export const BnModelResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, model: BnModelVersionSchema },
  { $id: "insight.bn-model-response.v1", additionalProperties: false },
);

export const BnModelHistoryResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, models: Type.Array(BnModelVersionSchema) },
  { $id: "insight.bn-model-history-response.v1", additionalProperties: false },
);

export const BnModelSourceResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    modelId: UuidSchema,
    sourceXml: Type.String({ minLength: 1, maxLength: 20_000_000 }),
  },
  { $id: "insight.bn-model-source-response.v1", additionalProperties: false },
);

const catalogReferenceSchema = Type.Object(
  {
    catalogVersionId: Type.String({ minLength: 1, maxLength: 200 }),
    termId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const CurrentMedicationInputSchema = Type.Object(
  {
    rawMedication: Type.String({ minLength: 1, maxLength: 500 }),
    dose: optionalClinicalText(100),
    doseUnit: optionalClinicalText(100),
    route: optionalClinicalText(100),
    frequency: optionalClinicalText(200),
  },
  { additionalProperties: false },
);
export type CurrentMedicationInput = Static<typeof CurrentMedicationInputSchema>;

export const AntipsychoticTrialInputSchema = Type.Object(
  {
    medication: Type.String({ minLength: 1, maxLength: 500 }),
    dose: optionalClinicalText(100),
    doseUnit: optionalClinicalText(100),
    route: optionalClinicalText(100),
    frequency: optionalClinicalText(200),
    treatmentStart: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    treatmentEnd: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    approximatePeriod: optionalClinicalText(500),
    response: Type.Optional(Type.Union(TRIAL_RESPONSES.map((value) => Type.Literal(value)))),
    adverseEffects: Type.Optional(Type.Array(catalogReferenceSchema, { maxItems: 100 })),
    otherAdverseEffectDetail: Type.Optional(Type.String({ maxLength: 2000 })),
    discontinuationReason: optionalClinicalText(2000),
    notes: optionalClinicalText(5000),
  },
  { additionalProperties: false },
);
export type AntipsychoticTrialInput = Static<typeof AntipsychoticTrialInputSchema>;

export const ComorbiditySelectionInputSchema = Type.Object(
  {
    ...catalogReferenceSchema.properties,
    supplementalText: optionalClinicalText(2000),
  },
  { additionalProperties: false },
);
export type ComorbiditySelectionInput = Static<typeof ComorbiditySelectionInputSchema>;

export const ComorbiditySelectionRecordSchema = Type.Object(
  {
    ...ComorbiditySelectionInputSchema.properties,
    label: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const ComorbidityRuleResultSchema = Type.Object(
  {
    knowledgeVersionId: UuidSchema,
    knowledgeVersion: Type.Integer({ minimum: 1 }),
    ruleId: governedIdSchema,
    kind: Type.Union(COMORBIDITY_RULE_RESULT_KINDS.map((value) => Type.Literal(value))),
    targetId: governedIdSchema,
    value: Type.String({ minLength: 1, maxLength: 500 }),
    explanation: Type.String({ minLength: 1, maxLength: 2000 }),
    matchedTermIds: Type.Array(governedIdSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type ComorbidityRuleResult = Static<typeof ComorbidityRuleResultSchema>;

export const ComorbidityRuleEvaluationSchema = Type.Object(
  {
    knowledgeVersionId: UuidSchema,
    knowledgeVersion: Type.Integer({ minimum: 1 }),
    results: Type.Array(ComorbidityRuleResultSchema, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
export type ComorbidityRuleEvaluation = Static<typeof ComorbidityRuleEvaluationSchema>;

export const MedicalHistoryInputSchema = Type.Object(
  {
    presentationStatus: Type.Union(PRESENTATION_STATUSES.map((value) => Type.Literal(value))),
    previouslyTreated: Type.Optional(Type.Boolean()),
    priorTrials: Type.Optional(Type.Array(AntipsychoticTrialInputSchema, { maxItems: 100 })),
    currentMedications: Type.Array(CurrentMedicationInputSchema, { maxItems: 100 }),
    comorbidities: Type.Array(ComorbiditySelectionInputSchema, { maxItems: 100 }),
    supplementalNotes: optionalClinicalText(10000),
  },
  { $id: "insight.medical-history-input.v1", additionalProperties: false },
);
export type MedicalHistoryInput = Static<typeof MedicalHistoryInputSchema>;

const AntipsychoticTrialRecordSchema = Type.Object(
  {
    ...AntipsychoticTrialInputSchema.properties,
    normalizationState: Type.Optional(
      Type.Union([Type.Literal("NORMALIZED"), Type.Literal("UNKNOWN")]),
    ),
    canonicalMedicationId: optionalClinicalText(200),
    adverseEffects: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ...catalogReferenceSchema.properties,
            label: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
  },
  { additionalProperties: false },
);

const CurrentMedicationRecordSchema = Type.Object(
  {
    ...CurrentMedicationInputSchema.properties,
    normalizationState: Type.Optional(
      Type.Union([Type.Literal("NORMALIZED"), Type.Literal("UNKNOWN")]),
    ),
    canonicalMedicationId: optionalClinicalText(200),
  },
  { additionalProperties: false },
);

export const MedicalHistoryRecordSchema = Type.Object(
  {
    ...MedicalHistoryInputSchema.properties,
    priorTrials: Type.Optional(Type.Array(AntipsychoticTrialRecordSchema, { maxItems: 100 })),
    currentMedications: Type.Array(CurrentMedicationRecordSchema, { maxItems: 100 }),
    comorbidities: Type.Array(ComorbiditySelectionRecordSchema, { maxItems: 100 }),
    ruleEvaluation: Type.Union([ComorbidityRuleEvaluationSchema, Type.Null()]),
    researchCaseId: UuidSchema,
    revision: Type.Integer({ minimum: 1 }),
    createdByUserId: UuidSchema,
    updatedByUserId: UuidSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { $id: "insight.medical-history-record.v1", additionalProperties: false },
);
export type MedicalHistoryRecord = Static<typeof MedicalHistoryRecordSchema>;

export async function sha256Hex(input: string | Uint8Array): Promise<Sha256> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as Sha256;
}

export function hashCanonicalJson(value: JsonValue): Promise<Sha256> {
  return sha256Hex(stableSerialize(value));
}

export const JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export const JOB_EVENT_TYPES = [
  "QUEUED",
  "RUNNING",
  "PROGRESS",
  "RETRY_QUEUED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export const JobStatusSchema = Type.Union(JOB_STATUSES.map((value) => Type.Literal(value)));
export type JobStatus = Static<typeof JobStatusSchema>;

export const JobRecordSchema = Type.Object(
  {
    id: UuidSchema,
    jobType: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,99}$" }),
    researchCaseId: UuidSchema,
    status: JobStatusSchema,
    attemptCount: Type.Integer({ minimum: 0, maximum: 10 }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
    resultReference: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    provenanceReference: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    error: Type.Union([
      Type.Object(
        {
          code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
          message: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    createdAt: TimestampSchema,
    startedAt: Type.Union([TimestampSchema, Type.Null()]),
    completedAt: Type.Union([TimestampSchema, Type.Null()]),
    updatedAt: TimestampSchema,
  },
  { $id: "insight.job-record.v1", additionalProperties: false },
);
export type JobRecord = Static<typeof JobRecordSchema>;

export const JobResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, job: JobRecordSchema },
  { $id: "insight.job-response.v1", additionalProperties: false },
);
export type JobResponse = Static<typeof JobResponseSchema>;

export const MedicationNormalizationStatusResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    job: Type.Union([JobRecordSchema, Type.Null()]),
  },
  { $id: "insight.medication-normalization-status-response.v1", additionalProperties: false },
);
export type MedicationNormalizationStatusResponse = Static<
  typeof MedicationNormalizationStatusResponseSchema
>;

export const JobEventSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 20 }),
    jobId: UuidSchema,
    type: Type.Union(JOB_EVENT_TYPES.map((value) => Type.Literal(value))),
    progress: Type.Union([
      Type.Object(
        {
          code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
          completedUnits: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
          totalUnits: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    occurredAt: TimestampSchema,
  },
  { $id: "insight.job-event.v1", additionalProperties: false },
);
export type JobEvent = Static<typeof JobEventSchema>;

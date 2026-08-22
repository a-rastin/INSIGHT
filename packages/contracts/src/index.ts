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

export const HealthResponseSchema = Type.Object(
  { schemaVersion: SchemaVersionSchema, status: Type.Literal("ok") },
  { $id: "insight.health-response.v1", additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadinessResponseSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    status: Type.Literal("ready"),
    checks: Type.Object(
      {
        application: Type.Literal("ready"),
        database: Type.Literal("ready"),
        worker: Type.Literal("ready"),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "insight.readiness-response.v1", additionalProperties: false },
);
export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;

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
export const CONTRAINDICATION_OUTCOMES = [
  "CONTRAINDICATED",
  "CAUTION",
  "MONITORING_REQUIRED",
  "UNKNOWN",
] as const;

const optionalClinicalText = (maxLength: number) =>
  Type.Optional(Type.String({ minLength: 1, maxLength }));
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
    normalizationState: Type.Optional(
      Type.Union([Type.Literal("NORMALIZED"), Type.Literal("UNKNOWN")]),
    ),
    canonicalMedicationId: optionalClinicalText(200),
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
    normalizationState: Type.Optional(
      Type.Union([Type.Literal("NORMALIZED"), Type.Literal("UNKNOWN")]),
    ),
    canonicalMedicationId: optionalClinicalText(200),
    dose: optionalClinicalText(100),
    doseUnit: optionalClinicalText(100),
    treatmentStart: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    treatmentEnd: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    approximatePeriod: optionalClinicalText(500),
    response: Type.Optional(Type.Union(TRIAL_RESPONSES.map((value) => Type.Literal(value)))),
    adverseEffects: Type.Optional(Type.Array(catalogReferenceSchema, { maxItems: 100 })),
    otherAdverseEffectDetail: optionalClinicalText(2000),
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

export const ContraindicationOutputInputSchema = Type.Object(
  {
    ruleVersionId: Type.String({ minLength: 1, maxLength: 200 }),
    ruleId: Type.String({ minLength: 1, maxLength: 200 }),
    outcome: Type.Union(CONTRAINDICATION_OUTCOMES.map((value) => Type.Literal(value))),
    explanation: optionalClinicalText(2000),
  },
  { additionalProperties: false },
);
export type ContraindicationOutputInput = Static<typeof ContraindicationOutputInputSchema>;

export const MedicalHistoryInputSchema = Type.Object(
  {
    presentationStatus: Type.Union(PRESENTATION_STATUSES.map((value) => Type.Literal(value))),
    previouslyTreated: Type.Optional(Type.Boolean()),
    priorTrials: Type.Optional(Type.Array(AntipsychoticTrialInputSchema, { maxItems: 100 })),
    currentMedications: Type.Array(CurrentMedicationInputSchema, { maxItems: 100 }),
    comorbidities: Type.Array(ComorbiditySelectionInputSchema, { maxItems: 100 }),
    contraindications: Type.Array(ContraindicationOutputInputSchema, { maxItems: 200 }),
    supplementalNotes: optionalClinicalText(10000),
  },
  { $id: "insight.medical-history-input.v1", additionalProperties: false },
);
export type MedicalHistoryInput = Static<typeof MedicalHistoryInputSchema>;

export const MedicalHistoryRecordSchema = Type.Object(
  {
    ...MedicalHistoryInputSchema.properties,
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

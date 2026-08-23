import { createHash } from "node:crypto";

import {
  CssrsAnswersSchema,
  CssrsCalculationSchema,
  Dsm5trAnswersSchema,
  Dsm5trCalculationSchema,
  PanssAnswersSchema,
  PanssCalculationSchema,
  Sha256Schema,
  stableSerialize,
  type JsonValue,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { CssrsAssessmentRecord } from "../assessment/cssrs.js";
import type { Dsm5trAssessmentRecord } from "../assessment/dsm5tr.js";
import type { PanssAssessmentRecord } from "../assessment/panss.js";
import type { MedicalHistoryRecord } from "@insight/contracts";
import type { PatientRecord } from "../patient/patients.js";
import type { WorkflowState } from "../patient/workflow.js";

export const PROJECTION_VERSION = "1.0.0" as const;

export const PROJECTION_BY_STATE = Object.freeze({
  NORMALIZING_MEDICATIONS: "MEDICATION_NORMALIZATION",
  IMPUTING_BYPASSED_ASSESSMENTS: "ASSESSMENT_IMPUTATION",
  GENERATING_CPTS: "CPT_GENERATION",
  GENERATING_PRIMARY_PLAN: "PLAN_DRAFT",
} as const);

export type ProjectionType = (typeof PROJECTION_BY_STATE)[keyof typeof PROJECTION_BY_STATE];

export const OMITTED_FIELD_CLASSES = Object.freeze([
  "NAMES",
  "OFFICIAL_IDENTIFIERS",
  "PATIENT_AND_RESEARCH_CASE_UUIDS",
  "CONTACT_DATA",
  "ADDRESS_DATA",
  "EXACT_BIRTH_DATE",
  "REIDENTIFICATION_KEYS",
  "ATTRIBUTION_AND_TIMESTAMPS",
  "UNSTRUCTURED_CLINICAL_TEXT",
] as const);

export interface ProjectionSource {
  readonly patient: PatientRecord;
  readonly dsm5tr: Dsm5trAssessmentRecord;
  readonly panss: PanssAssessmentRecord;
  readonly cssrs: CssrsAssessmentRecord;
  readonly medicalHistory: MedicalHistoryRecord | null;
  readonly availableDomainResults: ReadonlySet<string>;
}

interface SafeMedication {
  readonly medicationEntryRef: string;
  readonly source: "CURRENT" | "PRIOR_TRIAL";
  readonly medication: string;
  readonly normalizationState: "NORMALIZED" | "UNKNOWN" | "PENDING";
  readonly canonicalMedicationId?: string;
  readonly response?: "FULL_RESPONSE" | "PARTIAL_RESPONSE" | "NO_RESPONSE" | "WORSENED" | "UNKNOWN";
}

interface AssessmentProjection {
  readonly assessmentType: "DSM5TR" | "PANSS" | "CSSRS_RECENT";
  readonly status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";
  readonly answers?: JsonValue;
  readonly calculation?: JsonValue;
  readonly psychiatristDecision?: string;
}

interface ClinicalContext {
  readonly demographics: {
    readonly ageAtResearchCaseStart: number;
    readonly sex: "MALE" | "FEMALE";
  };
  readonly presentationStatus: "FIRST_PRESENTATION" | "KNOWN_SCHIZOPHRENIA" | null;
  readonly previouslyTreated: boolean | null;
  readonly assessments: readonly AssessmentProjection[];
  readonly medications: readonly SafeMedication[];
  readonly comorbidityTermIds: readonly string[];
  readonly deterministicRuleResults: readonly {
    readonly kind: "CONTRAINDICATION" | "CAUTION" | "MONITORING_REQUIREMENT" | "BN_ROUTING_FACT";
    readonly targetId: string;
    readonly value: string;
    readonly matchedTermIds: readonly string[];
  }[];
}

export type ProjectionData =
  | { readonly medications: readonly SafeMedication[] }
  | ({ readonly purpose: "ASSESSMENT_IMPUTATION" } & ClinicalContext)
  | ({
      readonly purpose: "CPT_GENERATION";
      readonly assessmentImputationAvailable: boolean;
    } & ClinicalContext)
  | ({
      readonly purpose: "PLAN_DRAFT";
      readonly assessmentImputationAvailable: boolean;
      readonly bnInferenceAvailable: boolean;
      readonly primaryDdiAvailable: boolean;
    } & ClinicalContext);

export interface ModelVisibleProjection {
  readonly subjectRef: string;
  readonly projectionType: ProjectionType;
  readonly projectionVersion: typeof PROJECTION_VERSION;
  readonly data: ProjectionData;
  readonly omittedFieldClasses: readonly string[];
  readonly inputFingerprint: string;
}

const medicationSchema = Type.Object(
  {
    medicationEntryRef: Type.String({ pattern: "^(?:current|prior)-[1-9][0-9]*$" }),
    source: Type.Union([Type.Literal("CURRENT"), Type.Literal("PRIOR_TRIAL")]),
    medication: Type.String({ minLength: 1, maxLength: 200 }),
    normalizationState: Type.Union([
      Type.Literal("NORMALIZED"),
      Type.Literal("UNKNOWN"),
      Type.Literal("PENDING"),
    ]),
    canonicalMedicationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    response: Type.Optional(
      Type.Union([
        Type.Literal("FULL_RESPONSE"),
        Type.Literal("PARTIAL_RESPONSE"),
        Type.Literal("NO_RESPONSE"),
        Type.Literal("WORSENED"),
        Type.Literal("UNKNOWN"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const incompleteAssessmentSchema = (assessmentType: "DSM5TR" | "PANSS" | "CSSRS_RECENT") =>
  Type.Object(
    {
      assessmentType: Type.Literal(assessmentType),
      status: Type.Union([
        Type.Literal("NOT_STARTED"),
        Type.Literal("IN_PROGRESS"),
        Type.Literal("BYPASSED"),
      ]),
    },
    { additionalProperties: false },
  );
const assessmentSchema = Type.Union([
  incompleteAssessmentSchema("DSM5TR"),
  Type.Object(
    {
      assessmentType: Type.Literal("DSM5TR"),
      status: Type.Literal("COMPLETED"),
      answers: Dsm5trAnswersSchema,
      calculation: Dsm5trCalculationSchema,
      psychiatristDecision: Type.Union([
        Type.Literal("SCHIZOPHRENIA_CONFIRMED"),
        Type.Literal("SCHIZOPHRENIA_NOT_CONFIRMED"),
      ]),
    },
    { additionalProperties: false },
  ),
  incompleteAssessmentSchema("PANSS"),
  Type.Object(
    {
      assessmentType: Type.Literal("PANSS"),
      status: Type.Literal("COMPLETED"),
      answers: PanssAnswersSchema,
      calculation: PanssCalculationSchema,
    },
    { additionalProperties: false },
  ),
  incompleteAssessmentSchema("CSSRS_RECENT"),
  Type.Object(
    {
      assessmentType: Type.Literal("CSSRS_RECENT"),
      status: Type.Literal("COMPLETED"),
      answers: CssrsAnswersSchema,
      calculation: CssrsCalculationSchema,
    },
    { additionalProperties: false },
  ),
]);
const ruleResultSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("CONTRAINDICATION"),
      Type.Literal("CAUTION"),
      Type.Literal("MONITORING_REQUIREMENT"),
      Type.Literal("BN_ROUTING_FACT"),
    ]),
    targetId: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.String({ minLength: 1, maxLength: 200 }),
    matchedTermIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 }),
  },
  { additionalProperties: false },
);
const clinicalContextProperties = {
  demographics: Type.Object(
    {
      ageAtResearchCaseStart: Type.Integer({ minimum: 0, maximum: 130 }),
      sex: Type.Union([Type.Literal("MALE"), Type.Literal("FEMALE")]),
    },
    { additionalProperties: false },
  ),
  presentationStatus: Type.Union([
    Type.Literal("FIRST_PRESENTATION"),
    Type.Literal("KNOWN_SCHIZOPHRENIA"),
    Type.Null(),
  ]),
  previouslyTreated: Type.Union([Type.Boolean(), Type.Null()]),
  assessments: Type.Array(assessmentSchema, { minItems: 3, maxItems: 3 }),
  medications: Type.Array(medicationSchema, { maxItems: 200 }),
  comorbidityTermIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 }),
  deterministicRuleResults: Type.Array(ruleResultSchema, { maxItems: 1000 }),
} as const;

export const PROJECTION_DATA_SCHEMAS = Object.freeze({
  MEDICATION_NORMALIZATION: Type.Object(
    { medications: Type.Array(medicationSchema, { maxItems: 200 }) },
    { additionalProperties: false },
  ),
  ASSESSMENT_IMPUTATION: Type.Object(
    { purpose: Type.Literal("ASSESSMENT_IMPUTATION"), ...clinicalContextProperties },
    { additionalProperties: false },
  ),
  CPT_GENERATION: Type.Object(
    {
      purpose: Type.Literal("CPT_GENERATION"),
      ...clinicalContextProperties,
      assessmentImputationAvailable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  PLAN_DRAFT: Type.Object(
    {
      purpose: Type.Literal("PLAN_DRAFT"),
      ...clinicalContextProperties,
      assessmentImputationAvailable: Type.Boolean(),
      bnInferenceAvailable: Type.Boolean(),
      primaryDdiAvailable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
});

const omittedClassSchema = Type.Union([
  ...OMITTED_FIELD_CLASSES.map((value) => Type.Literal(value)),
  Type.Literal("UNSAFE_MEDICATION_TEXT"),
  Type.Literal("UNSAFE_CLINICAL_IDENTIFIER"),
  Type.Literal("UNSAFE_RULE_TEXT"),
]);
export const MODEL_VISIBLE_PROJECTION_SCHEMA = Type.Union(
  Object.entries(PROJECTION_DATA_SCHEMAS).map(([projectionType, data]) =>
    Type.Object(
      {
        subjectRef: Type.String({ pattern: "^[A-Za-z0-9_-]{24}$" }),
        projectionType: Type.Literal(projectionType),
        projectionVersion: Type.Literal(PROJECTION_VERSION),
        data,
        omittedFieldClasses: Type.Array(omittedClassSchema, { uniqueItems: true }),
        inputFingerprint: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  ),
);

export class DeidentificationError extends Error {
  constructor(message = "Model-visible content did not pass the privacy boundary.") {
    super(message);
    this.name = "DeidentificationError";
  }
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const URL = /\b(?:https?:\/\/|www\.)\S+/i;
const PHONE_OR_IDENTIFIER = /(?:\d[\s().+-]*){6,}/;
const CALENDAR_DATE = /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/;
const ADDRESS_OR_ID_LABEL =
  /\b(?:address|street|avenue|road|lane|postcode|postal|zip|phone|mobile|email|contact|dob|birth\s*date|mrn|national\s*(?:code|id)|passport|identifier|patient\s*id|case\s*id)\b/i;
const SAFE_CLINICAL_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} .,+%/'()_-]{0,199}$/u;
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;

function sensitiveValues(patient: PatientRecord): readonly string[] {
  return [
    patient.firstName,
    patient.lastName,
    `${patient.firstName} ${patient.lastName}`,
    patient.dateOfBirth,
    patient.officialIdentifier.type,
    patient.officialIdentifier.issuingAuthority,
    patient.officialIdentifier.value,
    patient.id,
    patient.researchCase.id,
  ].filter((value) => value.trim().length > 1);
}

export function isSafeModelVisibleString(
  value: string,
  forbiddenValues: readonly string[],
): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (normalized !== value || !SAFE_CLINICAL_TEXT.test(normalized)) return false;
  if (UUID.test(normalized) || EMAIL.test(normalized) || URL.test(normalized)) return false;
  if (PHONE_OR_IDENTIFIER.test(normalized) || CALENDAR_DATE.test(normalized)) return false;
  if (ADDRESS_OR_ID_LABEL.test(normalized)) return false;
  const folded = normalized.toLocaleLowerCase("en-US");
  return !forbiddenValues.some((forbidden) =>
    folded.includes(forbidden.normalize("NFKC").trim().toLocaleLowerCase("en-US")),
  );
}

function safeText(value: string | undefined, forbidden: readonly string[]): string | undefined {
  if (!value || !isSafeModelVisibleString(value, forbidden)) return undefined;
  return value;
}

function safeToken(value: string | undefined, forbidden: readonly string[]): string | undefined {
  return value && SAFE_TOKEN.test(value) && isSafeModelVisibleString(value, forbidden)
    ? value
    : undefined;
}

function medications(source: ProjectionSource, omitted: Set<string>): SafeMedication[] {
  const history = source.medicalHistory;
  if (!history) return [];
  const forbidden = sensitiveValues(source.patient);
  const output: SafeMedication[] = [];
  const add = (
    entry: {
      medication: string;
      normalizationState?: "NORMALIZED" | "UNKNOWN";
      canonicalMedicationId?: string;
      response?: SafeMedication["response"];
    },
    sourceType: SafeMedication["source"],
    position: number,
  ) => {
    const medication = safeText(entry.medication, forbidden);
    if (!medication) {
      omitted.add("UNSAFE_MEDICATION_TEXT");
      return;
    }
    const canonicalMedicationId = safeToken(entry.canonicalMedicationId, forbidden);
    if (entry.canonicalMedicationId && !canonicalMedicationId)
      omitted.add("UNSAFE_CLINICAL_IDENTIFIER");
    output.push({
      medicationEntryRef: `${sourceType === "CURRENT" ? "current" : "prior"}-${position + 1}`,
      source: sourceType,
      medication,
      normalizationState: entry.normalizationState ?? "PENDING",
      ...(canonicalMedicationId ? { canonicalMedicationId } : {}),
      ...(entry.response ? { response: entry.response } : {}),
    });
  };
  history.currentMedications.forEach((entry, index) =>
    add(
      {
        medication: entry.rawMedication,
        normalizationState: entry.normalizationState,
        canonicalMedicationId: entry.canonicalMedicationId,
      },
      "CURRENT",
      index,
    ),
  );
  history.priorTrials?.forEach((entry, index) => add(entry, "PRIOR_TRIAL", index));
  return output;
}

function assessments(source: ProjectionSource): AssessmentProjection[] {
  const records = [source.dsm5tr, source.panss, source.cssrs] as const;
  return records.map((record) => ({
    assessmentType: record.assessmentType,
    status: record.status,
    ...(record.status === "COMPLETED" && record.answers
      ? { answers: record.answers as JsonValue }
      : {}),
    ...(record.status === "COMPLETED" && record.calculation
      ? { calculation: record.calculation as JsonValue }
      : {}),
    ...(record.assessmentType === "DSM5TR" &&
    record.status === "COMPLETED" &&
    record.psychiatristDecision
      ? { psychiatristDecision: record.psychiatristDecision }
      : {}),
  }));
}

function clinicalContext(source: ProjectionSource, omitted: Set<string>): ClinicalContext {
  const forbidden = sensitiveValues(source.patient);
  const history = source.medicalHistory;
  const comorbidityTermIds = (history?.comorbidities ?? []).flatMap(({ termId }) => {
    const safe = safeToken(termId, forbidden);
    if (!safe) omitted.add("UNSAFE_CLINICAL_IDENTIFIER");
    return safe ? [safe] : [];
  });
  const deterministicRuleResults = (history?.ruleEvaluation?.results ?? []).flatMap((result) => {
    const targetId = safeToken(result.targetId, forbidden);
    const value = safeText(result.value, forbidden);
    const matchedTermIds = result.matchedTermIds.flatMap((termId) => {
      const safe = safeToken(termId, forbidden);
      return safe ? [safe] : [];
    });
    if (!targetId || !value || matchedTermIds.length !== result.matchedTermIds.length) {
      omitted.add("UNSAFE_RULE_TEXT");
      return [];
    }
    return [{ kind: result.kind, targetId, value, matchedTermIds }];
  });
  return {
    demographics: {
      ageAtResearchCaseStart: source.patient.researchCase.ageAtStart,
      sex: source.patient.sex,
    },
    presentationStatus: history?.presentationStatus ?? null,
    previouslyTreated: history?.previouslyTreated ?? null,
    assessments: assessments(source),
    medications: medications(source, omitted),
    comorbidityTermIds,
    deterministicRuleResults,
  };
}

function projectionTypeForState(state: WorkflowState): ProjectionType {
  const projectionType = PROJECTION_BY_STATE[state as keyof typeof PROJECTION_BY_STATE];
  if (!projectionType)
    throw new DeidentificationError("No context projection is allowed in this state.");
  return projectionType;
}

function assertNoSensitiveContent(value: JsonValue, forbiddenValues: readonly string[]): void {
  const visit = (entry: JsonValue): void => {
    if (typeof entry === "string" && !isSafeModelVisibleString(entry, forbiddenValues)) {
      throw new DeidentificationError();
    }
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
}

export function createProjection(
  subjectRef: string,
  state: WorkflowState,
  source: ProjectionSource,
): ModelVisibleProjection {
  if (!/^[A-Za-z0-9_-]{24}$/.test(subjectRef))
    throw new DeidentificationError("Subject reference is invalid.");
  const projectionType = projectionTypeForState(state);
  const omitted = new Set<string>(OMITTED_FIELD_CLASSES);
  const medicationProjection = () => ({ medications: medications(source, omitted) });
  const contextProjection = () => clinicalContext(source, omitted);
  const data: ProjectionData =
    projectionType === "MEDICATION_NORMALIZATION"
      ? medicationProjection()
      : projectionType === "ASSESSMENT_IMPUTATION"
        ? { purpose: "ASSESSMENT_IMPUTATION", ...contextProjection() }
        : projectionType === "CPT_GENERATION"
          ? {
              purpose: "CPT_GENERATION",
              ...contextProjection(),
              assessmentImputationAvailable:
                source.availableDomainResults.has("ASSESSMENT_IMPUTATION"),
            }
          : {
              purpose: "PLAN_DRAFT",
              ...contextProjection(),
              assessmentImputationAvailable:
                source.availableDomainResults.has("ASSESSMENT_IMPUTATION"),
              bnInferenceAvailable: source.availableDomainResults.has("BN_INFERENCE"),
              primaryDdiAvailable: source.availableDomainResults.has("PRIMARY_DDI"),
            };
  const fingerprintInput = {
    projectionType,
    projectionVersion: PROJECTION_VERSION,
    data,
    omittedFieldClasses: [...omitted].sort(),
  } as unknown as JsonValue;
  assertNoSensitiveContent(fingerprintInput, sensitiveValues(source.patient));
  const projection: ModelVisibleProjection = {
    subjectRef,
    projectionType,
    projectionVersion: PROJECTION_VERSION,
    data,
    omittedFieldClasses: [...omitted].sort(),
    inputFingerprint: createHash("sha256").update(stableSerialize(fingerprintInput)).digest("hex"),
  };
  if (!Value.Check(MODEL_VISIBLE_PROJECTION_SCHEMA, projection)) throw new DeidentificationError();
  return projection;
}

export function canonicalProjectionInput(projection: ModelVisibleProjection): string {
  return stableSerialize({
    projectionType: projection.projectionType,
    projectionVersion: projection.projectionVersion,
    data: projection.data,
    omittedFieldClasses: [...projection.omittedFieldClasses],
  } as unknown as JsonValue);
}

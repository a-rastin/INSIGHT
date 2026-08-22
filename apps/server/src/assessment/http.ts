import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  DSM5TR_DEFINITION,
  DSM5TR_INSTRUMENT_PIN,
  Dsm5trAnswersSchema,
  Dsm5trCalculationSchema,
  Dsm5trDefinitionSchema,
  Dsm5trPsychiatristDecisionSchema,
  PANSS_DEFINITION,
  PANSS_INSTRUMENT_PIN,
  PanssAnswersSchema,
  PanssCalculationSchema,
  PanssDefinitionSchema,
  type ApiError,
} from "@insight/contracts";
import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  Dsm5trAssessmentConflictError,
  Dsm5trAssessmentNotFoundError,
  getDsm5trAssessment,
  saveDsm5trAssessment,
} from "./dsm5tr.js";
import {
  PanssAssessmentConflictError,
  PanssAssessmentNotFoundError,
  getPanssAssessment,
  savePanssAssessment,
} from "./panss.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const paramsSchema = Type.Object(
  { patientId: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);

const saveSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
      mode: Type.Union([Type.Literal("SAVE"), Type.Literal("COMPLETE")]),
      expectedRevision: Type.Integer({ minimum: 1 }),
      answers: Dsm5trAnswersSchema,
      psychiatristDecision: Dsm5trPsychiatristDecisionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
      mode: Type.Literal("BYPASS"),
      expectedRevision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
]);
type SaveBody = Static<typeof saveSchema>;

const instrumentPinSchema = Type.Object(
  {
    instrumentId: Type.Literal(DSM5TR_INSTRUMENT_PIN.instrumentId),
    instrumentVersion: Type.Literal(DSM5TR_INSTRUMENT_PIN.instrumentVersion),
    schemaVersion: Type.Literal(DSM5TR_INSTRUMENT_PIN.schemaVersion),
    calculationVersion: Type.Literal(DSM5TR_INSTRUMENT_PIN.calculationVersion),
    sourceReference: Type.Literal(DSM5TR_INSTRUMENT_PIN.sourceReference),
    reviewReference: Type.Literal(DSM5TR_INSTRUMENT_PIN.reviewReference),
  },
  { additionalProperties: false },
);

const nullableTimestamp = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const nullableUuid = Type.Union([Type.String({ pattern: UUID_PATTERN }), Type.Null()]);
const assessmentSchema = Type.Object(
  {
    researchCaseId: Type.String({ pattern: UUID_PATTERN }),
    status: Type.Union([
      Type.Literal("NOT_STARTED"),
      Type.Literal("IN_PROGRESS"),
      Type.Literal("COMPLETED"),
      Type.Literal("BYPASSED"),
    ]),
    answers: Type.Union([Dsm5trAnswersSchema, Type.Null()]),
    calculation: Type.Union([Dsm5trCalculationSchema, Type.Null()]),
    psychiatristDecision: Type.Union([Dsm5trPsychiatristDecisionSchema, Type.Null()]),
    instrumentPin: instrumentPinSchema,
    createdByUserId: nullableUuid,
    updatedByUserId: nullableUuid,
    createdAt: nullableTimestamp,
    updatedAt: nullableTimestamp,
  },
  { additionalProperties: false },
);

const responseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    definition: Dsm5trDefinitionSchema,
    assessment: assessmentSchema,
  },
  { additionalProperties: false },
);

const panssSaveSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
      mode: Type.Union([Type.Literal("SAVE"), Type.Literal("COMPLETE")]),
      expectedRevision: Type.Integer({ minimum: 1 }),
      answers: PanssAnswersSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
      mode: Type.Literal("BYPASS"),
      expectedRevision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
]);
type PanssSaveBody = Static<typeof panssSaveSchema>;

const panssInstrumentPinSchema = Type.Object(
  {
    instrumentId: Type.Literal(PANSS_INSTRUMENT_PIN.instrumentId),
    instrumentVersion: Type.Literal(PANSS_INSTRUMENT_PIN.instrumentVersion),
    schemaVersion: Type.Literal(PANSS_INSTRUMENT_PIN.schemaVersion),
    calculationVersion: Type.Literal(PANSS_INSTRUMENT_PIN.calculationVersion),
    sourceReference: Type.Literal(PANSS_INSTRUMENT_PIN.sourceReference),
    reviewReference: Type.Literal(PANSS_INSTRUMENT_PIN.reviewReference),
  },
  { additionalProperties: false },
);

const panssAssessmentSchema = Type.Object(
  {
    researchCaseId: Type.String({ pattern: UUID_PATTERN }),
    status: Type.Union([
      Type.Literal("NOT_STARTED"),
      Type.Literal("IN_PROGRESS"),
      Type.Literal("COMPLETED"),
      Type.Literal("BYPASSED"),
    ]),
    answers: Type.Union([PanssAnswersSchema, Type.Null()]),
    calculation: Type.Union([PanssCalculationSchema, Type.Null()]),
    instrumentPin: panssInstrumentPinSchema,
    createdByUserId: nullableUuid,
    updatedByUserId: nullableUuid,
    createdAt: nullableTimestamp,
    updatedAt: nullableTimestamp,
  },
  { additionalProperties: false },
);

const panssResponseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    definition: PanssDefinitionSchema,
    assessment: panssAssessmentSchema,
  },
  { additionalProperties: false },
);

export const assessmentRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/dsm5tr",
      {
        schema: {
          operationId: "getDsm5trAssessment",
          tags: ["assessments"],
          params: paramsSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const assessment = await getDsm5trAssessment(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
          );
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            definition: DSM5TR_DEFINITION,
            assessment,
          });
        } catch (error) {
          return assessmentError(error, request, reply);
        }
      },
    );

    api.put<{ Params: { patientId: string }; Body: SaveBody }>(
      "/patients/:patientId/research-case/dsm5tr",
      {
        schema: {
          operationId: "saveDsm5trAssessment",
          tags: ["assessments"],
          params: paramsSchema,
          body: saveSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const assessment = await saveDsm5trAssessment(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
            request.body,
          );
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            definition: DSM5TR_DEFINITION,
            assessment,
          });
        } catch (error) {
          return assessmentError(error, request, reply);
        }
      },
    );

    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/panss",
      {
        schema: {
          operationId: "getPanssAssessment",
          tags: ["assessments"],
          params: paramsSchema,
          response: { 200: panssResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const assessment = await getPanssAssessment(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
          );
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            definition: PANSS_DEFINITION,
            assessment,
          });
        } catch (error) {
          return panssAssessmentError(error, request, reply);
        }
      },
    );

    api.put<{ Params: { patientId: string }; Body: PanssSaveBody }>(
      "/patients/:patientId/research-case/panss",
      {
        schema: {
          operationId: "savePanssAssessment",
          tags: ["assessments"],
          params: paramsSchema,
          body: panssSaveSchema,
          response: { 200: panssResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const assessment = await savePanssAssessment(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
            request.body,
          );
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            definition: PANSS_DEFINITION,
            assessment,
          });
        } catch (error) {
          return panssAssessmentError(error, request, reply);
        }
      },
    );
  };

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

async function assessmentError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof Dsm5trAssessmentNotFoundError) {
    return reply.status(404).send(errorBody(request, 404, "ASSESSMENT_NOT_FOUND", error.message));
  }
  if (error instanceof Dsm5trAssessmentConflictError) {
    return reply.status(409).send(errorBody(request, 409, "ASSESSMENT_CONFLICT", error.message));
  }
  throw error;
}

async function panssAssessmentError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof PanssAssessmentNotFoundError) {
    return reply.status(404).send(errorBody(request, 404, "ASSESSMENT_NOT_FOUND", error.message));
  }
  if (error instanceof PanssAssessmentConflictError) {
    return reply.status(409).send(errorBody(request, 409, "ASSESSMENT_CONFLICT", error.message));
  }
  throw error;
}

function errorBody(
  request: FastifyRequest,
  status: 404 | 409,
  code: "ASSESSMENT_NOT_FOUND" | "ASSESSMENT_CONFLICT",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

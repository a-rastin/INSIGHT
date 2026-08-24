import {
  ApiErrorSchema,
  ClinicianRegimenMedicationSchema,
  ClinicianRegimenInputSchema,
  CURRENT_SCHEMA_VERSION,
  PrimaryTreatmentPlanInputSchema,
  type ApiError,
  type ClinicianRegimenInput,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  ClinicianRegimenInputError,
  TreatmentPlanAuthorizationError,
  TreatmentPlanNotFoundError,
  getClinicianReview,
  saveClinicianRegimen,
} from "./review.js";
import {
  FinalPlanAuthorizationError,
  FinalPlanConflictError,
  FinalPlanDependencyError,
  FinalPlanInputError,
  FinalPlanNotFoundError,
  FinalPlanSchemaError,
  finalizeTreatmentPlan,
} from "./finalization.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const paramsSchema = Type.Object(
  { patientId: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);
const medicationOrNull = Type.Union([ClinicianRegimenMedicationSchema, Type.Null()]);
const reviewSchema = Type.Object(
  {
    draftRef: Type.String({ minLength: 1, maxLength: 200 }),
    draftRevision: Type.Integer({ minimum: 1 }),
    aiImputationNoticeVisible: Type.Boolean(),
    generatedPlan: PrimaryTreatmentPlanInputSchema,
    regimen: Type.Array(ClinicianRegimenMedicationSchema, { minItems: 1, maxItems: 100 }),
    diff: Type.Array(
      Type.Object(
        {
          field: Type.String({ minLength: 1, maxLength: 500 }),
          before: medicationOrNull,
          after: medicationOrNull,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    readiness: Type.Object(
      {
        status: Type.Union([
          Type.Literal("CHECKING"),
          Type.Literal("BLOCKED"),
          Type.Literal("READY"),
        ]),
        reason: Type.Union([
          Type.Literal("PENDING"),
          Type.Literal("FAILED"),
          Type.Literal("UNPROVEN"),
          Type.Null(),
        ]),
        executionRef: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
        findings: Type.Array(
          Type.Object(
            {
              leftCanonicalId: Type.String({ minLength: 1, maxLength: 200 }),
              rightCanonicalId: Type.String({ minLength: 1, maxLength: 200 }),
              severity: Type.String({ minLength: 1, maxLength: 500 }),
              mechanism: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
              clinicalEffect: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
              recommendedAction: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
              sourceRecordRef: Type.String({ minLength: 1, maxLength: 500 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 10_000 },
        ),
      },
      { additionalProperties: false },
    ),
    catalog: Type.Array(
      Type.Object(
        {
          canonicalMedicationId: Type.String({ minLength: 1, maxLength: 200 }),
          preferredName: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100_000 },
    ),
    primaryDdiExecutionRef: Type.String({ minLength: 1, maxLength: 200 }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const responseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    review: Type.Union([reviewSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
const finalizationBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
const finalPlanSchema = Type.Object(
  {
    id: Type.String({ pattern: UUID_PATTERN }),
    researchCaseId: Type.String({ pattern: UUID_PATTERN }),
    sequence: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("SUPERSEDED")]),
    predecessorId: Type.Union([Type.String({ pattern: UUID_PATTERN }), Type.Null()]),
    schemaVersion: Type.String({ minLength: 1 }),
    plan: Type.Record(Type.String(), Type.Unknown()),
    planHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sourceDraftRef: Type.String({ minLength: 1, maxLength: 200 }),
    sourceDraftRevision: Type.Integer({ minimum: 1 }),
    finalDdiExecutionRef: Type.String({ minLength: 1, maxLength: 200 }),
    provenance: Type.Record(Type.String(), Type.Unknown()),
    finalizedByUserId: Type.String({ pattern: UUID_PATTERN }),
    finalizedAt: Type.String({ format: "date-time" }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
const finalizationResponseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    finalPlan: finalPlanSchema,
  },
  { additionalProperties: false },
);

export const treatmentPlanRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/primary-plan",
      {
        schema: {
          operationId: "getPrimaryTreatmentPlanReview",
          tags: ["treatment-plan"],
          params: paramsSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            review: await getClinicianReview(
              pool,
              actor(getSession(request)!),
              request.params.patientId,
            ),
          });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.put<{ Params: { patientId: string }; Body: ClinicianRegimenInput }>(
      "/patients/:patientId/research-case/primary-plan",
      {
        schema: {
          operationId: "saveClinicianRegimen",
          tags: ["treatment-plan"],
          params: paramsSchema,
          body: ClinicianRegimenInputSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            review: await saveClinicianRegimen(
              pool,
              actor(getSession(request)!),
              request.params.patientId,
              request.body.regimen,
            ),
          });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{
      Params: { patientId: string };
      Body: { schemaVersion: typeof CURRENT_SCHEMA_VERSION; idempotencyKey: string };
    }>(
      "/patients/:patientId/research-case/final-plans",
      {
        schema: {
          operationId: "finalizeTreatmentPlan",
          tags: ["treatment-plan"],
          params: paramsSchema,
          body: finalizationBodySchema,
          response: { 200: finalizationResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            finalPlan: await finalizeTreatmentPlan(
              pool,
              actor(getSession(request)!),
              request.params.patientId,
              request.body.idempotencyKey,
              request.id,
            ),
          });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

const actor = (session: SessionContext) =>
  ({ id: session.user.id, role: session.user.role }) as const;

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const body = (status: 400 | 403 | 404 | 409, code: string, message: string): ApiError => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  });
  if (error instanceof ClinicianRegimenInputError) {
    return reply.status(400).send(body(400, "INVALID_REGIMEN", "Clinician regimen is invalid."));
  }
  if (error instanceof TreatmentPlanAuthorizationError) {
    return reply.status(403).send(body(403, "FORBIDDEN", "Request is not permitted."));
  }
  if (error instanceof TreatmentPlanNotFoundError) {
    return reply.status(404).send(body(404, "PLAN_NOT_FOUND", "Treatment plan was not found."));
  }
  if (error instanceof FinalPlanInputError || error instanceof FinalPlanSchemaError) {
    return reply.status(400).send(body(400, "FINAL_PLAN_INVALID", "Final plan is invalid."));
  }
  if (error instanceof FinalPlanAuthorizationError) {
    return reply.status(403).send(body(403, "FORBIDDEN", "Request is not permitted."));
  }
  if (error instanceof FinalPlanNotFoundError) {
    return reply.status(404).send(body(404, "PLAN_NOT_FOUND", "Treatment plan was not found."));
  }
  if (error instanceof FinalPlanConflictError || error instanceof FinalPlanDependencyError) {
    return reply
      .status(409)
      .send(body(409, "FINALIZATION_BLOCKED", "Treatment plan cannot be finalized."));
  }
  throw error;
}

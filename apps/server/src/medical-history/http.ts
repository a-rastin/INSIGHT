import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  MedicalHistoryInputSchema,
  MedicalHistoryRecordSchema,
  type ApiError,
  type MedicalHistoryInput,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  MedicalHistoryConflictError,
  MedicalHistoryInputError,
  MedicalHistoryNotFoundError,
  getMedicalHistory,
  saveMedicalHistory,
} from "./medical-history.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const paramsSchema = Type.Object(
  { patientId: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);
const saveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    expectedRevision: Type.Integer({ minimum: 1 }),
    history: MedicalHistoryInputSchema,
  },
  { additionalProperties: false },
);
const responseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    medicalHistory: Type.Union([MedicalHistoryRecordSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

interface SaveBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly expectedRevision: number;
  readonly history: MedicalHistoryInput;
}

export const medicalHistoryRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/medical-history",
      {
        schema: {
          operationId: "getMedicalHistory",
          tags: ["medical-history"],
          params: paramsSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const medicalHistory = await getMedicalHistory(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
          );
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, medicalHistory });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.put<{ Params: { patientId: string }; Body: SaveBody }>(
      "/patients/:patientId/research-case/medical-history",
      {
        schema: {
          operationId: "saveMedicalHistory",
          tags: ["medical-history"],
          params: paramsSchema,
          body: saveSchema,
          response: { 200: responseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const medicalHistory = await saveMedicalHistory(
            pool,
            actor(getSession(request)!),
            request.params.patientId,
            request.body.history,
            request.body.expectedRevision,
            request.id,
          );
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, medicalHistory });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 404 | 409,
  code: "INVALID_MEDICAL_HISTORY" | "PATIENT_NOT_FOUND" | "STALE_RESEARCH_CASE_REVISION",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof MedicalHistoryInputError) {
    return reply
      .status(400)
      .send(errorBody(request, 400, "INVALID_MEDICAL_HISTORY", "Medical history is invalid."));
  }
  if (error instanceof MedicalHistoryNotFoundError) {
    return reply
      .status(404)
      .send(errorBody(request, 404, "PATIENT_NOT_FOUND", "Patient was not found."));
  }
  if (error instanceof MedicalHistoryConflictError) {
    return reply
      .status(409)
      .send(
        errorBody(request, 409, "STALE_RESEARCH_CASE_REVISION", "Research Case revision is stale."),
      );
  }
  throw error;
}

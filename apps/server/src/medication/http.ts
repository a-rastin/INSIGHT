import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  MedicationCatalogHistoryResponseSchema,
  MedicationCatalogInputSchema,
  MedicationCatalogResponseSchema,
  type ApiError,
  type MedicationCatalogInput,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  getMedicationCatalogHistory,
  MedicationAuthorizationError,
  MedicationCatalogInputError,
  saveMedicationCatalog,
} from "./catalog.js";

const saveSchema = Type.Object(
  { schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION), catalog: MedicationCatalogInputSchema },
  { additionalProperties: false },
);

export const medicationCatalogRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get(
      "/admin/medication-catalog",
      {
        schema: {
          operationId: "getMedicationCatalogHistory",
          tags: ["administration"],
          response: { 200: MedicationCatalogHistoryResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            versions: await getMedicationCatalogHistory(pool, actor(getSession(request)!)),
          });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: { schemaVersion: "1"; catalog: MedicationCatalogInput } }>(
      "/admin/medication-catalog",
      {
        schema: {
          operationId: "saveMedicationCatalog",
          tags: ["administration"],
          body: saveSchema,
          response: { 201: MedicationCatalogResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const catalog = await saveMedicationCatalog(
            pool,
            actor(getSession(request)!),
            request.body.catalog,
          );
          return reply.status(201).send({ schemaVersion: CURRENT_SCHEMA_VERSION, catalog });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

const actor = (session: SessionContext) =>
  ({ id: session.user.id, role: session.user.role }) as const;

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const body = (status: 400 | 403, code: string, message: string): ApiError => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  });
  if (error instanceof MedicationCatalogInputError)
    return reply
      .status(400)
      .send(body(400, "INVALID_MEDICATION_CATALOG", "Medication catalog is invalid."));
  if (error instanceof MedicationAuthorizationError)
    return reply.status(403).send(body(403, "FORBIDDEN", "Request is not permitted."));
  throw error;
}

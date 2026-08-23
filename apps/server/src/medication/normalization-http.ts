import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  JobResponseSchema,
  MedicationNormalizationStatusResponseSchema,
  UuidSchema,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import { ModelEndpointNotConfiguredError } from "../model-endpoint/configuration.js";
import {
  getMedicationNormalizationJob,
  MedicationNormalizationUnavailableError,
  startMedicationNormalization,
} from "./normalization.js";

const params = Type.Object({ patientId: UuidSchema }, { additionalProperties: false });

export const medicationNormalizationRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/medication-normalization",
      {
        schema: {
          operationId: "getMedicationNormalization",
          tags: ["medication"],
          params,
          response: { 200: MedicationNormalizationStatusResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request) => ({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        job: await getMedicationNormalizationJob(
          pool,
          { id: getSession(request)!.user.id, role: getSession(request)!.user.role },
          request.params.patientId,
        ),
      }),
    );

    app.post<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case/medication-normalization",
      {
        schema: {
          operationId: "startMedicationNormalization",
          tags: ["medication"],
          params,
          body: Type.Object({}, { additionalProperties: false }),
          response: { 202: JobResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const session = getSession(request)!;
        try {
          const job = await startMedicationNormalization(
            pool,
            { id: session.user.id, role: session.user.role },
            request.params.patientId,
          );
          return reply.status(202).send({ schemaVersion: CURRENT_SCHEMA_VERSION, job });
        } catch (error) {
          if (
            !(error instanceof MedicationNormalizationUnavailableError) &&
            !(error instanceof ModelEndpointNotConfiguredError)
          ) {
            throw error;
          }
          throw Object.assign(new Error("Medication normalization is unavailable."), {
            statusCode: 409,
          });
        }
      },
    );
  };

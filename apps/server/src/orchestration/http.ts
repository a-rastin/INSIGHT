import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  JobResponseSchema,
  UuidSchema,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import { OrchestrationUnavailableError, startResearchCaseOrchestration } from "./orchestrator.js";

const params = Type.Object({ patientId: UuidSchema }, { additionalProperties: false });
const body = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const orchestrationRoutes = (
  pool: Pool,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync =>
  async function routes(app) {
    app.post<{ Params: { patientId: string }; Body: { idempotencyKey: string } }>(
      "/patients/:patientId/research-case/orchestration",
      {
        schema: {
          operationId: "startResearchCaseOrchestration",
          tags: ["orchestration"],
          params,
          body,
          response: { 202: JobResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const session = getSession(request)!;
        try {
          const job = await startResearchCaseOrchestration(
            pool,
            { id: session.user.id, role: session.user.role },
            request.params.patientId,
            request.body.idempotencyKey,
          );
          return reply.status(202).send({ schemaVersion: CURRENT_SCHEMA_VERSION, job });
        } catch (error) {
          if (!(error instanceof OrchestrationUnavailableError)) throw error;
          throw Object.assign(new Error("Research Case orchestration is unavailable."), {
            statusCode: 409,
          });
        }
      },
    );
  };

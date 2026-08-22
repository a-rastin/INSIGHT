import {
  ApiErrorSchema,
  ComorbidityKnowledgeHistoryResponseSchema,
  ComorbidityKnowledgeInputSchema,
  ComorbidityKnowledgeResponseSchema,
  CURRENT_SCHEMA_VERSION,
  type ApiError,
  type ComorbidityKnowledgeInput,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  ComorbidityKnowledgeAuthorizationError,
  ComorbidityKnowledgeInputError,
  getActiveComorbidityKnowledge,
  getComorbidityKnowledgeHistory,
  saveComorbidityKnowledge,
} from "./catalog.js";

const saveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    knowledge: ComorbidityKnowledgeInputSchema,
  },
  { additionalProperties: false },
);

interface SaveBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly knowledge: ComorbidityKnowledgeInput;
}

export const comorbidityKnowledgeRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get(
      "/comorbidity-knowledge",
      {
        schema: {
          operationId: "getActiveComorbidityKnowledge",
          tags: ["medical-history"],
          response: { 200: ComorbidityKnowledgeResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const knowledge = await getActiveComorbidityKnowledge(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, knowledge });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.get(
      "/admin/comorbidity-knowledge",
      {
        schema: {
          operationId: "getComorbidityKnowledgeHistory",
          tags: ["administration"],
          response: { 200: ComorbidityKnowledgeHistoryResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const versions = await getComorbidityKnowledgeHistory(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, versions });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: SaveBody }>(
      "/admin/comorbidity-knowledge",
      {
        schema: {
          operationId: "saveComorbidityKnowledge",
          tags: ["administration"],
          body: saveSchema,
          response: { 201: ComorbidityKnowledgeResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const knowledge = await saveComorbidityKnowledge(
            pool,
            actor(getSession(request)!),
            request.body.knowledge,
          );
          return reply.status(201).send({ schemaVersion: CURRENT_SCHEMA_VERSION, knowledge });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ComorbidityKnowledgeInputError) {
    return reply
      .status(400)
      .send(
        errorBody(
          request,
          400,
          "INVALID_COMORBIDITY_KNOWLEDGE",
          "Comorbidity knowledge is invalid.",
        ),
      );
  }
  if (error instanceof ComorbidityKnowledgeAuthorizationError) {
    return reply
      .status(403)
      .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
  }
  throw error;
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 403,
  code: "INVALID_COMORBIDITY_KNOWLEDGE" | "FORBIDDEN",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

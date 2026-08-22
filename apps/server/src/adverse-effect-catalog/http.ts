import {
  AdverseEffectCatalogHistoryResponseSchema,
  AdverseEffectCatalogInputSchema,
  AdverseEffectCatalogResponseSchema,
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  type AdverseEffectCatalogInput,
  type ApiError,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  AdverseEffectCatalogAuthorizationError,
  AdverseEffectCatalogInputError,
  getActiveAdverseEffectCatalog,
  getAdverseEffectCatalogHistory,
  saveAdverseEffectCatalog,
} from "./catalog.js";

const saveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    catalog: AdverseEffectCatalogInputSchema,
  },
  { additionalProperties: false },
);

interface SaveBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly catalog: AdverseEffectCatalogInput;
}

export const adverseEffectCatalogRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get(
      "/adverse-effect-catalog",
      {
        schema: {
          operationId: "getActiveAdverseEffectCatalog",
          tags: ["medical-history"],
          response: { 200: AdverseEffectCatalogResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const catalog = await getActiveAdverseEffectCatalog(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, catalog });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.get(
      "/admin/adverse-effect-catalog",
      {
        schema: {
          operationId: "getAdverseEffectCatalogHistory",
          tags: ["administration"],
          response: {
            200: AdverseEffectCatalogHistoryResponseSchema,
            default: ApiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          const versions = await getAdverseEffectCatalogHistory(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, versions });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: SaveBody }>(
      "/admin/adverse-effect-catalog",
      {
        schema: {
          operationId: "saveAdverseEffectCatalog",
          tags: ["administration"],
          body: saveSchema,
          response: { 201: AdverseEffectCatalogResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const catalog = await saveAdverseEffectCatalog(
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

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 403,
  code: "INVALID_ADVERSE_EFFECT_CATALOG" | "FORBIDDEN",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AdverseEffectCatalogInputError) {
    return reply
      .status(400)
      .send(
        errorBody(
          request,
          400,
          "INVALID_ADVERSE_EFFECT_CATALOG",
          "Adverse-effect catalog is invalid.",
        ),
      );
  }
  if (error instanceof AdverseEffectCatalogAuthorizationError) {
    return reply
      .status(403)
      .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
  }
  throw error;
}

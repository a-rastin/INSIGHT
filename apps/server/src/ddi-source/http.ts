import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  DdiSourceHistoryResponseSchema,
  DdiSourceManifestSchema,
  DdiSourceResponseSchema,
  type ApiError,
  type DdiSourceManifest,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  DdiSourceAuthorizationError,
  DdiSourceInputError,
  DdiSourceLifecycleError,
  activateDdiSource,
  getActiveDdiSources,
  getDdiSourceHistory,
  importDdiSource,
  reviewDdiSource,
} from "./governance.js";

const importSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    manifest: DdiSourceManifestSchema,
    artifactBase64: Type.String({ minLength: 1, maxLength: 20_000_000 }),
  },
  { additionalProperties: false },
);
const reviewSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    decision: Type.Union([Type.Literal("reviewed"), Type.Literal("rejected")]),
    reviewReference: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
const activationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    legalApprovalReference: Type.String({ minLength: 1, maxLength: 1000 }),
    clinicalApprovalReference: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
const sourceParamsSchema = Type.Object({ sourceId: Type.String({ format: "uuid" }) });

interface ImportBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly manifest: DdiSourceManifest;
  readonly artifactBase64: string;
}

interface ReviewBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly decision: "reviewed" | "rejected";
  readonly reviewReference: string;
}

interface ActivationBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly legalApprovalReference: string;
  readonly clinicalApprovalReference: string;
}

interface SourceParams {
  readonly sourceId: string;
}

export const ddiSourceRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
    artifactRoot: string,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get(
      "/ddi-sources/active",
      {
        schema: {
          operationId: "getActiveDdiSources",
          tags: ["ddi"],
          response: { 200: DdiSourceHistoryResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const sources = await getActiveDdiSources(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, sources });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.get(
      "/admin/ddi-sources",
      {
        schema: {
          operationId: "getDdiSourceHistory",
          tags: ["administration", "ddi"],
          response: { 200: DdiSourceHistoryResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const sources = await getDdiSourceHistory(pool, actor(getSession(request)!));
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, sources });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: ImportBody }>(
      "/admin/ddi-sources/import",
      {
        schema: {
          operationId: "importDdiSource",
          tags: ["administration", "ddi"],
          body: importSchema,
          response: { 201: DdiSourceResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const source = await importDdiSource(
            pool,
            actor(getSession(request)!),
            {
              manifest: request.body.manifest,
              artifact: decodeBase64(request.body.artifactBase64),
            },
            { artifactRoot },
          );
          return reply.status(201).send({ schemaVersion: CURRENT_SCHEMA_VERSION, source });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: ReviewBody; Params: SourceParams }>(
      "/admin/ddi-sources/:sourceId/review",
      {
        schema: {
          operationId: "reviewDdiSource",
          tags: ["administration", "ddi"],
          params: sourceParamsSchema,
          body: reviewSchema,
          response: { 200: DdiSourceResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const source = await reviewDdiSource(
            pool,
            actor(getSession(request)!),
            request.params.sourceId,
            request.body.decision,
            request.body.reviewReference,
          );
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, source });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: ActivationBody; Params: SourceParams }>(
      "/admin/ddi-sources/:sourceId/activate",
      {
        schema: {
          operationId: "activateDdiSource",
          tags: ["administration", "ddi"],
          params: sourceParamsSchema,
          body: activationSchema,
          response: { 200: DdiSourceResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const source = await activateDdiSource(
            pool,
            actor(getSession(request)!),
            request.params.sourceId,
            request.body,
          );
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, source });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DdiSourceInputError("Artifact must use canonical base64 encoding.");
  }
  return Buffer.from(value, "base64");
}

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof DdiSourceInputError) {
    return reply
      .status(400)
      .send(errorBody(request, 400, "INVALID_DDI_SOURCE", "DDI source is invalid."));
  }
  if (error instanceof DdiSourceLifecycleError) {
    return reply
      .status(409)
      .send(errorBody(request, 409, "DDI_SOURCE_NOT_ACTIVATABLE", "DDI source cannot activate."));
  }
  if (error instanceof DdiSourceAuthorizationError) {
    return reply
      .status(403)
      .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
  }
  throw error;
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 403 | 409,
  code: "INVALID_DDI_SOURCE" | "DDI_SOURCE_NOT_ACTIVATABLE" | "FORBIDDEN",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

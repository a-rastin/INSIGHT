import {
  ApiErrorSchema,
  BnGovernanceMetadataSchema,
  BnModelHistoryResponseSchema,
  BnModelResponseSchema,
  CURRENT_SCHEMA_VERSION,
  type ApiError,
  type BnGovernanceMetadata,
} from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  BnModelAuthorizationError,
  BnModelInputError,
  getBnModelHistory,
  importAndRegisterBnModel,
} from "./registry.js";

const importSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    pathwayIdentity: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
    fileName: Type.String({ minLength: 1, maxLength: 500 }),
    artifactBase64: Type.String({ minLength: 1, maxLength: 28_000_000 }),
    evidence: Type.Optional(BnGovernanceMetadataSchema),
    calibration: Type.Optional(BnGovernanceMetadataSchema),
    clinicalReview: Type.Optional(BnGovernanceMetadataSchema),
  },
  { additionalProperties: false },
);

interface ImportBody {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly pathwayIdentity: string;
  readonly fileName: string;
  readonly artifactBase64: string;
  readonly evidence?: BnGovernanceMetadata;
  readonly calibration?: BnGovernanceMetadata;
  readonly clinicalReview?: BnGovernanceMetadata;
}

export const bnModelRoutes =
  (
    pool: Pool,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
    artifactRoot: string,
  ): FastifyPluginAsync =>
  async (api) => {
    api.get(
      "/admin/bn-models",
      {
        schema: {
          operationId: "getBnModelHistory",
          tags: ["administration", "bayesian-models"],
          response: { 200: BnModelHistoryResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const models = await getBnModelHistory(pool, actor(getSession(request)!), artifactRoot);
          return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, models });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );

    api.post<{ Body: ImportBody }>(
      "/admin/bn-models/import",
      {
        bodyLimit: 30_000_000,
        schema: {
          operationId: "importBnModel",
          tags: ["administration", "bayesian-models"],
          body: importSchema,
          response: { 201: BnModelResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          const model = await importAndRegisterBnModel(
            pool,
            actor(getSession(request)!),
            {
              candidate: {
                pathwayIdentity: request.body.pathwayIdentity,
                artifactPath: request.body.fileName,
                version: 1,
              },
              source: decodeBase64(request.body.artifactBase64),
              evidence: request.body.evidence,
              calibration: request.body.calibration,
              clinicalReview: request.body.clinicalReview,
            },
            { artifactRoot },
          );
          return reply.status(201).send({ schemaVersion: CURRENT_SCHEMA_VERSION, model });
        } catch (error) {
          return sendError(error, request, reply);
        }
      },
    );
  };

function decodeBase64(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new BnModelInputError("Artifact must use canonical base64 encoding.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"));
  } catch {
    throw new BnModelInputError("Artifact must be valid UTF-8 XML.");
  }
}

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof BnModelInputError) {
    return reply
      .status(400)
      .send(errorBody(request, 400, "INVALID_BN_MODEL", "Bayesian model upload is invalid."));
  }
  if (error instanceof BnModelAuthorizationError) {
    return reply
      .status(403)
      .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
  }
  throw error;
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 403,
  code: "INVALID_BN_MODEL" | "FORBIDDEN",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

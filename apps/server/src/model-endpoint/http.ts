import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  ModelEndpointConfigurationResponseSchema,
  ModelEndpointReplaceRequestSchema,
  type ApiError,
  type ModelEndpointReplaceRequest,
} from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  ModelEndpointAuthorizationError,
  ModelEndpointInputError,
  ModelEndpointNotConfiguredError,
  checkModelEndpointCompatibility,
  clearModelEndpointCredential,
  getModelEndpointConfiguration,
  replaceModelEndpointConfiguration,
} from "./configuration.js";

export interface ModelEndpointHttpOptions {
  readonly pool: Pool;
  readonly allowDevelopmentLoopbackHttp?: boolean;
}

export function modelEndpointRoutes(
  options: ModelEndpointHttpOptions,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync {
  return async (api) => {
    api.get(
      "/admin/model-endpoint",
      {
        schema: {
          operationId: "getModelEndpointConfiguration",
          tags: ["administration"],
          response: { 200: ModelEndpointConfigurationResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) =>
        handle(request, reply, async () => ({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          configuration: await getModelEndpointConfiguration(
            options.pool,
            actor(getSession(request)!),
          ),
        })),
    );

    api.put<{ Body: ModelEndpointReplaceRequest }>(
      "/admin/model-endpoint",
      {
        schema: {
          operationId: "replaceModelEndpointConfiguration",
          tags: ["administration"],
          body: ModelEndpointReplaceRequestSchema,
          response: { 201: ModelEndpointConfigurationResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) =>
        handle(request, reply, async () => {
          const configuration = await replaceModelEndpointConfiguration(
            options.pool,
            actor(getSession(request)!),
            request.body,
            options.allowDevelopmentLoopbackHttp,
          );
          void checkModelEndpointCompatibility(options.pool, actor(getSession(request)!)).catch(
            () => undefined,
          );
          return reply.status(201).send({ schemaVersion: CURRENT_SCHEMA_VERSION, configuration });
        }),
    );

    api.delete(
      "/admin/model-endpoint/credential",
      {
        schema: {
          operationId: "clearModelEndpointCredential",
          tags: ["administration"],
          response: { 200: ModelEndpointConfigurationResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) =>
        handle(request, reply, async () => ({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          configuration: await clearModelEndpointCredential(
            options.pool,
            actor(getSession(request)!),
          ),
        })),
    );

    api.post(
      "/admin/model-endpoint/check",
      {
        schema: {
          operationId: "checkModelEndpointCompatibility",
          tags: ["administration"],
          response: { 200: ModelEndpointConfigurationResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) =>
        handle(request, reply, async () => ({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          configuration: await checkModelEndpointCompatibility(
            options.pool,
            actor(getSession(request)!),
          ),
        })),
    );
  };
}

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ModelEndpointInputError) {
      return reply
        .status(400)
        .send(
          errorBody(
            request,
            400,
            "INVALID_MODEL_ENDPOINT",
            "Model endpoint configuration is invalid.",
          ),
        );
    }
    if (error instanceof ModelEndpointNotConfiguredError) {
      return reply
        .status(409)
        .send(
          errorBody(
            request,
            409,
            "MODEL_ENDPOINT_NOT_CONFIGURED",
            "Model endpoint credential is not configured.",
          ),
        );
    }
    if (error instanceof ModelEndpointAuthorizationError) {
      return reply
        .status(403)
        .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
    }
    throw error;
  }
}

function errorBody(
  request: FastifyRequest,
  status: 400 | 403 | 409,
  code: string,
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  HealthResponseSchema,
  ReadinessResponseSchema,
  type ApiError,
  type HealthResponse,
  type ReadinessResponse,
} from "@insight/contracts";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyRequest,
} from "fastify";

const API_PREFIX = "/api/v1";

const SAFE_HTTP_ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: "BAD_REQUEST", message: "Request could not be processed." },
  401: { code: "UNAUTHORIZED", message: "Authentication is required." },
  403: { code: "FORBIDDEN", message: "Request is not permitted." },
  404: { code: "NOT_FOUND", message: "Resource was not found." },
  405: { code: "METHOD_NOT_ALLOWED", message: "Method is not allowed." },
  409: { code: "CONFLICT", message: "Request conflicts with current state." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content type is not supported." },
  429: { code: "TOO_MANY_REQUESTS", message: "Too many requests." },
};

interface ValidationDetail {
  instancePath?: string;
}

export interface AppOptions {
  readonly staticRoot?: string;
  readonly registerApiRoutes?: FastifyPluginAsync;
}

function errorBody(
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
  issues?: ApiError["error"]["issues"],
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: {
      status,
      code,
      message,
      requestId: request.id,
      ...(issues && issues.length > 0 ? { issues } : {}),
    },
  };
}

function validationIssues(error: FastifyError): ApiError["error"]["issues"] {
  const context = error.validationContext ?? "request";
  return (error.validation as ValidationDetail[] | undefined)
    ?.slice(0, 100)
    .map(({ instancePath }) => ({
      path: `/${context}${instancePath ?? ""}`.slice(0, 512),
      code: "INVALID_VALUE",
      message: "Value does not match the published contract.",
    }));
}

const apiRoutes: FastifyPluginAsync = async (api) => {
  api.get(
    "/health",
    {
      schema: {
        operationId: "getHealth",
        tags: ["operations"],
        response: { 200: HealthResponseSchema, default: ApiErrorSchema },
      },
    },
    async (): Promise<HealthResponse> => ({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      status: "ok",
    }),
  );

  api.get(
    "/ready",
    {
      schema: {
        operationId: "getReadiness",
        tags: ["operations"],
        response: { 200: ReadinessResponseSchema, default: ApiErrorSchema },
      },
    },
    async (): Promise<ReadinessResponse> => ({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      status: "ready",
      checks: { application: "ready" },
    }),
  );
};

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        allErrors: true,
        removeAdditional: false,
      },
    },
  });

  void app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "INSIGHT REST API",
        version: CURRENT_SCHEMA_VERSION,
      },
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  void app.register(apiRoutes, { prefix: API_PREFIX });
  if (options.registerApiRoutes) {
    void app.register(options.registerApiRoutes, { prefix: API_PREFIX });
  }

  app.get(
    `${API_PREFIX}/openapi.json`,
    {
      schema: {
        hide: true,
        response: {
          200: {
            type: "object",
            required: ["openapi", "info", "paths"],
            additionalProperties: true,
            properties: {
              openapi: { type: "string" },
              info: { type: "object", additionalProperties: true },
              paths: { type: "object", additionalProperties: true },
            },
          },
          default: ApiErrorSchema,
        },
      },
    },
    async () => app.swagger(),
  );

  if (options.staticRoot) {
    void app.register(fastifyStatic, {
      root: resolve(options.staticRoot),
      wildcard: true,
    });
  }

  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = error instanceof Error ? (error as FastifyError) : undefined;
    if (fastifyError?.validation) {
      return reply
        .status(400)
        .send(
          errorBody(
            request,
            400,
            "INVALID_REQUEST",
            "Request validation failed.",
            validationIssues(fastifyError),
          ),
        );
    }

    const requestedStatus = fastifyError?.statusCode;
    const status =
      typeof requestedStatus === "number" && requestedStatus >= 400 && requestedStatus < 500
        ? requestedStatus
        : 500;
    const safe = SAFE_HTTP_ERRORS[status] ?? {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
    };
    return reply.status(status).send(errorBody(request, status, safe.code, safe.message));
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (/^\/api\/v(?!1(?:\/|$))[^/]+(?:\/|$)/.test(request.url)) {
      return reply
        .status(404)
        .send(
          errorBody(
            request,
            404,
            "UNSUPPORTED_API_VERSION",
            "Requested API version is not supported.",
          ),
        );
    }

    if (request.url.startsWith("/api/")) {
      return reply
        .status(404)
        .send(errorBody(request, 404, "NOT_FOUND", "API resource was not found."));
    }

    if (options.staticRoot) {
      return reply.type("text/html").sendFile("index.html");
    }

    return reply.status(404).send(errorBody(request, 404, "NOT_FOUND", "Resource was not found."));
  });

  return app;
}

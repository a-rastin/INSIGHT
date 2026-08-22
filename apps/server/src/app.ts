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
import type { Pool } from "pg";

import { adverseEffectCatalogRoutes } from "./adverse-effect-catalog/http.js";
import { assessmentRoutes } from "./assessment/http.js";
import { comorbidityKnowledgeRoutes } from "./comorbidity-knowledge/http.js";
import {
  IdentifiedResearchModeDisabledError,
  assertIdentifiedPatientCreationAllowed,
} from "./deployment/evidence.js";
import { deploymentEvidenceRoutes } from "./deployment/http.js";
import { authenticationRoutes, type AuthenticationHttpOptions } from "./identity/http.js";
import {
  isValidCsrf,
  resolveSession,
  sessionTokenFromCookie,
  type SessionContext,
} from "./identity/sessions.js";
import { medicalHistoryRoutes } from "./medical-history/http.js";
import { patientRoutes } from "./patient/http.js";
import type { OfficialIdentifierConfiguration } from "./patient/patients.js";

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
  readonly readinessChecks?: () => Promise<ReadinessResponse["checks"]>;
  readonly authentication?: AuthenticationHttpOptions & { readonly pool: Pool };
  readonly patient?: {
    readonly officialIdentifier: OfficialIdentifierConfiguration;
    readonly artifactRoot?: string;
    readonly removePatientArtifacts?: (path: string) => Promise<void>;
    readonly logArtifactRemovalFailure?: (event: {
      readonly event: "PATIENT_ARTIFACT_REMOVAL_FAILED";
      readonly requestId: string;
    }) => void;
  };
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

const defaultReadinessChecks = async (): Promise<ReadinessResponse["checks"]> => ({
  application: "ready",
  database: "ready",
  worker: "ready",
});

const apiRoutes =
  (readinessChecks: () => Promise<ReadinessResponse["checks"]>): FastifyPluginAsync =>
  async (api) => {
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
        checks: await readinessChecks(),
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

  const requestSessions = new WeakMap<FastifyRequest, SessionContext>();
  if (options.authentication) {
    app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith(`${API_PREFIX}/`)) return;

      const path = request.url.split("?", 1)[0]!;
      const publicPaths = new Set([
        `${API_PREFIX}/health`,
        `${API_PREFIX}/ready`,
        `${API_PREFIX}/openapi.json`,
        `${API_PREFIX}/login`,
      ]);
      if (publicPaths.has(path)) return;

      const token = sessionTokenFromCookie(request.headers.cookie);
      const context = token ? await resolveSession(options.authentication!.pool, token) : null;
      if (!context) {
        await reply
          .status(401)
          .send(errorBody(request, 401, "UNAUTHORIZED", "Authentication is required."));
        return;
      }

      requestSessions.set(request, context);
      if (
        context.user.status === "PASSWORD_CHANGE_REQUIRED" &&
        ![
          `${API_PREFIX}/session`,
          `${API_PREFIX}/session/password`,
          `${API_PREFIX}/logout`,
        ].includes(path)
      ) {
        await reply
          .status(403)
          .send(errorBody(request, 403, "PASSWORD_CHANGE_REQUIRED", "Request is not permitted."));
        return;
      }

      const patientScoped =
        path === `${API_PREFIX}/patients` || path.startsWith(`${API_PREFIX}/patients/`);
      if (patientScoped && context.user.role === "ADMINISTRATOR") {
        await reply
          .status(403)
          .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
        return;
      }

      if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;

      const csrfHeader = request.headers["x-csrf-token"];
      const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
      if (!isValidCsrf(context, csrfToken)) {
        await reply
          .status(403)
          .send(errorBody(request, 403, "INVALID_CSRF", "Request is not permitted."));
        return;
      }

      if (request.method === "POST" && path === `${API_PREFIX}/patients`) {
        try {
          await assertIdentifiedPatientCreationAllowed(options.authentication!.pool);
        } catch (error) {
          if (!(error instanceof IdentifiedResearchModeDisabledError)) throw error;
          await reply
            .status(403)
            .send(
              errorBody(
                request,
                403,
                "IDENTIFIED_MODE_DISABLED",
                "Identified Patient creation is disabled.",
              ),
            );
        }
      }
    });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  void app.register(apiRoutes(options.readinessChecks ?? defaultReadinessChecks), {
    prefix: API_PREFIX,
  });
  if (options.registerApiRoutes) {
    void app.register(options.registerApiRoutes, { prefix: API_PREFIX });
  }
  if (options.authentication) {
    void app.register(
      deploymentEvidenceRoutes(options.authentication.pool, (request) =>
        requestSessions.get(request),
      ),
      { prefix: API_PREFIX },
    );
    void app.register(
      authenticationRoutes(options.authentication, (request) => requestSessions.get(request)),
      { prefix: API_PREFIX },
    );
    void app.register(
      adverseEffectCatalogRoutes(options.authentication.pool, (request) =>
        requestSessions.get(request),
      ),
      { prefix: API_PREFIX },
    );
    void app.register(
      comorbidityKnowledgeRoutes(options.authentication.pool, (request) =>
        requestSessions.get(request),
      ),
      { prefix: API_PREFIX },
    );
    if (options.patient) {
      void app.register(
        patientRoutes(
          {
            pool: options.authentication.pool,
            officialIdentifier: options.patient.officialIdentifier,
            artifactRoot: options.patient.artifactRoot ?? resolve("artifacts"),
            removePatientArtifacts: options.patient.removePatientArtifacts,
            logArtifactRemovalFailure: options.patient.logArtifactRemovalFailure,
          },
          (request) => requestSessions.get(request),
        ),
        { prefix: API_PREFIX },
      );
      void app.register(
        assessmentRoutes(options.authentication.pool, (request) => requestSessions.get(request)),
        { prefix: API_PREFIX },
      );
      void app.register(
        medicalHistoryRoutes(options.authentication.pool, (request) =>
          requestSessions.get(request),
        ),
        { prefix: API_PREFIX },
      );
    }
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

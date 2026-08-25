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
import { isSurfaceAuthorized } from "./authorization.js";
import { assessmentRoutes } from "./assessment/http.js";
import { auditRoutes } from "./audit/http.js";
import { databaseBackupRoutes, type BackupOptions } from "./backup.js";
import { bnModelRoutes } from "./bn-model/http.js";
import { comorbidityKnowledgeRoutes } from "./comorbidity-knowledge/http.js";
import { ddiSourceRoutes } from "./ddi-source/http.js";
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
import { jobRoutes } from "./jobs/http.js";
import { medicalHistoryRoutes } from "./medical-history/http.js";
import { medicationCatalogRoutes } from "./medication/http.js";
import { medicationNormalizationRoutes } from "./medication/normalization-http.js";
import { modelEndpointRoutes, type ModelEndpointHttpOptions } from "./model-endpoint/http.js";
import { orchestrationRoutes } from "./orchestration/http.js";
import { patientRoutes } from "./patient/http.js";
import type { OfficialIdentifierConfiguration } from "./patient/patients.js";
import { treatmentPlanRoutes } from "./treatment-plan/http.js";

const API_PREFIX = "/api/v1";
const DEFAULT_BODY_LIMIT = 1_048_576;
const MAX_HEADER_BYTES = 16_384;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

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
  431: { code: "REQUEST_HEADERS_TOO_LARGE", message: "Request headers are too large." },
};

interface ValidationDetail {
  instancePath?: string;
}

export interface AppOptions {
  readonly production?: boolean;
  readonly staticRoot?: string;
  readonly artifactRoot?: string;
  readonly registerApiRoutes?: FastifyPluginAsync;
  readonly readinessChecks?: () => Promise<ReadinessResponse["checks"]>;
  readonly maintenanceCheck?: () => Promise<boolean>;
  readonly authentication?: AuthenticationHttpOptions & { readonly pool: Pool };
  readonly modelEndpoint?: Omit<ModelEndpointHttpOptions, "pool">;
  readonly backup?: Omit<BackupOptions, "pool">;
  readonly rateLimit?: {
    readonly max?: number;
    readonly loginMax?: number;
    readonly windowMilliseconds?: number;
  };
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

function jsonWithinLimits(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    if (Array.isArray(current.value)) {
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const entry of Object.values(current.value)) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return true;
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
          response: {
            200: ReadinessResponseSchema,
            503: ReadinessResponseSchema,
            default: ApiErrorSchema,
          },
        },
      },
      async (_request, reply): Promise<ReadinessResponse> => {
        const checks = await readinessChecks();
        const status = Object.values(checks).every((check) => check === "ready")
          ? "ready"
          : "not_ready";
        void reply.status(status === "ready" ? 200 : 503);
        return { schemaVersion: CURRENT_SCHEMA_VERSION, status, checks };
      },
    );
  };

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: DEFAULT_BODY_LIMIT,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    routerOptions: { maxParamLength: 500 },
    ajv: {
      customOptions: {
        allErrors: true,
        removeAdditional: false,
      },
    },
  });

  const rateWindow = options.rateLimit?.windowMilliseconds ?? 60_000;
  const requestBuckets = new Map<string, { count: number; startedAt: number }>();
  app.addHook("onRequest", async (request, reply) => {
    const headerBytes = request.raw.rawHeaders.reduce(
      (total, header) => total + Buffer.byteLength(header),
      0,
    );
    if (headerBytes > MAX_HEADER_BYTES) {
      return reply
        .status(431)
        .send(
          errorBody(request, 431, "REQUEST_HEADERS_TOO_LARGE", "Request headers are too large."),
        );
    }

    const path = request.url.split("?", 1)[0]!;
    if (
      !path.startsWith(`${API_PREFIX}/`) ||
      [`${API_PREFIX}/health`, `${API_PREFIX}/ready`].includes(path)
    ) {
      return;
    }
    const login = path === `${API_PREFIX}/login`;
    const key = `${login ? "login" : "api"}:${request.ip}`;
    const now = Date.now();
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= rateWindow) {
      bucket = { count: 0, startedAt: now };
      requestBuckets.set(key, bucket);
    }
    const maximum = login ? (options.rateLimit?.loginMax ?? 10) : (options.rateLimit?.max ?? 300);
    if (bucket.count >= maximum) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil((rateWindow - (now - bucket.startedAt)) / 1_000))),
      );
      return reply
        .status(429)
        .send(errorBody(request, 429, "TOO_MANY_REQUESTS", "Too many requests."));
    }
    bucket.count += 1;
    if (requestBuckets.size > 10_000) requestBuckets.clear();
  });

  app.addHook("preValidation", async (request, reply) => {
    if (request.body !== undefined && !jsonWithinLimits(request.body)) {
      return reply
        .status(413)
        .send(errorBody(request, 413, "PAYLOAD_TOO_LARGE", "Request payload is too large."));
    }
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
  if (options.maintenanceCheck) {
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?", 1)[0]!;
      if ([`${API_PREFIX}/health`, `${API_PREFIX}/ready`].includes(path)) return;
      const maintenance = await options.maintenanceCheck!().catch(() => true);
      if (maintenance) {
        await reply
          .status(503)
          .send(errorBody(request, 503, "MAINTENANCE", "Service is in maintenance mode."));
      }
    });
  }
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

      const operationId = (request.routeOptions.schema as { operationId?: string } | undefined)
        ?.operationId;
      if (operationId && !isSurfaceAuthorized(operationId, context.user.role)) {
        await reply
          .status(403)
          .send(errorBody(request, 403, "FORBIDDEN", "Request is not permitted."));
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
    void reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    );
    void reply.header("permissions-policy", "camera=(), geolocation=(), microphone=()");
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    if (options.production) {
      void reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    if (request.url.startsWith(`${API_PREFIX}/`)) void reply.header("cache-control", "no-store");
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
      auditRoutes(options.authentication.pool, (request) => requestSessions.get(request)),
      { prefix: API_PREFIX },
    );
    if (options.backup) {
      void app.register(
        databaseBackupRoutes({ pool: options.authentication.pool, ...options.backup }, (request) =>
          requestSessions.get(request),
        ),
        { prefix: API_PREFIX },
      );
    }
    void app.register(
      authenticationRoutes(options.authentication, (request) => requestSessions.get(request)),
      { prefix: API_PREFIX },
    );
    void app.register(
      jobRoutes(options.authentication.pool, (request) => requestSessions.get(request)),
      { prefix: API_PREFIX },
    );
    void app.register(
      modelEndpointRoutes(
        { pool: options.authentication.pool, ...options.modelEndpoint },
        (request) => requestSessions.get(request),
      ),
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
    void app.register(
      ddiSourceRoutes(
        options.authentication.pool,
        (request) => requestSessions.get(request),
        options.artifactRoot ?? resolve("artifacts"),
      ),
      { prefix: API_PREFIX },
    );
    void app.register(
      bnModelRoutes(
        options.authentication.pool,
        (request) => requestSessions.get(request),
        options.artifactRoot ?? resolve("artifacts"),
      ),
      { prefix: API_PREFIX },
    );
    void app.register(
      medicationCatalogRoutes(options.authentication.pool, (request) =>
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
      void app.register(
        medicationNormalizationRoutes(options.authentication.pool, (request) =>
          requestSessions.get(request),
        ),
        { prefix: API_PREFIX },
      );
      void app.register(
        orchestrationRoutes(options.authentication.pool, (request) => requestSessions.get(request)),
        { prefix: API_PREFIX },
      );
      void app.register(
        treatmentPlanRoutes(
          options.authentication.pool,
          (request) => requestSessions.get(request),
          options.artifactRoot ?? resolve("artifacts"),
        ),
        { prefix: API_PREFIX },
      );
    }
  }

  app.get(
    `${API_PREFIX}/openapi.json`,
    {
      schema: {
        operationId: "getOpenApiDocument",
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

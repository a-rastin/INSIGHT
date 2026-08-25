import { ApiErrorSchema, CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import { queryClinicalAuditEvents, type ClinicalAuditQuery } from "./clinical.js";
import { queryOperationalAuditEvents, type OperationalAuditQuery } from "./operational.js";

type SessionResolver = (request: FastifyRequest) => SessionContext | undefined;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const paginationProperties = {
  offset: { type: "integer", minimum: 0, default: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  eventType: { type: "string", minLength: 1, maxLength: 100 },
  from: { type: "string", format: "date-time" },
  to: { type: "string", format: "date-time" },
} as const;

const metadataSchema = {
  anyOf: [
    { type: "null" },
    { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
  ],
} as const;

const operationalEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "eventType",
    "actorUserId",
    "target",
    "beforeMetadata",
    "afterMetadata",
    "requestId",
    "occurredAt",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    eventType: { type: "string" },
    actorUserId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
    target: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "id", "version"],
          properties: {
            type: { type: "string", enum: ["USER", "DEPLOYMENT_EVIDENCE", "MODEL_ENDPOINT"] },
            id: { type: "string" },
            version: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      ],
    },
    beforeMetadata: metadataSchema,
    afterMetadata: metadataSchema,
    requestId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
    occurredAt: { type: "string", format: "date-time" },
  },
} as const;

const clinicalEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "eventType",
    "patientLink",
    "targetVersion",
    "before",
    "after",
    "provenance",
    "actorUserId",
    "requestId",
    "occurredAt",
  ],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["PATIENT", "WORKFLOW"] },
    eventType: { type: "string" },
    patientLink: {
      type: "object",
      additionalProperties: false,
      required: ["patientId", "researchCaseId"],
      properties: {
        patientId: { type: "string", pattern: UUID_PATTERN },
        researchCaseId: { type: "string", pattern: UUID_PATTERN },
      },
    },
    targetVersion: { type: "integer", minimum: 1 },
    before: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }] },
    after: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }] },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["payloadReference", "domainResultIds", "details"],
      properties: {
        payloadReference: { anyOf: [{ type: "string" }, { type: "null" }] },
        domainResultIds: { type: "array", items: { type: "string" } },
        details: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }] },
      },
    },
    actorUserId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
    requestId: { type: "string", pattern: UUID_PATTERN },
    occurredAt: { type: "string", format: "date-time" },
  },
} as const;

function pageSchema(eventSchema: object) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "events", "page"],
    properties: {
      schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
      events: { type: "array", items: eventSchema },
      page: {
        type: "object",
        additionalProperties: false,
        required: ["offset", "limit", "total"],
        properties: {
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          total: { type: "integer", minimum: 0 },
        },
      },
    },
  } as const;
}

export function auditRoutes(pool: Pool, sessionFor: SessionResolver): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Querystring: OperationalAuditQuery }>(
      "/admin/operational-audit",
      {
        schema: {
          operationId: "listOperationalAudit",
          tags: ["audit"],
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              ...paginationProperties,
              targetType: {
                type: "string",
                enum: ["USER", "DEPLOYMENT_EVIDENCE", "MODEL_ENDPOINT"],
              },
            },
          },
          response: { 200: pageSchema(operationalEventSchema), default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const session = sessionFor(request);
        if (session?.user.role !== "ADMINISTRATOR") return forbidden(request, reply);
        const page = await queryOperationalAuditEvents(
          pool,
          { id: session.user.id, role: session.user.role },
          request.query,
        );
        return {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          events: page.events,
          page: { offset: page.offset, limit: page.limit, total: page.total },
        };
      },
    );

    app.get<{ Querystring: ClinicalAuditQuery }>(
      "/clinical-audit",
      {
        schema: {
          operationId: "listClinicalAudit",
          tags: ["audit"],
          querystring: {
            type: "object",
            additionalProperties: false,
            required: ["patientId"],
            properties: {
              ...paginationProperties,
              patientId: { type: "string", pattern: UUID_PATTERN },
              kind: { type: "string", enum: ["PATIENT", "WORKFLOW"] },
            },
          },
          response: { 200: pageSchema(clinicalEventSchema), default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const session = sessionFor(request);
        if (session?.user.role !== "PSYCHIATRIST") return forbidden(request, reply);
        const page = await queryClinicalAuditEvents(
          pool,
          { id: session.user.id, role: session.user.role },
          request.query,
        );
        return {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          events: page.events,
          page: { offset: page.offset, limit: page.limit, total: page.total },
        };
      },
    );
  };
}

function forbidden(request: FastifyRequest, reply: FastifyReply) {
  const body: ApiError = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: {
      status: 403,
      code: "FORBIDDEN",
      message: "Request is not permitted.",
      requestId: request.id,
    },
  };
  return reply.status(403).send(body);
}

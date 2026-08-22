import { ApiErrorSchema, CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  DeploymentEvidenceNotFoundError,
  DeploymentPrerequisitesIncompleteError,
  EXTERNAL_APPROVAL_NOTICE,
  activateIdentifiedResearchMode,
  getDeploymentGateStatus,
  recordDeploymentEvidence,
  type DeploymentEvidence,
  type DeploymentGateStatus,
  type EnvironmentStatus,
  type SecurityControls,
} from "./evidence.js";

interface EvidenceBody {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  responsibleAuthority: string;
  approvalBasis: string;
  approvalReference: string;
  approvalGrantedAt: string;
  approvalExpiresAt: string;
  environmentStatus: EnvironmentStatus;
  securityControls: SecurityControls;
}

interface VersionParams {
  version: number;
}

const securityControlsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "participantConsentOrWaiver",
    "administratorSeparation",
    "encryptionInTransit",
    "encryptionAtRest",
    "auditControls",
    "dataGovernanceRules",
    "modelDisclosureControls",
    "environmentSeparation",
  ],
  properties: {
    participantConsentOrWaiver: { type: "boolean" },
    administratorSeparation: { type: "boolean" },
    encryptionInTransit: { type: "boolean" },
    encryptionAtRest: { type: "boolean" },
    auditControls: { type: "boolean" },
    dataGovernanceRules: { type: "boolean" },
    modelDisclosureControls: { type: "boolean" },
    environmentSeparation: { type: "boolean" },
  },
} as const;

const evidenceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "responsibleAuthority",
    "approvalBasis",
    "approvalReference",
    "approvalGrantedAt",
    "approvalExpiresAt",
    "environmentStatus",
    "securityControls",
  ],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    responsibleAuthority: { type: "string", minLength: 1, maxLength: 500 },
    approvalBasis: { type: "string", minLength: 1, maxLength: 2000 },
    approvalReference: { type: "string", minLength: 1, maxLength: 500 },
    approvalGrantedAt: { type: "string", format: "date-time" },
    approvalExpiresAt: { type: "string", format: "date-time" },
    environmentStatus: {
      type: "string",
      enum: ["SYNTHETIC_OR_DEIDENTIFIED", "APPROVED_IDENTIFIED_RESEARCH"],
    },
    securityControls: securityControlsSchema,
  },
} as const;

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "responsibleAuthority",
    "approvalBasis",
    "approvalReference",
    "approvalGrantedAt",
    "approvalExpiresAt",
    "environmentStatus",
    "securityControls",
    "recordedByUserId",
    "recordedAt",
  ],
  properties: {
    version: { type: "integer", minimum: 1 },
    responsibleAuthority: { type: "string" },
    approvalBasis: { type: "string" },
    approvalReference: { type: "string" },
    approvalGrantedAt: { type: "string", format: "date-time" },
    approvalExpiresAt: { type: "string", format: "date-time" },
    environmentStatus: evidenceBodySchema.properties.environmentStatus,
    securityControls: securityControlsSchema,
    recordedByUserId: { type: "string", format: "uuid" },
    recordedAt: { type: "string", format: "date-time" },
  },
} as const;

const gateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "identifiedMode", "reason", "evidence", "notice"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    identifiedMode: { type: "string", enum: ["DISABLED", "ENABLED"] },
    reason: {
      type: "string",
      enum: [
        "ACTIVE",
        "NO_EVIDENCE",
        "EVIDENCE_CHANGED",
        "APPROVAL_NOT_YET_VALID",
        "APPROVAL_EXPIRED",
      ],
    },
    evidence: { anyOf: [evidenceSchema, { type: "null" }] },
    notice: { type: "string", const: EXTERNAL_APPROVAL_NOTICE },
  },
} as const;

const versionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: { version: { type: "integer", minimum: 1 } },
} as const;

function apiError(
  request: FastifyRequest,
  status: 403 | 404 | 409,
  code: string,
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

async function requireAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): Promise<SessionContext | undefined> {
  const context = getSession(request);
  if (context?.user.role === "ADMINISTRATOR") return context;
  await reply.status(403).send(apiError(request, 403, "FORBIDDEN", "Request is not permitted."));
  return undefined;
}

function evidenceBody(evidence: DeploymentEvidence) {
  return {
    ...evidence,
    approvalGrantedAt: evidence.approvalGrantedAt.toISOString(),
    approvalExpiresAt: evidence.approvalExpiresAt.toISOString(),
    recordedAt: evidence.recordedAt.toISOString(),
  };
}

function gateBody(status: DeploymentGateStatus) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    identifiedMode: status.identifiedMode,
    reason: status.reason,
    evidence: status.evidence ? evidenceBody(status.evidence) : null,
    notice: EXTERNAL_APPROVAL_NOTICE,
  };
}

export function deploymentEvidenceRoutes(
  pool: Pool,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync {
  return async (api) => {
    api.get(
      "/admin/deployment-evidence",
      {
        schema: {
          operationId: "getDeploymentEvidence",
          tags: ["administration"],
          response: { 200: gateResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        if (!(await requireAdministrator(request, reply, getSession))) return;
        return gateBody(await getDeploymentGateStatus(pool));
      },
    );

    api.post<{ Body: EvidenceBody }>(
      "/admin/deployment-evidence",
      {
        schema: {
          operationId: "recordDeploymentEvidence",
          tags: ["administration"],
          body: evidenceBodySchema,
          response: { 201: gateResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        await recordDeploymentEvidence(
          pool,
          administrator.user.id,
          {
            responsibleAuthority: request.body.responsibleAuthority.trim(),
            approvalBasis: request.body.approvalBasis.trim(),
            approvalReference: request.body.approvalReference.trim(),
            approvalGrantedAt: new Date(request.body.approvalGrantedAt),
            approvalExpiresAt: new Date(request.body.approvalExpiresAt),
            environmentStatus: request.body.environmentStatus,
            securityControls: request.body.securityControls,
          },
          request.id,
        );
        return reply.status(201).send(gateBody(await getDeploymentGateStatus(pool)));
      },
    );

    api.post<{ Params: VersionParams }>(
      "/admin/deployment-evidence/:version/activate",
      {
        schema: {
          operationId: "activateIdentifiedResearchMode",
          tags: ["administration"],
          params: versionParamsSchema,
          response: { 200: gateResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        try {
          return gateBody(
            await activateIdentifiedResearchMode(
              pool,
              administrator.user.id,
              request.params.version,
              request.id,
            ),
          );
        } catch (error) {
          if (error instanceof DeploymentEvidenceNotFoundError) {
            return reply
              .status(404)
              .send(apiError(request, 404, "EVIDENCE_NOT_FOUND", "Evidence was not found."));
          }
          if (error instanceof DeploymentPrerequisitesIncompleteError) {
            return reply
              .status(409)
              .send(
                apiError(
                  request,
                  409,
                  "DEPLOYMENT_PREREQUISITES_INCOMPLETE",
                  "Identified research mode prerequisites are incomplete.",
                ),
              );
          }
          throw error;
        }
      },
    );
  };
}

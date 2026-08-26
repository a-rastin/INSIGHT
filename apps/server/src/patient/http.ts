import { ApiErrorSchema, CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  PatientInputError,
  PatientNotFoundError,
  createOrOverwritePatient,
  deletePatient,
  getPatient,
  listPatients,
  savePatientDemographics,
  type OfficialIdentifierConfiguration,
  type PatientDemographics,
  type PatientInput,
  type PatientRecord,
} from "./patients.js";
import {
  WORKFLOW_COMMANDS,
  WORKFLOW_STATES,
  RequiredDomainResultError,
  ResearchCaseNotFoundError,
  StaleResearchCaseRevisionError,
  WorkflowTransitionError,
  getResearchCaseWorkflow,
  transitionResearchCase,
  type ResearchCaseWorkflow,
  type WorkflowCommand,
} from "./workflow.js";

interface PatientHttpOptions {
  readonly pool: Pool;
  readonly officialIdentifier: OfficialIdentifierConfiguration;
  readonly artifactRoot: string;
  readonly removePatientArtifacts?: (path: string) => Promise<void>;
  readonly logArtifactRemovalFailure?: (event: {
    readonly event: "PATIENT_ARTIFACT_REMOVAL_FAILED";
    readonly requestId: string;
  }) => void;
}

interface VersionedPatientInput extends PatientInput {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
}

interface VersionedDemographics extends PatientDemographics {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
}

interface VersionedTransitionCommand {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly command: WorkflowCommand;
  readonly expectedRevision: number;
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const NAME_PATTERN = "^[A-Za-z]+(?:[ '-][A-Za-z]+)*$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const response = (schema: object) => ({ 200: schema, default: ApiErrorSchema });

const deletionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "deletion"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    deletion: {
      type: "object",
      additionalProperties: false,
      required: ["databaseStatus", "artifactRemoval"],
      properties: {
        databaseStatus: { type: "string", const: "DELETED" },
        artifactRemoval: { type: "string", enum: ["SUCCEEDED", "FAILED"] },
      },
    },
  },
} as const;

const patientParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["patientId"],
  properties: { patientId: { type: "string", pattern: UUID_PATTERN } },
} as const;

function patientRecordSchema(configuration: OfficialIdentifierConfiguration) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "officialIdentifier",
      "firstName",
      "lastName",
      "dateOfBirth",
      "sex",
      "profileAge",
      "researchCase",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN },
      officialIdentifier: officialIdentifierSchema(configuration, true),
      firstName: { type: "string", minLength: 1, maxLength: 128 },
      lastName: { type: "string", minLength: 1, maxLength: 128 },
      dateOfBirth: { type: "string", pattern: DATE_PATTERN },
      sex: { type: "string", enum: ["MALE", "FEMALE"] },
      profileAge: { type: "integer", minimum: 0 },
      researchCase: {
        type: "object",
        additionalProperties: false,
        required: ["id", "startedAt", "ageAtStart"],
        properties: {
          id: { type: "string", pattern: UUID_PATTERN },
          startedAt: { type: "string", format: "date-time" },
          ageAtStart: { type: "integer", minimum: 0 },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  } as const;
}

function patientResponseSchema(configuration: OfficialIdentifierConfiguration) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "patient"],
    properties: {
      schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
      patient: patientRecordSchema(configuration),
    },
  } as const;
}

function patientListResponseSchema(configuration: OfficialIdentifierConfiguration) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "patients"],
    properties: {
      schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
      patients: { type: "array", items: patientRecordSchema(configuration) },
    },
  } as const;
}

function officialIdentifierSchema(
  configuration: OfficialIdentifierConfiguration,
  normalized: boolean,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: normalized ? ["type", "issuingAuthority", "value"] : ["value"],
    properties: {
      type: { type: "string", const: configuration.type },
      issuingAuthority: { type: "string", const: configuration.issuingAuthority },
      value: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        ...(normalized ? { pattern: configuration.pattern } : {}),
      },
    },
  } as const;
}

function demographicsProperties() {
  return {
    firstName: { type: "string", minLength: 1, maxLength: 128, pattern: NAME_PATTERN },
    lastName: { type: "string", minLength: 1, maxLength: 128, pattern: NAME_PATTERN },
    dateOfBirth: { type: "string", pattern: DATE_PATTERN },
    sex: { type: "string", enum: ["MALE", "FEMALE"] },
  } as const;
}

function patientBodySchema(configuration: OfficialIdentifierConfiguration) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "officialIdentifier",
      "firstName",
      "lastName",
      "dateOfBirth",
      "sex",
    ],
    properties: {
      schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
      officialIdentifier: officialIdentifierSchema(configuration, false),
      ...demographicsProperties(),
    },
  } as const;
}

const demographicsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "firstName", "lastName", "dateOfBirth", "sex"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    ...demographicsProperties(),
  },
} as const;

const transitionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "command", "expectedRevision"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    command: {
      type: "string",
      enum: WORKFLOW_COMMANDS.filter((command) => command !== "FINALIZE"),
    },
    expectedRevision: { type: "integer", minimum: 1 },
  },
} as const;

const workflowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "state",
    "revision",
    "inputRevision",
    "currentStep",
    "allowedCommands",
    "modelAllowedTools",
    "lastInputInvalidation",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    state: { type: "string", enum: WORKFLOW_STATES },
    revision: { type: "integer", minimum: 1 },
    inputRevision: { type: "integer", minimum: 1 },
    currentStep: {
      type: "object",
      additionalProperties: false,
      required: ["ordinal", "label"],
      properties: {
        ordinal: { type: "integer", minimum: 1, maximum: 10 },
        label: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    allowedCommands: { type: "array", items: { type: "string", enum: WORKFLOW_COMMANDS } },
    modelAllowedTools: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    lastInputInvalidation: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["at", "reason"],
          properties: {
            at: { type: "string", format: "date-time" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      ],
    },
  },
} as const;

const workflowResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "researchCase"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    researchCase: workflowSchema,
  },
} as const;

function body(patient: PatientRecord) {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, patient };
}

function listBody(patients: readonly PatientRecord[]) {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, patients };
}

function workflowBody(researchCase: ResearchCaseWorkflow) {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, researchCase };
}

function apiError(
  request: FastifyRequest,
  status: 400 | 404,
  code: "INVALID_PATIENT" | "PATIENT_NOT_FOUND",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

function actor(session: SessionContext) {
  return { id: session.user.id, role: session.user.role } as const;
}

export const patientRoutes =
  (
    options: PatientHttpOptions,
    getSession: (request: FastifyRequest) => SessionContext | undefined,
  ): FastifyPluginAsync =>
  async (api) => {
    const patientSchema = patientResponseSchema(options.officialIdentifier);

    api.get(
      "/patients",
      {
        schema: {
          operationId: "listPatients",
          tags: ["patients"],
          response: response(patientListResponseSchema(options.officialIdentifier)),
        },
      },
      async (request, reply) => {
        const patients = await listPatients(options.pool, actor(getSession(request)!));
        return reply.send(listBody(patients));
      },
    );

    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId",
      {
        schema: {
          operationId: "getPatientProfile",
          tags: ["patients"],
          params: patientParamsSchema,
          response: response(patientSchema),
        },
      },
      async (request, reply) => {
        try {
          const patient = await getPatient(
            options.pool,
            actor(getSession(request)!),
            request.params.patientId,
          );
          return reply.send(body(patient));
        } catch (error) {
          return patientError(error, request, reply);
        }
      },
    );

    api.delete<{ Params: { patientId: string } }>(
      "/patients/:patientId",
      {
        schema: {
          operationId: "deletePatient",
          tags: ["patients"],
          params: patientParamsSchema,
          response: response(deletionResponseSchema),
        },
      },
      async (request, reply) => {
        const deletion = await deletePatient(
          options.pool,
          actor(getSession(request)!),
          request.params.patientId,
          request.id,
          {
            artifactRoot: options.artifactRoot,
            removeArtifacts: options.removePatientArtifacts,
          },
        );
        if (deletion.artifactRemoval === "FAILED") {
          const event = {
            event: "PATIENT_ARTIFACT_REMOVAL_FAILED" as const,
            requestId: request.id,
          };
          if (options.logArtifactRemovalFailure) options.logArtifactRemovalFailure(event);
          else console.error(JSON.stringify(event));
        }
        return reply.send({ schemaVersion: CURRENT_SCHEMA_VERSION, deletion });
      },
    );

    api.get<{ Params: { patientId: string } }>(
      "/patients/:patientId/research-case",
      {
        schema: {
          operationId: "getResearchCaseWorkflow",
          tags: ["research-cases"],
          params: patientParamsSchema,
          response: response(workflowResponseSchema),
        },
      },
      async (request, reply) => {
        try {
          const researchCase = await getResearchCaseWorkflow(
            options.pool,
            actor(getSession(request)!),
            request.params.patientId,
          );
          return reply.send(workflowBody(researchCase));
        } catch (error) {
          return workflowError(error, request, reply);
        }
      },
    );

    api.post<{ Params: { patientId: string }; Body: VersionedTransitionCommand }>(
      "/patients/:patientId/research-case/transitions",
      {
        schema: {
          operationId: "transitionResearchCase",
          tags: ["research-cases"],
          params: patientParamsSchema,
          body: transitionBodySchema,
          response: response(workflowResponseSchema),
        },
      },
      async (request, reply) => {
        try {
          const researchCase = await transitionResearchCase(
            options.pool,
            actor(getSession(request)!),
            request.params.patientId,
            request.body.command,
            request.body.expectedRevision,
            request.id,
          );
          return reply.send(workflowBody(researchCase));
        } catch (error) {
          return workflowError(error, request, reply);
        }
      },
    );

    api.post<{ Body: VersionedPatientInput }>(
      "/patients",
      {
        schema: {
          operationId: "createOrOpenPatient",
          tags: ["patients"],
          body: patientBodySchema(options.officialIdentifier),
          response: { ...response(patientSchema), 201: patientSchema },
        },
      },
      async (request, reply) => {
        const session = getSession(request)!;
        try {
          const result = await createOrOverwritePatient(
            options.pool,
            actor(session),
            {
              ...request.body,
              officialIdentifier: {
                type: options.officialIdentifier.type,
                issuingAuthority: options.officialIdentifier.issuingAuthority,
                value: request.body.officialIdentifier.value,
              },
            },
            options.officialIdentifier,
            request.id,
          );
          return reply.status(result.created ? 201 : 200).send(body(result.patient));
        } catch (error) {
          return patientError(error, request, reply);
        }
      },
    );

    api.put<{ Params: { patientId: string }; Body: VersionedDemographics }>(
      "/patients/:patientId",
      {
        schema: {
          operationId: "savePatientDemographics",
          tags: ["patients"],
          params: patientParamsSchema,
          body: demographicsBodySchema,
          response: response(patientSchema),
        },
      },
      async (request, reply) => {
        const session = getSession(request)!;
        try {
          const patient = await savePatientDemographics(
            options.pool,
            actor(session),
            request.params.patientId,
            request.body,
            request.id,
          );
          return reply.send(body(patient));
        } catch (error) {
          return patientError(error, request, reply);
        }
      },
    );
  };

function patientError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof PatientInputError) {
    return reply
      .status(400)
      .send(apiError(request, 400, "INVALID_PATIENT", "Patient data is invalid."));
  }
  if (error instanceof PatientNotFoundError) {
    return reply
      .status(404)
      .send(apiError(request, 404, "PATIENT_NOT_FOUND", "Patient was not found."));
  }
  throw error;
}

function workflowError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ResearchCaseNotFoundError) {
    return reply
      .status(404)
      .send(apiError(request, 404, "PATIENT_NOT_FOUND", "Patient was not found."));
  }
  if (error instanceof StaleResearchCaseRevisionError) {
    return reply.status(409).send({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      error: {
        status: 409,
        code: "STALE_RESEARCH_CASE_REVISION",
        message: "Research Case revision is stale.",
        requestId: request.id,
      },
    });
  }
  if (error instanceof RequiredDomainResultError) {
    return reply.status(409).send({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      error: {
        status: 409,
        code: "REQUIRED_DOMAIN_RESULT_MISSING",
        message: "Required workflow result is unavailable.",
        requestId: request.id,
      },
    });
  }
  if (error instanceof WorkflowTransitionError) {
    return reply.status(409).send({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      error: {
        status: 409,
        code: "WORKFLOW_TRANSITION_NOT_ALLOWED",
        message: "Workflow command is not allowed.",
        requestId: request.id,
      },
    });
  }
  throw error;
}

import { ApiErrorSchema, CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionContext } from "../identity/sessions.js";
import {
  PatientInputError,
  PatientNotFoundError,
  createOrOverwritePatient,
  savePatientDemographics,
  type OfficialIdentifierConfiguration,
  type PatientDemographics,
  type PatientInput,
  type PatientRecord,
} from "./patients.js";

interface PatientHttpOptions {
  readonly pool: Pool;
  readonly officialIdentifier: OfficialIdentifierConfiguration;
}

interface VersionedPatientInput extends PatientInput {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
}

interface VersionedDemographics extends PatientDemographics {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const NAME_PATTERN = "^[A-Za-z]+(?:[ '-][A-Za-z]+)*$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const response = (schema: object) => ({ 200: schema, default: ApiErrorSchema });

function patientResponseSchema(configuration: OfficialIdentifierConfiguration) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "patient"],
    properties: {
      schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
      patient: {
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
      },
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
    required: ["type", "issuingAuthority", "value"],
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

function body(patient: PatientRecord) {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, patient };
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
            request.body,
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
          params: {
            type: "object",
            additionalProperties: false,
            required: ["patientId"],
            properties: { patientId: { type: "string", pattern: UUID_PATTERN } },
          },
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

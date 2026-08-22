import {
  ApiErrorSchema,
  CURRENT_SCHEMA_VERSION,
  type ApiError,
  type Role,
} from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  LastEnabledAdministratorError,
  UsernameUnavailableError,
  authenticateUser,
  changePassword,
  createManagedUser,
  listUsers,
  renameUser,
  resetPassword,
  revokeManagedUserSessions,
  setPassword,
  setUserEnabled,
  type User,
} from "./users.js";
import {
  clearFailedSignIns,
  createSession,
  expiredSessionCookie,
  recordFailedSignIn,
  resolveSession,
  revokeSession,
  rotateCsrfToken,
  sessionCookie,
  sessionTokenFromCookie,
  waitForLoginDelay,
  type SecurityMetadata,
  type SessionContext,
} from "./sessions.js";

interface CredentialsBody {
  username: string;
  password: string;
}
interface PasswordBody {
  password: string;
}
interface CreateUserBody extends CredentialsBody {
  role: Role;
}
interface RenameUserBody {
  username: string;
}
interface UserParams {
  userId: string;
}

export interface AuthenticationHttpOptions {
  readonly pool: Pool;
  readonly allowInsecureLoopbackCookie?: boolean;
  readonly loginDelay?: (milliseconds: number) => Promise<void>;
}

const credentialsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 128 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;
const passwordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: { password: { type: "string", minLength: 1, maxLength: 1024 } },
} as const;
const createUserSchema = {
  ...credentialsSchema,
  required: ["username", "password", "role"],
  properties: {
    ...credentialsSchema.properties,
    role: { type: "string", enum: ["ADMINISTRATOR", "PSYCHIATRIST"] },
  },
} as const;
const renameUserSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username"],
  properties: { username: { type: "string", minLength: 1, maxLength: 128 } },
} as const;
const userParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: { userId: { type: "string", format: "uuid" } },
} as const;
const publicUserSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "username",
    "role",
    "status",
    "bootstrapCredentialActive",
    "securityRisk",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    username: { type: "string" },
    role: { type: "string", enum: ["ADMINISTRATOR", "PSYCHIATRIST"] },
    status: { type: "string", enum: ["ENABLED", "DISABLED", "PASSWORD_CHANGE_REQUIRED"] },
    bootstrapCredentialActive: { type: "boolean" },
    securityRisk: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;
const sessionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "user", "csrfToken", "expiresAt"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    user: {
      type: "object",
      additionalProperties: false,
      required: ["id", "username", "role", "status"],
      properties: {
        id: { type: "string", format: "uuid" },
        username: { type: "string" },
        role: { type: "string", enum: ["ADMINISTRATOR", "PSYCHIATRIST"] },
        status: { type: "string", enum: ["ENABLED", "PASSWORD_CHANGE_REQUIRED"] },
      },
    },
    csrfToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
const userResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "user"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    user: publicUserSchema,
  },
} as const;
const usersResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "users"],
  properties: {
    schemaVersion: { type: "string", const: CURRENT_SCHEMA_VERSION },
    users: { type: "array", items: publicUserSchema },
  },
} as const;
const response = (success: object) => ({ 200: success, default: ApiErrorSchema });
const noContentResponse = { 204: { type: "null" }, default: ApiErrorSchema } as const;

function metadata(request: FastifyRequest): SecurityMetadata {
  const userAgent = request.headers["user-agent"];
  return {
    requestId: request.id,
    sourceAddress: request.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}

function authError(request: FastifyRequest, status: 401 | 403 | 404): ApiError {
  const values = {
    401: ["AUTHENTICATION_FAILED", "Authentication failed."],
    403: ["FORBIDDEN", "Request is not permitted."],
    404: ["NOT_FOUND", "Resource was not found."],
  } as const;
  const [code, message] = values[status];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message, requestId: request.id },
  };
}

function conflictError(
  request: FastifyRequest,
  code: "USERNAME_UNAVAILABLE" | "LAST_ADMINISTRATOR",
  message: string,
): ApiError {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status: 409, code, message, requestId: request.id },
  };
}

function sessionBody(context: SessionContext, csrfToken: string) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    user: context.user,
    csrfToken,
    expiresAt: context.expiresAt.toISOString(),
  };
}

function userBody(user: User) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      bootstrapCredentialActive: user.bootstrapCredentialActive,
      securityRisk: user.securityRisk,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  };
}

async function requireAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): Promise<SessionContext | undefined> {
  const context = getSession(request);
  if (context?.user.role === "ADMINISTRATOR") return context;
  await reply.status(403).send(authError(request, 403));
  return undefined;
}

async function managedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<User | null>,
) {
  try {
    const user = await operation();
    if (!user) return reply.status(404).send(authError(request, 404));
    return userBody(user);
  } catch (error) {
    if (error instanceof UsernameUnavailableError) {
      return reply
        .status(409)
        .send(conflictError(request, "USERNAME_UNAVAILABLE", "Username is unavailable."));
    }
    if (error instanceof LastEnabledAdministratorError) {
      return reply
        .status(409)
        .send(
          conflictError(
            request,
            "LAST_ADMINISTRATOR",
            "The last enabled Administrator cannot be disabled.",
          ),
        );
    }
    throw error;
  }
}

export function authenticationRoutes(
  options: AuthenticationHttpOptions,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync {
  const secureCookie = !options.allowInsecureLoopbackCookie;
  const loginDelay = options.loginDelay ?? waitForLoginDelay;
  return async (api) => {
    api.post<{ Body: CredentialsBody }>(
      "/login",
      {
        schema: {
          operationId: "login",
          body: credentialsSchema,
          response: response(sessionResponseSchema),
        },
      },
      async (request, reply) => {
        const { username, password } = request.body;
        const authentication = await authenticateUser(options.pool, username, password);
        if (!authentication.authenticated || !authentication.user) {
          const milliseconds = await recordFailedSignIn(options.pool, username, metadata(request));
          await loginDelay(milliseconds);
          return reply.status(401).send(authError(request, 401));
        }
        await clearFailedSignIns(options.pool, username);
        const session = await createSession(
          options.pool,
          authentication.user.id,
          metadata(request),
          sessionTokenFromCookie(request.headers.cookie),
        );
        void reply.header("set-cookie", sessionCookie(session.token, secureCookie));
        return {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          user: {
            id: authentication.user.id,
            username: authentication.user.username,
            role: authentication.user.role,
            status: authentication.user.status,
          },
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
        };
      },
    );

    api.get(
      "/session",
      { schema: { operationId: "getSession", response: response(sessionResponseSchema) } },
      async (request, reply) => {
        const token = sessionTokenFromCookie(request.headers.cookie);
        const context = token ? await resolveSession(options.pool, token) : null;
        if (!context) return reply.status(401).send(authError(request, 401));
        const csrfToken = await rotateCsrfToken(options.pool, context.sessionId);
        if (!csrfToken) return reply.status(401).send(authError(request, 401));
        return sessionBody(context, csrfToken);
      },
    );

    api.post(
      "/logout",
      { schema: { operationId: "logout", response: noContentResponse } },
      async (request, reply) => {
        const token = sessionTokenFromCookie(request.headers.cookie);
        if (token) await revokeSession(options.pool, token, metadata(request));
        void reply.header("set-cookie", expiredSessionCookie(secureCookie));
        return reply.status(204).send();
      },
    );

    api.post<{ Body: PasswordBody }>(
      "/session/password",
      {
        schema: {
          operationId: "replacePassword",
          body: passwordSchema,
          response: response(sessionResponseSchema),
        },
      },
      async (request, reply) => {
        const context = getSession(request);
        if (!context) return reply.status(401).send(authError(request, 401));
        const user = await changePassword(
          options.pool,
          context.user.id,
          request.body.password,
          undefined,
          metadata(request),
        );
        if (!user) return reply.status(401).send(authError(request, 401));
        const session = await createSession(options.pool, user.id, metadata(request));
        void reply.header("set-cookie", sessionCookie(session.token, secureCookie));
        return {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          user: { id: user.id, username: user.username, role: user.role, status: user.status },
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
        };
      },
    );

    api.get(
      "/admin/users",
      { schema: { operationId: "listUsers", response: response(usersResponseSchema) } },
      async (request, reply) => {
        if (!(await requireAdministrator(request, reply, getSession))) return;
        return {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          users: (await listUsers(options.pool)).map((user) => userBody(user).user),
        };
      },
    );

    api.post<{ Body: CreateUserBody }>(
      "/admin/users",
      {
        schema: {
          operationId: "createUser",
          body: createUserSchema,
          response: { 201: userResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        const result = await managedUser(request, reply, () =>
          createManagedUser(options.pool, administrator.user.id, request.body, metadata(request)),
        );
        if (reply.statusCode >= 400) return result;
        return reply.status(201).send(result);
      },
    );

    api.patch<{ Body: RenameUserBody; Params: UserParams }>(
      "/admin/users/:userId/username",
      {
        schema: {
          operationId: "renameUser",
          params: userParamsSchema,
          body: renameUserSchema,
          response: response(userResponseSchema),
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        return managedUser(request, reply, () =>
          renameUser(
            options.pool,
            administrator.user.id,
            request.params.userId,
            request.body.username,
            metadata(request),
          ),
        );
      },
    );

    for (const enabled of [true, false]) {
      api.post<{ Params: UserParams }>(
        `/admin/users/:userId/${enabled ? "enable" : "disable"}`,
        {
          schema: {
            operationId: enabled ? "enableUser" : "disableUser",
            params: userParamsSchema,
            response: response(userResponseSchema),
          },
        },
        async (request, reply) => {
          const administrator = await requireAdministrator(request, reply, getSession);
          if (!administrator) return;
          return managedUser(request, reply, () =>
            setUserEnabled(
              options.pool,
              request.params.userId,
              enabled,
              administrator.user.id,
              undefined,
              metadata(request),
            ),
          );
        },
      );
    }

    api.put<{ Body: PasswordBody; Params: UserParams }>(
      "/admin/users/:userId/password",
      {
        schema: {
          operationId: "setUserPassword",
          params: userParamsSchema,
          body: passwordSchema,
          response: response(userResponseSchema),
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        return managedUser(request, reply, () =>
          setPassword(
            options.pool,
            administrator.user.id,
            request.params.userId,
            request.body.password,
            metadata(request),
          ),
        );
      },
    );

    api.post<{ Body: PasswordBody; Params: UserParams }>(
      "/admin/users/:userId/reset-password",
      {
        schema: {
          operationId: "resetUserPassword",
          params: userParamsSchema,
          body: passwordSchema,
          response: response(userResponseSchema),
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        return managedUser(request, reply, () =>
          resetPassword(
            options.pool,
            administrator.user.id,
            request.params.userId,
            request.body.password,
            metadata(request),
          ),
        );
      },
    );

    api.post<{ Params: UserParams }>(
      "/admin/users/:userId/revoke-sessions",
      {
        schema: {
          operationId: "revokeUserSessions",
          params: userParamsSchema,
          response: noContentResponse,
        },
      },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        const revoked = await revokeManagedUserSessions(
          options.pool,
          administrator.user.id,
          request.params.userId,
          metadata(request),
        );
        if (!revoked) return reply.status(404).send(authError(request, 404));
        return reply.status(204).send();
      },
    );
  };
}

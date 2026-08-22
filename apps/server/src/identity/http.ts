import { CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { authenticateUser, changePassword, resetPassword, setUserEnabled } from "./users.js";
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

const userParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: { userId: { type: "string", format: "uuid" } },
} as const;

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

function sessionBody(context: SessionContext, csrfToken: string) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    user: context.user,
    csrfToken,
    expiresAt: context.expiresAt.toISOString(),
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

export function authenticationRoutes(
  options: AuthenticationHttpOptions,
  getSession: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync {
  const secureCookie = !options.allowInsecureLoopbackCookie;
  const loginDelay = options.loginDelay ?? waitForLoginDelay;

  return async (api) => {
    api.post<{ Body: CredentialsBody }>(
      "/login",
      { schema: { body: credentialsSchema } },
      async (request, reply) => {
        const { username, password } = request.body;
        const authentication = await authenticateUser(options.pool, username, password);
        if (!authentication.authenticated || !authentication.user) {
          const milliseconds = await recordFailedSignIn(options.pool, username, metadata(request));
          await loginDelay(milliseconds);
          return reply.status(401).send(authError(request, 401));
        }

        await clearFailedSignIns(options.pool, username);
        const previousToken = sessionTokenFromCookie(request.headers.cookie);
        const session = await createSession(
          options.pool,
          authentication.user.id,
          metadata(request),
          previousToken,
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

    api.get("/session", async (request, reply) => {
      const token = sessionTokenFromCookie(request.headers.cookie);
      const context = token ? await resolveSession(options.pool, token) : null;
      if (!context) return reply.status(401).send(authError(request, 401));
      const csrfToken = await rotateCsrfToken(options.pool, context.sessionId);
      if (!csrfToken) return reply.status(401).send(authError(request, 401));
      return sessionBody(context, csrfToken);
    });

    api.post("/logout", async (request, reply) => {
      const token = sessionTokenFromCookie(request.headers.cookie);
      if (token) await revokeSession(options.pool, token, metadata(request));
      void reply.header("set-cookie", expiredSessionCookie(secureCookie));
      return reply.status(204).send();
    });

    api.post<{ Body: PasswordBody }>(
      "/session/password",
      { schema: { body: passwordSchema } },
      async (request, reply) => {
        const context = getSession(request);
        if (!context) return reply.status(401).send(authError(request, 401));
        const user = await changePassword(options.pool, context.user.id, request.body.password);
        if (!user) return reply.status(401).send(authError(request, 401));
        void reply.header("set-cookie", expiredSessionCookie(secureCookie));
        return reply.status(204).send();
      },
    );

    api.post<{ Body: PasswordBody; Params: UserParams }>(
      "/admin/psychiatrists/:userId/reset-password",
      { schema: { params: userParamsSchema, body: passwordSchema } },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        const user = await resetPassword(
          options.pool,
          administrator.user.id,
          request.params.userId,
          request.body.password,
        );
        if (!user || user.role !== "PSYCHIATRIST") {
          return reply.status(404).send(authError(request, 404));
        }
        return reply.status(204).send();
      },
    );

    api.post<{ Params: UserParams }>(
      "/admin/psychiatrists/:userId/disable",
      { schema: { params: userParamsSchema } },
      async (request, reply) => {
        const administrator = await requireAdministrator(request, reply, getSession);
        if (!administrator) return;
        const user = await setUserEnabled(
          options.pool,
          request.params.userId,
          false,
          administrator.user.id,
          "PSYCHIATRIST",
        );
        if (!user || user.role !== "PSYCHIATRIST") {
          return reply.status(404).send(authError(request, 404));
        }
        return reply.status(204).send();
      },
    );
  };
}

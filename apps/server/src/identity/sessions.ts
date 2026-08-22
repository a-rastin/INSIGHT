import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { Role } from "@insight/contracts";
import type { Pool, PoolClient, QueryResult } from "pg";

import { withTransaction } from "../database/transaction.js";

export const SESSION_COOKIE_NAME = "insight_session";
export const SESSION_IDLE_MILLISECONDS = 30 * 60 * 1_000;
export const SESSION_ABSOLUTE_MILLISECONDS = 8 * 60 * 60 * 1_000;

export type SecurityEventType =
  | "SIGN_IN"
  | "FAILED_SIGN_IN"
  | "SIGN_OUT"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET"
  | "ACCOUNT_DISABLED";

interface Queryable {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

interface SessionRow {
  session_id: string;
  csrf_hash: Buffer;
  user_id: string;
  username: string;
  role: Role;
  status: "ENABLED" | "PASSWORD_CHANGE_REQUIRED";
  expires_at: Date;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly csrfHash: Buffer;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: Role;
    readonly status: "ENABLED" | "PASSWORD_CHANGE_REQUIRED";
  };
  readonly expiresAt: Date;
}

export interface NewSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface SecurityMetadata {
  readonly requestId?: string;
  readonly sourceAddress?: string;
  readonly userAgent?: string;
}

const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
const opaqueToken = (): string => randomBytes(32).toString("base64url");

export async function auditSecurityEvent(
  database: Queryable,
  eventType: SecurityEventType,
  actorUserId: string | null,
  subjectUserId: string | null,
  metadata: SecurityMetadata = {},
): Promise<void> {
  await database.query(
    `INSERT INTO insight.security_audit_events
       (event_type, actor_user_id, subject_user_id, request_id, source_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      eventType,
      actorUserId,
      subjectUserId,
      metadata.requestId ?? null,
      metadata.sourceAddress ?? null,
    ],
  );
}

export async function createSession(
  pool: Pool,
  userId: string,
  metadata: SecurityMetadata = {},
  previousToken?: string,
  now = new Date(),
): Promise<NewSession> {
  const token = opaqueToken();
  const csrfToken = opaqueToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MILLISECONDS);

  await withTransaction(pool, async (client) => {
    if (previousToken) {
      await client.query(
        `UPDATE insight.sessions
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE token_hash = $1`,
        [hash(previousToken), now],
      );
    }
    await client.query(
      `INSERT INTO insight.sessions
         (token_hash, csrf_hash, user_id, created_at, last_used_at, expires_at,
          source_address, user_agent)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [
        hash(token),
        hash(csrfToken),
        userId,
        now,
        expiresAt,
        metadata.sourceAddress ?? null,
        metadata.userAgent?.slice(0, 512) ?? null,
      ],
    );
    await auditSecurityEvent(client, "SIGN_IN", userId, userId, metadata);
  });

  return { token, csrfToken, expiresAt };
}

export async function resolveSession(
  pool: Pool,
  token: string,
  now = new Date(),
): Promise<SessionContext | null> {
  const result = await pool.query<SessionRow>(
    `WITH active_session AS (
       UPDATE insight.sessions
       SET last_used_at = $2
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > $2
         AND last_used_at > $2 - interval '30 minutes'
       RETURNING id, csrf_hash, user_id, expires_at
     )
     SELECT active_session.id AS session_id, active_session.csrf_hash,
            active_session.user_id, active_session.expires_at,
            users.username, users.role, users.status
     FROM active_session
     JOIN insight.users ON users.id = active_session.user_id
     WHERE users.status <> 'DISABLED'`,
    [hash(token), now],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      status: row.status,
    },
    expiresAt: row.expires_at,
  };
}

export function isValidCsrf(context: SessionContext, csrfToken: string | undefined): boolean {
  if (!csrfToken) return false;
  const candidate = hash(csrfToken);
  return (
    candidate.length === context.csrfHash.length && timingSafeEqual(candidate, context.csrfHash)
  );
}

export async function rotateCsrfToken(pool: Pool, sessionId: string): Promise<string | null> {
  const csrfToken = opaqueToken();
  const result = await pool.query(
    `UPDATE insight.sessions
     SET csrf_hash = $1
     WHERE id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [hash(csrfToken), sessionId],
  );
  return result.rowCount === 1 ? csrfToken : null;
}

export async function revokeSession(
  pool: Pool,
  token: string,
  metadata: SecurityMetadata = {},
  now = new Date(),
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ user_id: string }>(
      `UPDATE insight.sessions
       SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [hash(token), now],
    );
    const userId = result.rows[0]?.user_id;
    if (!userId) return false;
    await auditSecurityEvent(client, "SIGN_OUT", userId, userId, metadata);
    return true;
  });
}

export async function revokeUserSessions(client: PoolClient, userId: string): Promise<number> {
  const result = await client.query(
    `UPDATE insight.sessions
     SET revoked_at = COALESCE(revoked_at, clock_timestamp())
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

function throttleIdentifier(username: string): Buffer {
  return hash(username.trim().normalize("NFKC").toLowerCase());
}

export async function recordFailedSignIn(
  pool: Pool,
  username: string,
  metadata: SecurityMetadata = {},
): Promise<number> {
  const failureCount = await withTransaction(pool, async (client) => {
    const result = await client.query<{ failure_count: number }>(
      `INSERT INTO insight.sign_in_throttles (identifier_hash, failure_count, last_failed_at)
       VALUES ($1, 1, clock_timestamp())
       ON CONFLICT (identifier_hash) DO UPDATE
       SET failure_count = LEAST(insight.sign_in_throttles.failure_count + 1, 32),
           last_failed_at = clock_timestamp()
       RETURNING failure_count`,
      [throttleIdentifier(username)],
    );
    await auditSecurityEvent(client, "FAILED_SIGN_IN", null, null, metadata);
    return result.rows[0].failure_count;
  });
  return Math.min(60_000, 250 * 2 ** (failureCount - 1));
}

export async function clearFailedSignIns(pool: Pool, username: string): Promise<void> {
  await pool.query("DELETE FROM insight.sign_in_throttles WHERE identifier_hash = $1", [
    throttleIdentifier(username),
  ]);
}

export const waitForLoginDelay = (milliseconds: number): Promise<void> => delay(milliseconds);

export function sessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure = true): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${SESSION_ABSOLUTE_MILLISECONDS / 1_000}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function expiredSessionCookie(secure = true): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]
    .filter(Boolean)
    .join("; ");
}

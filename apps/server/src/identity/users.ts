import type { Role } from "@insight/contracts";
import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../database/transaction.js";
import {
  CURRENT_PASSWORD_POLICY,
  hashPassword,
  verifyPasswordHash,
  type PasswordPolicy,
} from "./passwords.js";
import { auditSecurityEvent, revokeUserSessions } from "./sessions.js";

const LAST_ADMINISTRATOR_LOCK_ID = "805974421099826827";
const BOOTSTRAP_USERNAME = "admin";

export const BOOTSTRAP_CREDENTIAL_RISK =
  "Publicly predictable bootstrap Administrator credential remains active.";

export type UserStatus = "ENABLED" | "DISABLED" | "PASSWORD_CHANGE_REQUIRED";

interface UserRow {
  id: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  password_policy_version: number;
  role: Role;
  status: UserStatus;
  bootstrap_credential_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  readonly id: string;
  readonly username: string;
  readonly usernameNormalized: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly bootstrapCredentialActive: boolean;
  readonly securityRisk: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuthenticationResult {
  readonly authenticated: boolean;
  readonly user?: User;
  readonly passwordRehashed?: boolean;
}

export class UsernameUnavailableError extends Error {
  constructor() {
    super("Username is unavailable.");
    this.name = "UsernameUnavailableError";
  }
}

export class LastEnabledAdministratorError extends Error {
  constructor() {
    super("The last enabled Administrator cannot be disabled.");
    this.name = "LastEnabledAdministratorError";
  }
}

function canonicalUsername(username: string): string {
  const canonical = username.trim().normalize("NFKC");
  if (canonical.length < 1 || canonical.length > 128) {
    throw new RangeError("Username must contain 1 to 128 characters.");
  }
  return canonical;
}

export function normalizeUsername(username: string): string {
  return canonicalUsername(username).toLowerCase();
}

function publicUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    usernameNormalized: row.username_normalized,
    role: row.role,
    status: row.status,
    bootstrapCredentialActive: row.bootstrap_credential_active,
    securityRisk: row.bootstrap_credential_active ? BOOTSTRAP_CREDENTIAL_RISK : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSqlState(error: unknown, state: string, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === state && (constraint === undefined || candidate.constraint === constraint)
  );
}

async function insertUser(
  client: PoolClient,
  username: string,
  passwordHash: string,
  passwordPolicyVersion: number,
  role: Role,
  bootstrapCredentialActive = false,
): Promise<User> {
  try {
    const result = await client.query<UserRow>(
      `INSERT INTO insight.users
         (username, password_hash, password_policy_version, role, status, bootstrap_credential_active)
       VALUES ($1, $2, $3, $4, 'ENABLED', $5)
       RETURNING *`,
      [
        canonicalUsername(username),
        passwordHash,
        passwordPolicyVersion,
        role,
        bootstrapCredentialActive,
      ],
    );
    return publicUser(result.rows[0]);
  } catch (error) {
    if (isSqlState(error, "23505", "users_username_normalized_unique")) {
      throw new UsernameUnavailableError();
    }
    throw error;
  }
}

export async function insertBootstrapAdministrator(client: PoolClient): Promise<void> {
  const passwordHash = await hashPassword(BOOTSTRAP_USERNAME);
  await insertUser(
    client,
    BOOTSTRAP_USERNAME,
    passwordHash,
    CURRENT_PASSWORD_POLICY.version,
    "ADMINISTRATOR",
    true,
  );
}

export async function createUser(
  pool: Pool,
  input: { readonly username: string; readonly password: string; readonly role: Role },
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<User> {
  const passwordHash = await hashPassword(input.password, policy);
  return withTransaction(pool, (client) =>
    insertUser(client, input.username, passwordHash, policy.version, input.role),
  );
}

export async function authenticateUser(
  pool: Pool,
  username: string,
  password: string,
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<AuthenticationResult> {
  let usernameNormalized: string;
  try {
    usernameNormalized = normalizeUsername(username);
  } catch {
    return { authenticated: false };
  }

  const result = await pool.query<UserRow>(
    "SELECT * FROM insight.users WHERE username_normalized = $1",
    [usernameNormalized],
  );
  const row = result.rows[0];
  const verification = await verifyPasswordHash(
    password,
    row?.password_hash ?? DUMMY_PASSWORD_HASH,
    row?.password_policy_version ?? policy.version,
    policy,
  );
  if (!row || !verification.valid || row.status === "DISABLED") return { authenticated: false };

  if (verification.needsRehash) {
    const replacement = await hashPassword(password, policy);
    const updated = await pool.query<UserRow>(
      `UPDATE insight.users
       SET password_hash = $1, password_policy_version = $2, updated_at = clock_timestamp()
       WHERE id = $3 AND password_hash = $4
       RETURNING *`,
      [replacement, policy.version, row.id, row.password_hash],
    );
    if (updated.rows[0]) Object.assign(row, updated.rows[0]);
  }

  return {
    authenticated: true,
    user: publicUser(row),
    passwordRehashed: verification.needsRehash,
  };
}

export async function changePassword(
  pool: Pool,
  userId: string,
  password: string,
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<User | null> {
  const passwordHash = await hashPassword(password, policy);
  return withTransaction(pool, async (client) => {
    const result = await client.query<UserRow>(
      `UPDATE insight.users
       SET password_hash = $1,
           password_policy_version = $2,
           bootstrap_credential_active = false,
           status = CASE WHEN status = 'PASSWORD_CHANGE_REQUIRED' THEN 'ENABLED' ELSE status END,
           updated_at = clock_timestamp()
       WHERE id = $3
       RETURNING *`,
      [passwordHash, policy.version, userId],
    );
    if (!result.rows[0]) return null;
    await revokeUserSessions(client, userId);
    await auditSecurityEvent(client, "PASSWORD_CHANGED", userId, userId);
    return publicUser(result.rows[0]);
  });
}

export async function resetPassword(
  pool: Pool,
  actorUserId: string,
  userId: string,
  password: string,
  policy: PasswordPolicy = CURRENT_PASSWORD_POLICY,
): Promise<User | null> {
  const passwordHash = await hashPassword(password, policy);
  return withTransaction(pool, async (client) => {
    const result = await client.query<UserRow>(
      `UPDATE insight.users
       SET password_hash = $1,
           password_policy_version = $2,
           bootstrap_credential_active = false,
           status = 'PASSWORD_CHANGE_REQUIRED',
           updated_at = clock_timestamp()
       WHERE id = $3 AND role = 'PSYCHIATRIST'
       RETURNING *`,
      [passwordHash, policy.version, userId],
    );
    if (!result.rows[0]) return null;
    await revokeUserSessions(client, userId);
    await auditSecurityEvent(client, "PASSWORD_RESET", actorUserId, userId);
    return publicUser(result.rows[0]);
  });
}

export async function setUserEnabled(
  pool: Pool,
  userId: string,
  enabled: boolean,
  actorUserId: string = userId,
  expectedRole?: Role,
): Promise<User | null> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [LAST_ADMINISTRATOR_LOCK_ID]);
      const result = await client.query<UserRow>(
        `UPDATE insight.users
         SET status = $1, updated_at = clock_timestamp()
         WHERE id = $2
           AND ($3::insight.user_role IS NULL OR role = $3)
         RETURNING *`,
        [enabled ? "ENABLED" : "DISABLED", userId, expectedRole ?? null],
      );
      if (!result.rows[0]) return null;
      if (!enabled) {
        await revokeUserSessions(client, userId);
        await auditSecurityEvent(client, "ACCOUNT_DISABLED", actorUserId, userId);
      }
      return publicUser(result.rows[0]);
    });
  } catch (error) {
    if (isSqlState(error, "23514", "users_last_enabled_administrator")) {
      throw new LastEnabledAdministratorError();
    }
    throw error;
  }
}

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$Svb+bK1Y2m4BHEimY952eQ$UIQ9owiei9fMNpc0u972+N20zByGuDvlH0gwpS4SX5I";

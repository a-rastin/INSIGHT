import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { insertBootstrapAdministrator } from "../identity/users.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  dataVersion?: string;
  run?: (client: PoolClient) => Promise<void>;
}

export interface PreparedMigration extends Migration {
  checksum: string;
}

export const migrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "database_foundation",
    sql: `
      CREATE SCHEMA insight;
      COMMENT ON SCHEMA insight IS 'INSIGHT application-owned database objects';
    `,
  },
  {
    version: 2,
    name: "identity_foundation",
    dataVersion: "bootstrap-administrator-v1",
    sql: `

      CREATE TYPE insight.user_role AS ENUM ('ADMINISTRATOR', 'PSYCHIATRIST');
      CREATE TYPE insight.user_status AS ENUM ('ENABLED', 'DISABLED', 'PASSWORD_CHANGE_REQUIRED');

      CREATE TABLE insight.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username text NOT NULL CHECK (
          username = btrim(username)
          AND username <> ''
          AND char_length(username) <= 128
        ),
        username_normalized text GENERATED ALWAYS AS (
          lower(normalize(btrim(username), NFKC))
        ) STORED,
        password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
        password_policy_version integer NOT NULL CHECK (password_policy_version > 0),
        role insight.user_role NOT NULL,
        status insight.user_status NOT NULL DEFAULT 'ENABLED',
        bootstrap_credential_active boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT users_username_normalized_unique UNIQUE (username_normalized),
        CONSTRAINT users_bootstrap_role_check CHECK (
          NOT bootstrap_credential_active OR role = 'ADMINISTRATOR'
        )
      );

      CREATE FUNCTION insight.protect_last_enabled_administrator()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.role = 'ADMINISTRATOR'
           AND OLD.status = 'ENABLED'
           AND (
             TG_OP = 'DELETE'
             OR NEW.role <> 'ADMINISTRATOR'
             OR NEW.status <> 'ENABLED'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM insight.users
             WHERE id <> OLD.id
               AND role = 'ADMINISTRATOR'
               AND status = 'ENABLED'
           )
        THEN
          RAISE EXCEPTION 'cannot remove the last enabled Administrator'
            USING ERRCODE = '23514', CONSTRAINT = 'users_last_enabled_administrator';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;

      CREATE TRIGGER users_protect_last_enabled_administrator
      BEFORE UPDATE OF role, status OR DELETE ON insight.users
      FOR EACH ROW EXECUTE FUNCTION insight.protect_last_enabled_administrator();
    `,
    run: insertBootstrapAdministrator,
  },
  {
    version: 3,
    name: "authentication_sessions",
    sql: `
      CREATE TABLE insight.sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
        csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
        user_id uuid NOT NULL REFERENCES insight.users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        source_address text,
        user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
        CHECK (expires_at > created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );

      CREATE INDEX sessions_active_user_idx
        ON insight.sessions (user_id, expires_at)
        WHERE revoked_at IS NULL;

      CREATE TABLE insight.sign_in_throttles (
        identifier_hash bytea PRIMARY KEY CHECK (octet_length(identifier_hash) = 32),
        failure_count integer NOT NULL CHECK (failure_count > 0 AND failure_count <= 32),
        last_failed_at timestamptz NOT NULL
      );

      CREATE TABLE insight.security_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL CHECK (event_type IN (
          'SIGN_IN', 'FAILED_SIGN_IN', 'SIGN_OUT', 'PASSWORD_CHANGED',
          'PASSWORD_RESET', 'ACCOUNT_DISABLED'
        )),
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        subject_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        request_id uuid,
        source_address text,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX security_audit_events_occurred_idx
        ON insight.security_audit_events (occurred_at DESC);
    `,
  },
]);

export function prepareMigrations(
  source: readonly Migration[] = migrations,
): readonly PreparedMigration[] {
  const versions = new Set<number>();
  return source.map((migration, index) => {
    if (!Number.isSafeInteger(migration.version) || migration.version !== index + 1) {
      throw new Error("Migration versions must be consecutive positive integers starting at 1.");
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(migration.name) || migration.sql.trim() === "") {
      throw new Error(`Migration ${migration.version} has an invalid name or empty SQL.`);
    }
    versions.add(migration.version);
    const checksum = createHash("sha256")
      .update(
        `${migration.version}\n${migration.name}\n${migration.sql}${
          migration.dataVersion ? `\n${migration.dataVersion}` : ""
        }`,
      )
      .digest("hex");
    return { ...migration, checksum };
  });
}

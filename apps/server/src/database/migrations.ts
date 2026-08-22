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
  {
    version: 4,
    name: "administrator_user_management",
    sql: `
      ALTER TABLE insight.security_audit_events
        DROP CONSTRAINT security_audit_events_event_type_check;

      ALTER TABLE insight.security_audit_events
        ADD CONSTRAINT security_audit_events_event_type_check CHECK (event_type IN (
          'SIGN_IN', 'FAILED_SIGN_IN', 'SIGN_OUT', 'USER_CREATED', 'USER_RENAMED',
          'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ACCOUNT_ENABLED', 'ACCOUNT_DISABLED',
          'SESSIONS_REVOKED'
        ));

      CREATE OR REPLACE FUNCTION insight.protect_last_enabled_administrator()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.role = 'ADMINISTRATOR'
           AND OLD.status <> 'DISABLED'
           AND (
             TG_OP = 'DELETE'
             OR NEW.role <> 'ADMINISTRATOR'
             OR NEW.status = 'DISABLED'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM insight.users
             WHERE id <> OLD.id
               AND role = 'ADMINISTRATOR'
               AND status <> 'DISABLED'
           )
        THEN
          RAISE EXCEPTION 'cannot remove the last enabled Administrator'
            USING ERRCODE = '23514', CONSTRAINT = 'users_last_enabled_administrator';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;
    `,
  },
  {
    version: 5,
    name: "identified_research_gate",
    sql: `
      CREATE TABLE insight.deployment_evidence_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version integer NOT NULL UNIQUE CHECK (version > 0),
        schema_version integer NOT NULL CHECK (schema_version = 1),
        responsible_authority text NOT NULL CHECK (
          responsible_authority = btrim(responsible_authority)
          AND responsible_authority <> ''
          AND char_length(responsible_authority) <= 500
        ),
        approval_basis text NOT NULL CHECK (
          approval_basis = btrim(approval_basis)
          AND approval_basis <> ''
          AND char_length(approval_basis) <= 2000
        ),
        approval_reference text NOT NULL CHECK (
          approval_reference = btrim(approval_reference)
          AND approval_reference <> ''
          AND char_length(approval_reference) <= 500
        ),
        approval_granted_at timestamptz NOT NULL,
        approval_expires_at timestamptz NOT NULL,
        environment_status text NOT NULL CHECK (environment_status IN (
          'SYNTHETIC_OR_DEIDENTIFIED', 'APPROVED_IDENTIFIED_RESEARCH'
        )),
        participant_consent_or_waiver boolean NOT NULL,
        administrator_separation boolean NOT NULL,
        encryption_in_transit boolean NOT NULL,
        encryption_at_rest boolean NOT NULL,
        audit_controls boolean NOT NULL,
        data_governance_rules boolean NOT NULL,
        model_disclosure_controls boolean NOT NULL,
        environment_separation boolean NOT NULL,
        recorded_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (approval_expires_at > approval_granted_at)
      );

      CREATE FUNCTION insight.protect_deployment_evidence_version()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'deployment evidence versions are immutable'
          USING ERRCODE = '55000';
      END;
      $function$;

      CREATE TRIGGER deployment_evidence_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.deployment_evidence_versions
      FOR EACH ROW EXECUTE FUNCTION insight.protect_deployment_evidence_version();

      CREATE TABLE insight.deployment_mode_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        active_evidence_version integer REFERENCES insight.deployment_evidence_versions(version),
        activated_by_user_id uuid REFERENCES insight.users(id),
        activated_at timestamptz,
        CHECK (
          (active_evidence_version IS NULL AND activated_by_user_id IS NULL AND activated_at IS NULL)
          OR
          (active_evidence_version IS NOT NULL AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
        )
      );

      INSERT INTO insight.deployment_mode_state (singleton) VALUES (true);

      CREATE TABLE insight.operational_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL CHECK (event_type IN (
          'DEPLOYMENT_EVIDENCE_RECORDED', 'IDENTIFIED_MODE_ACTIVATED', 'IDENTIFIED_MODE_DISABLED'
        )),
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        evidence_version integer NOT NULL REFERENCES insight.deployment_evidence_versions(version),
        environment_status text NOT NULL CHECK (environment_status IN (
          'SYNTHETIC_OR_DEIDENTIFIED', 'APPROVED_IDENTIFIED_RESEARCH'
        )),
        request_id uuid,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX operational_audit_events_occurred_idx
        ON insight.operational_audit_events (occurred_at DESC);
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

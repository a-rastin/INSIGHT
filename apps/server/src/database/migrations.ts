import { createHash, randomBytes } from "node:crypto";

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
  {
    version: 6,
    name: "patient_identity_and_research_case",
    dataVersion: "application-encryption-key-v1",
    sql: `
      CREATE TYPE insight.patient_sex AS ENUM ('MALE', 'FEMALE');

      CREATE TABLE insight.application_encryption_keys (
        version integer PRIMARY KEY CHECK (version > 0),
        key_material bytea NOT NULL CHECK (octet_length(key_material) = 32),
        active boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE UNIQUE INDEX application_encryption_keys_one_active
        ON insight.application_encryption_keys (active)
        WHERE active;

      CREATE TABLE insight.patients (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        official_identifier_type text NOT NULL CHECK (
          official_identifier_type = btrim(official_identifier_type)
          AND official_identifier_type <> ''
          AND char_length(official_identifier_type) <= 128
        ),
        official_identifier_issuer text NOT NULL CHECK (
          official_identifier_issuer = btrim(official_identifier_issuer)
          AND official_identifier_issuer <> ''
          AND char_length(official_identifier_issuer) <= 256
        ),
        official_identifier_lookup_hash bytea NOT NULL
          CHECK (octet_length(official_identifier_lookup_hash) = 32),
        official_identifier_ciphertext bytea NOT NULL,
        official_identifier_iv bytea NOT NULL CHECK (octet_length(official_identifier_iv) = 12),
        official_identifier_tag bytea NOT NULL CHECK (octet_length(official_identifier_tag) = 16),
        first_name_ciphertext bytea NOT NULL,
        first_name_iv bytea NOT NULL CHECK (octet_length(first_name_iv) = 12),
        first_name_tag bytea NOT NULL CHECK (octet_length(first_name_tag) = 16),
        last_name_ciphertext bytea NOT NULL,
        last_name_iv bytea NOT NULL CHECK (octet_length(last_name_iv) = 12),
        last_name_tag bytea NOT NULL CHECK (octet_length(last_name_tag) = 16),
        date_of_birth_ciphertext bytea NOT NULL,
        date_of_birth_iv bytea NOT NULL CHECK (octet_length(date_of_birth_iv) = 12),
        date_of_birth_tag bytea NOT NULL CHECK (octet_length(date_of_birth_tag) = 16),
        encryption_key_version integer NOT NULL
          REFERENCES insight.application_encryption_keys(version),
        sex insight.patient_sex NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT patients_official_identifier_unique UNIQUE (
          official_identifier_type,
          official_identifier_issuer,
          official_identifier_lookup_hash
        )
      );

      CREATE TABLE insight.research_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id uuid NOT NULL UNIQUE REFERENCES insight.patients(id) ON DELETE CASCADE,
        started_at timestamptz NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE insight.patient_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL CHECK (event_type IN (
          'PATIENT_CREATED', 'PATIENT_DEMOGRAPHICS_SAVED'
        )),
        patient_id uuid NOT NULL,
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        request_id uuid NOT NULL,
        before_values_ciphertext bytea,
        before_values_iv bytea CHECK (
          before_values_iv IS NULL OR octet_length(before_values_iv) = 12
        ),
        before_values_tag bytea CHECK (
          before_values_tag IS NULL OR octet_length(before_values_tag) = 16
        ),
        after_values_ciphertext bytea NOT NULL,
        after_values_iv bytea NOT NULL CHECK (octet_length(after_values_iv) = 12),
        after_values_tag bytea NOT NULL CHECK (octet_length(after_values_tag) = 16),
        encryption_key_version integer NOT NULL
          REFERENCES insight.application_encryption_keys(version),
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (
          (before_values_ciphertext IS NULL AND before_values_iv IS NULL AND before_values_tag IS NULL)
          OR
          (before_values_ciphertext IS NOT NULL AND before_values_iv IS NOT NULL AND before_values_tag IS NOT NULL)
        )
      );

      CREATE INDEX patient_audit_events_patient_occurred_idx
        ON insight.patient_audit_events (patient_id, occurred_at, id);

      CREATE FUNCTION insight.protect_patient_audit_event()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'patient audit events are immutable' USING ERRCODE = '55000';
      END;
      $function$;

      CREATE TRIGGER patient_audit_events_immutable
      BEFORE UPDATE OR DELETE ON insight.patient_audit_events
      FOR EACH ROW EXECUTE FUNCTION insight.protect_patient_audit_event();
    `,
    run: async (client) => {
      await client.query(
        `INSERT INTO insight.application_encryption_keys (version, key_material, active)
         VALUES (1, $1, true)`,
        [randomBytes(32)],
      );
    },
  },
  {
    version: 7,
    name: "operational_and_clinical_audit",
    sql: `
      ALTER TABLE insight.security_audit_events
        DROP CONSTRAINT security_audit_events_event_type_check;

      ALTER TABLE insight.security_audit_events
        ADD CONSTRAINT security_audit_events_event_type_check CHECK (event_type IN (
          'SIGN_IN', 'FAILED_SIGN_IN', 'SIGN_OUT', 'USER_CREATED', 'USER_RENAMED',
          'PASSWORD_CHANGED', 'PASSWORD_REHASHED', 'PASSWORD_RESET',
          'ACCOUNT_ENABLED', 'ACCOUNT_DISABLED', 'SESSIONS_REVOKED'
        ));

      ALTER TABLE insight.security_audit_events
        ADD COLUMN target_version timestamptz,
        ADD COLUMN before_metadata jsonb,
        ADD COLUMN after_metadata jsonb;

      ALTER TABLE insight.patients
        ADD COLUMN record_version bigint NOT NULL DEFAULT 1 CHECK (record_version > 0);

      ALTER TABLE insight.patient_audit_events DISABLE TRIGGER patient_audit_events_immutable;

      ALTER TABLE insight.patient_audit_events
        ADD COLUMN research_case_id uuid,
        ADD COLUMN target_version bigint NOT NULL DEFAULT 1 CHECK (target_version > 0),
        ADD COLUMN payload_reference text;

      UPDATE insight.patient_audit_events audit
      SET research_case_id = research_case.id
      FROM insight.research_cases research_case
      WHERE research_case.patient_id = audit.patient_id;

      WITH versions AS (
        SELECT id,
               row_number() OVER (PARTITION BY patient_id ORDER BY occurred_at, id) AS version
        FROM insight.patient_audit_events
      )
      UPDATE insight.patient_audit_events audit
      SET target_version = versions.version
      FROM versions
      WHERE versions.id = audit.id;

      UPDATE insight.patients patient
      SET record_version = audit.version
      FROM (
        SELECT patient_id, max(target_version) AS version
        FROM insight.patient_audit_events
        GROUP BY patient_id
      ) audit
      WHERE audit.patient_id = patient.id;

      ALTER TABLE insight.patient_audit_events
        ALTER COLUMN research_case_id SET NOT NULL;

      COMMENT ON COLUMN insight.patient_audit_events.patient_id IS
        'Original Patient UUID retained without a foreign key so clinical audit survives Patient hard deletion';
      COMMENT ON COLUMN insight.patient_audit_events.research_case_id IS
        'Original Research Case UUID retained without a foreign key so clinical audit survives Patient hard deletion';
      COMMENT ON COLUMN insight.patient_audit_events.payload_reference IS
        'Optional reference to a retained clinical audit payload artifact; inline encrypted payloads remain authoritative when null';

      DROP TRIGGER patient_audit_events_immutable ON insight.patient_audit_events;
      DROP FUNCTION insight.protect_patient_audit_event();

      CREATE FUNCTION insight.reject_audit_row_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'audit row update/delete is not allowed through normal database writes'
          USING ERRCODE = '55000';
      END;
      $function$;

      CREATE TRIGGER security_audit_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.security_audit_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();

      CREATE TRIGGER operational_audit_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.operational_audit_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();

      CREATE TRIGGER patient_audit_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.patient_audit_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();

      CREATE INDEX security_audit_events_target_idx
        ON insight.security_audit_events (subject_user_id, occurred_at, id);
    `,
  },
  {
    version: 8,
    name: "research_case_workflow",
    sql: `
      CREATE TYPE insight.research_case_workflow_state AS ENUM (
        'DATA_COLLECTION',
        'NORMALIZING_MEDICATIONS',
        'IMPUTING_BYPASSED_ASSESSMENTS',
        'ROUTING_BN',
        'GENERATING_CPTS',
        'RUNNING_BN',
        'CHECKING_PRIMARY_DDI',
        'GENERATING_PRIMARY_PLAN',
        'CLINICIAN_REVIEW',
        'RECHECKING_FINAL_DDI',
        'READY_TO_FINALIZE',
        'FINALIZED',
        'REVISION_DRAFT',
        'DELETED'
      );

      CREATE TYPE insight.assessment_status AS ENUM (
        'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BYPASSED'
      );

      ALTER TABLE insight.research_cases
        ADD COLUMN workflow_state insight.research_case_workflow_state
          NOT NULL DEFAULT 'DATA_COLLECTION',
        ADD COLUMN workflow_revision bigint NOT NULL DEFAULT 1
          CHECK (workflow_revision > 0),
        ADD COLUMN input_revision bigint NOT NULL DEFAULT 1
          CHECK (input_revision > 0),
        ADD COLUMN last_input_invalidation_at timestamptz,
        ADD COLUMN last_input_invalidation_reason text;

      CREATE TABLE insight.research_case_assessments (
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        assessment_type text NOT NULL CHECK (
          assessment_type IN ('DSM5TR', 'PANSS', 'CSSRS_RECENT')
        ),
        status insight.assessment_status NOT NULL DEFAULT 'NOT_STARTED',
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (research_case_id, assessment_type)
      );

      INSERT INTO insight.research_case_assessments
        (research_case_id, assessment_type, updated_by_user_id, updated_at)
      SELECT research_case.id, assessment_type, research_case.created_by_user_id,
             research_case.created_at
      FROM insight.research_cases research_case
      CROSS JOIN unnest(ARRAY['DSM5TR', 'PANSS', 'CSSRS_RECENT']) AS assessment_type;

      CREATE FUNCTION insight.initialize_research_case_assessments()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        INSERT INTO insight.research_case_assessments
          (research_case_id, assessment_type, updated_by_user_id, updated_at)
        SELECT NEW.id, assessment_type, NEW.created_by_user_id, NEW.created_at
        FROM unnest(ARRAY['DSM5TR', 'PANSS', 'CSSRS_RECENT']) AS assessment_type;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER research_cases_initialize_assessments
      AFTER INSERT ON insight.research_cases
      FOR EACH ROW EXECUTE FUNCTION insight.initialize_research_case_assessments();

      CREATE TABLE insight.research_case_domain_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        result_type text NOT NULL CHECK (result_type IN (
          'DATA_COLLECTION_VALIDATED', 'MEDICATION_NORMALIZATION',
          'ASSESSMENT_IMPUTATION', 'BN_ROUTING', 'CPT_SNAPSHOT',
          'BN_INFERENCE', 'PRIMARY_DDI', 'PRIMARY_PLAN',
          'REGIMEN_UNCHANGED', 'FINAL_DDI'
        )),
        status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
        workflow_revision bigint NOT NULL CHECK (workflow_revision > 0),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        result_reference text NOT NULL CHECK (
          result_reference = btrim(result_reference)
          AND result_reference <> ''
          AND char_length(result_reference) <= 500
        ),
        provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
        recorded_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        invalidated_at timestamptz,
        invalidated_by_user_id uuid REFERENCES insight.users(id),
        invalidation_reason text,
        CHECK (
          (invalidated_at IS NULL AND invalidated_by_user_id IS NULL AND invalidation_reason IS NULL)
          OR
          (invalidated_at IS NOT NULL AND invalidated_by_user_id IS NOT NULL AND invalidation_reason IS NOT NULL)
        )
      );

      CREATE INDEX research_case_domain_results_current_idx
        ON insight.research_case_domain_results
          (research_case_id, input_revision, result_type, recorded_at DESC, id DESC)
        WHERE invalidated_at IS NULL;

      CREATE FUNCTION insight.protect_research_case_domain_result()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.workflow_transition', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'research case domain results are service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER research_case_domain_results_service_owned
      BEFORE INSERT OR UPDATE ON insight.research_case_domain_results
      FOR EACH ROW EXECUTE FUNCTION insight.protect_research_case_domain_result();

      CREATE TABLE insight.research_case_transition_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL,
        patient_id uuid NOT NULL,
        command text NOT NULL,
        from_state insight.research_case_workflow_state NOT NULL,
        to_state insight.research_case_workflow_state NOT NULL,
        from_revision bigint NOT NULL CHECK (from_revision > 0),
        to_revision bigint NOT NULL CHECK (to_revision = from_revision + 1),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        request_id uuid NOT NULL,
        domain_result_ids uuid[] NOT NULL DEFAULT '{}',
        provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX research_case_transition_events_case_idx
        ON insight.research_case_transition_events
          (research_case_id, to_revision, occurred_at, id);

      CREATE TRIGGER research_case_transition_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.research_case_transition_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();

      CREATE FUNCTION insight.protect_research_case_workflow_state()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF (
          OLD.workflow_state IS DISTINCT FROM NEW.workflow_state
          OR OLD.workflow_revision IS DISTINCT FROM NEW.workflow_revision
          OR OLD.input_revision IS DISTINCT FROM NEW.input_revision
          OR OLD.last_input_invalidation_at IS DISTINCT FROM NEW.last_input_invalidation_at
          OR OLD.last_input_invalidation_reason IS DISTINCT FROM NEW.last_input_invalidation_reason
        ) AND current_setting('insight.workflow_transition', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'research case workflow state is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER research_cases_protect_workflow_state
      BEFORE UPDATE ON insight.research_cases
      FOR EACH ROW EXECUTE FUNCTION insight.protect_research_case_workflow_state();
    `,
  },
  {
    version: 9,
    name: "patient_hard_deletion_audit",
    sql: `
      ALTER TABLE insight.patient_audit_events
        DROP CONSTRAINT patient_audit_events_event_type_check;

      ALTER TABLE insight.patient_audit_events
        ADD CONSTRAINT patient_audit_events_event_type_check CHECK (event_type IN (
          'PATIENT_CREATED', 'PATIENT_DEMOGRAPHICS_SAVED', 'PATIENT_DELETED'
        )),
        ALTER COLUMN after_values_ciphertext DROP NOT NULL,
        ALTER COLUMN after_values_iv DROP NOT NULL,
        ALTER COLUMN after_values_tag DROP NOT NULL;

      ALTER TABLE insight.patient_audit_events
        ADD CONSTRAINT patient_audit_events_after_values_presence_check CHECK (
          (after_values_ciphertext IS NULL AND after_values_iv IS NULL AND after_values_tag IS NULL)
          OR
          (after_values_ciphertext IS NOT NULL AND after_values_iv IS NOT NULL AND after_values_tag IS NOT NULL)
        );

      INSERT INTO insight.patient_audit_events (
        event_type, patient_id, research_case_id, target_version, actor_user_id, request_id,
        before_values_ciphertext, before_values_iv, before_values_tag,
        after_values_ciphertext, after_values_iv, after_values_tag,
        encryption_key_version, occurred_at
      )
      SELECT 'PATIENT_DELETED', patient.id, research_case.id, patient.record_version + 1,
             transition.actor_user_id, coalesce(transition.request_id, gen_random_uuid()),
             audit.after_values_ciphertext, audit.after_values_iv, audit.after_values_tag,
             NULL, NULL, NULL, audit.encryption_key_version,
             coalesce(transition.occurred_at, clock_timestamp())
      FROM insight.patients patient
      JOIN insight.research_cases research_case
        ON research_case.patient_id = patient.id
       AND research_case.workflow_state = 'DELETED'
      LEFT JOIN LATERAL (
        SELECT after_values_ciphertext, after_values_iv, after_values_tag,
               encryption_key_version
        FROM insight.patient_audit_events
        WHERE patient_id = patient.id AND after_values_ciphertext IS NOT NULL
        ORDER BY target_version DESC, occurred_at DESC, id DESC
        LIMIT 1
      ) audit ON true
      JOIN LATERAL (
        SELECT actor_user_id, request_id, occurred_at
        FROM insight.research_case_transition_events
        WHERE patient_id = patient.id AND command = 'DELETE'
        ORDER BY to_revision DESC, occurred_at DESC, id DESC
        LIMIT 1
      ) transition ON true;

      DELETE FROM insight.patients patient
      USING insight.research_cases research_case
      WHERE research_case.patient_id = patient.id
        AND research_case.workflow_state = 'DELETED';
    `,
  },
  {
    version: 10,
    name: "dsm5tr_assessment",
    sql: `
      CREATE TABLE insight.dsm5tr_assessments (
        research_case_id uuid PRIMARY KEY
          REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        status insight.assessment_status NOT NULL CHECK (
          status IN ('IN_PROGRESS', 'COMPLETED', 'BYPASSED')
        ),
        answers jsonb,
        calculation_result jsonb,
        psychiatrist_decision text CHECK (
          psychiatrist_decision IN (
            'UNDECIDED', 'SCHIZOPHRENIA_CONFIRMED', 'SCHIZOPHRENIA_NOT_CONFIRMED'
          )
        ),
        instrument_id text NOT NULL CHECK (instrument_id = 'DSM5TR_SCHIZOPHRENIA'),
        instrument_version text NOT NULL CHECK (instrument_version = 'DSM-5-TR-2022'),
        schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
        calculation_version text CHECK (calculation_version = '1.0.0'),
        source_reference text NOT NULL,
        review_reference text NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (answers IS NULL OR jsonb_typeof(answers) = 'object'),
        CHECK (calculation_result IS NULL OR jsonb_typeof(calculation_result) = 'object'),
        CHECK (
          (status = 'BYPASSED'
            AND answers IS NULL
            AND calculation_result IS NULL
            AND calculation_version IS NULL
            AND psychiatrist_decision IS NULL)
          OR
          (status = 'IN_PROGRESS'
            AND answers IS NOT NULL
            AND calculation_result IS NOT NULL
            AND calculation_version IS NOT NULL
            AND psychiatrist_decision IS NOT NULL)
          OR
          (status = 'COMPLETED'
            AND answers IS NOT NULL
            AND calculation_result IS NOT NULL
            AND calculation_version IS NOT NULL
            AND psychiatrist_decision IN (
              'SCHIZOPHRENIA_CONFIRMED', 'SCHIZOPHRENIA_NOT_CONFIRMED'
            ))
        )
      );

      COMMENT ON COLUMN insight.dsm5tr_assessments.psychiatrist_decision IS
        'Independent clinical authority; never derived from calculation_result';

      INSERT INTO insight.dsm5tr_assessments (
        research_case_id, status, instrument_id, instrument_version, schema_version,
        source_reference, review_reference, created_by_user_id, updated_by_user_id,
        created_at, updated_at
      )
      SELECT research_case_id, 'BYPASSED', 'DSM5TR_SCHIZOPHRENIA', 'DSM-5-TR-2022',
             '1.0.0',
             'https://doi.org/10.1176/appi.books.9780890425787.x02_Schizophrenia_Spectrum',
             'ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW',
             updated_by_user_id, updated_by_user_id, updated_at, updated_at
      FROM insight.research_case_assessments
      WHERE assessment_type = 'DSM5TR' AND status = 'BYPASSED';

      UPDATE insight.research_case_assessments
      SET status = 'NOT_STARTED'
      WHERE assessment_type = 'DSM5TR' AND status <> 'BYPASSED';

      CREATE FUNCTION insight.protect_dsm5tr_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.dsm5tr_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'DSM-5-TR assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER dsm5tr_assessments_service_owned
      BEFORE INSERT OR UPDATE ON insight.dsm5tr_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_dsm5tr_write();

      CREATE TRIGGER dsm5tr_summary_service_owned
      BEFORE UPDATE ON insight.research_case_assessments
      FOR EACH ROW
      WHEN (OLD.assessment_type = 'DSM5TR' AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION insight.protect_dsm5tr_write();
    `,
  },
  {
    version: 11,
    name: "panss_assessment",
    sql: `
      CREATE TABLE insight.panss_assessments (
        research_case_id uuid PRIMARY KEY
          REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        status insight.assessment_status NOT NULL CHECK (
          status IN ('IN_PROGRESS', 'COMPLETED', 'BYPASSED')
        ),
        answers jsonb,
        calculation_result jsonb,
        instrument_id text NOT NULL CHECK (instrument_id = 'PANSS_30'),
        instrument_version text NOT NULL CHECK (
          instrument_version = 'KAY-OPLER-FISZBEIN-1987'
        ),
        schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
        calculation_version text CHECK (calculation_version = '1.0.0'),
        source_reference text NOT NULL,
        review_reference text NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (answers IS NULL OR jsonb_typeof(answers) = 'object'),
        CHECK (calculation_result IS NULL OR jsonb_typeof(calculation_result) = 'object'),
        CHECK (
          (status = 'BYPASSED'
            AND answers IS NULL
            AND calculation_result IS NULL
            AND calculation_version IS NULL)
          OR
          (status = 'IN_PROGRESS'
            AND answers IS NOT NULL
            AND calculation_result->>'status' = 'INCOMPLETE'
            AND calculation_result->'scores' = 'null'::jsonb
            AND calculation_version IS NOT NULL)
          OR
          (status = 'COMPLETED'
            AND answers IS NOT NULL
            AND calculation_result->>'status' = 'COMPLETE'
            AND jsonb_typeof(calculation_result->'scores') = 'object'
            AND calculation_version IS NOT NULL)
        )
      );

      INSERT INTO insight.panss_assessments (
        research_case_id, status, instrument_id, instrument_version, schema_version,
        source_reference, review_reference, created_by_user_id, updated_by_user_id,
        created_at, updated_at
      )
      SELECT research_case_id, 'BYPASSED', 'PANSS_30', 'KAY-OPLER-FISZBEIN-1987',
             '1.0.0', 'https://doi.org/10.1093/schbul/13.2.261',
             'ENGINEERING-BASELINE-2026-08-22-PENDING-CLINICAL-REVIEW',
             updated_by_user_id, updated_by_user_id, updated_at, updated_at
      FROM insight.research_case_assessments
      WHERE assessment_type = 'PANSS' AND status = 'BYPASSED';

      UPDATE insight.research_case_assessments
      SET status = 'NOT_STARTED'
      WHERE assessment_type = 'PANSS' AND status <> 'BYPASSED';

      CREATE FUNCTION insight.protect_panss_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.panss_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'PANSS assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER panss_assessments_service_owned
      BEFORE INSERT OR UPDATE ON insight.panss_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_panss_write();

      CREATE TRIGGER panss_summary_service_owned
      BEFORE UPDATE ON insight.research_case_assessments
      FOR EACH ROW
      WHEN (OLD.assessment_type = 'PANSS' AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION insight.protect_panss_write();
    `,
  },
  {
    version: 12,
    name: "cssrs_recent_assessment",
    sql: `
      CREATE TABLE insight.cssrs_recent_assessments (
        research_case_id uuid PRIMARY KEY
          REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        status insight.assessment_status NOT NULL CHECK (
          status IN ('IN_PROGRESS', 'COMPLETED', 'BYPASSED')
        ),
        answers jsonb,
        calculation_result jsonb,
        instrument_id text NOT NULL CHECK (instrument_id = 'C_SSRS_SCREEN_RECENT'),
        instrument_version text NOT NULL CHECK (
          instrument_version =
            'LOCAL-PDF-SHA256-8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2'
        ),
        schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
        calculation_version text CHECK (calculation_version = '1.0.0'),
        source_reference text NOT NULL CHECK (
          source_reference = 'medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf'
        ),
        source_sha256 text NOT NULL CHECK (
          source_sha256 = '8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2'
        ),
        review_reference text NOT NULL CHECK (
          review_reference = 'CSSRS-CLINICAL-REVIEW-2026-08-22-PENDING'
        ),
        research_activation_status text NOT NULL CHECK (
          research_activation_status = 'INACTIVE'
        ),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (answers IS NULL OR jsonb_typeof(answers) = 'object'),
        CHECK (calculation_result IS NULL OR jsonb_typeof(calculation_result) = 'object'),
        CHECK (
          (status = 'BYPASSED'
            AND answers IS NULL
            AND calculation_result IS NULL
            AND calculation_version IS NULL)
          OR
          (status = 'IN_PROGRESS'
            AND answers IS NOT NULL
            AND calculation_version IS NOT NULL
            AND (
              (calculation_result->>'status' = 'INCOMPLETE'
                AND calculation_result->'band' = 'null'::jsonb)
              OR
              (calculation_result->>'status' = 'COMPLETE'
                AND calculation_result->>'band' IN (
                  'LOW', 'MODERATE', 'HIGH', 'NO_POSITIVE_RESPONSE'
                ))
            ))
          OR
          (status = 'COMPLETED'
            AND answers IS NOT NULL
            AND calculation_result->>'status' = 'COMPLETE'
            AND calculation_result->>'band' IN (
              'LOW', 'MODERATE', 'HIGH', 'NO_POSITIVE_RESPONSE'
            )
            AND calculation_version IS NOT NULL)
        )
      );

      INSERT INTO insight.cssrs_recent_assessments (
        research_case_id, status, instrument_id, instrument_version, schema_version,
        source_reference, source_sha256, review_reference, research_activation_status,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      )
      SELECT research_case_id, 'BYPASSED', 'C_SSRS_SCREEN_RECENT',
             'LOCAL-PDF-SHA256-8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2',
             '1.0.0', 'medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf',
             '8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2',
             'CSSRS-CLINICAL-REVIEW-2026-08-22-PENDING', 'INACTIVE',
             updated_by_user_id, updated_by_user_id, updated_at, updated_at
      FROM insight.research_case_assessments
      WHERE assessment_type = 'CSSRS_RECENT' AND status = 'BYPASSED';

      UPDATE insight.research_case_assessments
      SET status = 'NOT_STARTED'
      WHERE assessment_type = 'CSSRS_RECENT' AND status <> 'BYPASSED';

      CREATE FUNCTION insight.protect_cssrs_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.cssrs_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'C-SSRS assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER cssrs_recent_assessments_service_owned
      BEFORE INSERT OR UPDATE ON insight.cssrs_recent_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_cssrs_write();

      CREATE TRIGGER cssrs_summary_service_owned
      BEFORE UPDATE ON insight.research_case_assessments
      FOR EACH ROW
      WHEN (OLD.assessment_type = 'CSSRS_RECENT' AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION insight.protect_cssrs_write();
    `,
  },
  {
    version: 13,
    name: "shared_assessment_autosave",
    sql: `
      CREATE TABLE insight.assessment_save_events (
        id bigserial PRIMARY KEY,
        research_case_id uuid NOT NULL,
        assessment_type text NOT NULL CHECK (
          assessment_type IN ('DSM5TR', 'PANSS', 'CSSRS_RECENT')
        ),
        status insight.assessment_status NOT NULL,
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX assessment_save_events_case_idx
        ON insight.assessment_save_events (research_case_id, assessment_type, id);

      CREATE TRIGGER assessment_save_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.assessment_save_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();

      DROP TRIGGER dsm5tr_assessments_service_owned ON insight.dsm5tr_assessments;
      CREATE TRIGGER dsm5tr_assessments_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.dsm5tr_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_dsm5tr_write();

      DROP TRIGGER panss_assessments_service_owned ON insight.panss_assessments;
      CREATE TRIGGER panss_assessments_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.panss_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_panss_write();

      DROP TRIGGER cssrs_recent_assessments_service_owned
        ON insight.cssrs_recent_assessments;
      CREATE TRIGGER cssrs_recent_assessments_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.cssrs_recent_assessments
      FOR EACH ROW EXECUTE FUNCTION insight.protect_cssrs_write();
    `,
  },
  {
    version: 14,
    name: "assessment_bypass_payload_deletion",
    sql: `
      CREATE OR REPLACE FUNCTION insight.protect_dsm5tr_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.dsm5tr_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'DSM-5-TR assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION insight.protect_panss_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.panss_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'PANSS assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION insight.protect_cssrs_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.cssrs_write', true) IS DISTINCT FROM 'allowed'
        THEN
          RAISE EXCEPTION 'C-SSRS assessment data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;

      SELECT set_config('insight.dsm5tr_write', 'allowed', true);
      SELECT set_config('insight.panss_write', 'allowed', true);
      SELECT set_config('insight.cssrs_write', 'allowed', true);
      DELETE FROM insight.dsm5tr_assessments WHERE status = 'BYPASSED';
      DELETE FROM insight.panss_assessments WHERE status = 'BYPASSED';
      DELETE FROM insight.cssrs_recent_assessments WHERE status = 'BYPASSED';
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

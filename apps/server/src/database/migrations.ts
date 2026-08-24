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
  {
    version: 15,
    name: "medical_history",
    sql: `
      CREATE TYPE insight.presentation_status AS ENUM (
        'FIRST_PRESENTATION', 'KNOWN_SCHIZOPHRENIA'
      );
      CREATE TYPE insight.trial_response AS ENUM (
        'FULL_RESPONSE', 'PARTIAL_RESPONSE', 'NO_RESPONSE', 'WORSENED', 'UNKNOWN'
      );
      CREATE TYPE insight.contraindication_outcome AS ENUM (
        'CONTRAINDICATED', 'CAUTION', 'MONITORING_REQUIRED', 'UNKNOWN'
      );

      CREATE TABLE insight.medical_histories (
        research_case_id uuid PRIMARY KEY
          REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        presentation_status insight.presentation_status NOT NULL,
        previously_treated boolean,
        supplemental_notes text CHECK (
          supplemental_notes IS NULL OR (
            supplemental_notes = btrim(supplemental_notes)
            AND supplemental_notes <> '' AND char_length(supplemental_notes) <= 10000
          )
        ),
        revision bigint NOT NULL CHECK (revision > 0),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK (
          (presentation_status = 'FIRST_PRESENTATION' AND previously_treated IS NULL)
          OR
          (presentation_status = 'KNOWN_SCHIZOPHRENIA' AND previously_treated IS NOT NULL)
        )
      );

      CREATE TABLE insight.prior_antipsychotic_trials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL
          REFERENCES insight.medical_histories(research_case_id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        medication text NOT NULL CHECK (
          medication = btrim(medication) AND medication <> '' AND char_length(medication) <= 500
        ),
        normalization_state text CHECK (normalization_state IN ('NORMALIZED', 'UNKNOWN')),
        canonical_medication_id text,
        dose text,
        dose_unit text,
        treatment_start date,
        treatment_end date,
        approximate_period text,
        response insight.trial_response,
        adverse_effects jsonb CHECK (
          adverse_effects IS NULL OR jsonb_typeof(adverse_effects) = 'array'
        ),
        other_adverse_effect_detail text,
        discontinuation_reason text,
        notes text,
        UNIQUE (research_case_id, position),
        CHECK (treatment_end IS NULL OR treatment_start IS NULL OR treatment_end >= treatment_start),
        CHECK (
          (normalization_state = 'NORMALIZED' AND canonical_medication_id IS NOT NULL)
          OR (normalization_state IS DISTINCT FROM 'NORMALIZED' AND canonical_medication_id IS NULL)
        )
      );

      CREATE TABLE insight.current_medication_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL
          REFERENCES insight.medical_histories(research_case_id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        raw_medication text NOT NULL CHECK (
          raw_medication = btrim(raw_medication) AND raw_medication <> ''
          AND char_length(raw_medication) <= 500
        ),
        normalization_state text CHECK (normalization_state IN ('NORMALIZED', 'UNKNOWN')),
        canonical_medication_id text,
        dose text,
        dose_unit text,
        route text,
        frequency text,
        UNIQUE (research_case_id, position),
        CHECK (
          (normalization_state = 'NORMALIZED' AND canonical_medication_id IS NOT NULL)
          OR (normalization_state IS DISTINCT FROM 'NORMALIZED' AND canonical_medication_id IS NULL)
        )
      );

      CREATE TABLE insight.comorbidity_selections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL
          REFERENCES insight.medical_histories(research_case_id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        catalog_version_id text NOT NULL,
        term_id text NOT NULL,
        supplemental_text text,
        UNIQUE (research_case_id, position),
        UNIQUE (research_case_id, catalog_version_id, term_id)
      );

      CREATE TABLE insight.contraindication_outputs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL
          REFERENCES insight.medical_histories(research_case_id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        rule_version_id text NOT NULL,
        rule_id text NOT NULL,
        outcome insight.contraindication_outcome NOT NULL,
        explanation text,
        UNIQUE (research_case_id, position),
        UNIQUE (research_case_id, rule_version_id, rule_id)
      );

      CREATE TABLE insight.medical_history_save_events (
        id bigserial PRIMARY KEY,
        research_case_id uuid NOT NULL,
        patient_id uuid NOT NULL,
        revision bigint NOT NULL CHECK (revision > 0),
        presentation_status insight.presentation_status NOT NULL,
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        request_id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        UNIQUE (research_case_id, revision)
      );

      CREATE INDEX medical_history_save_events_case_idx
        ON insight.medical_history_save_events (research_case_id, revision, id);

      CREATE FUNCTION insight.protect_medical_history_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('insight.medical_history_write', true) IS DISTINCT FROM 'allowed'
           AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
        THEN
          RAISE EXCEPTION 'medical history data is service-owned'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;

      CREATE TRIGGER medical_histories_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.medical_histories
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER prior_trials_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.prior_antipsychotic_trials
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER current_medications_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.current_medication_entries
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER comorbidities_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.comorbidity_selections
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER contraindications_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.contraindication_outputs
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER medical_history_save_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.medical_history_save_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();
    `,
  },
  {
    version: 16,
    name: "adverse_effect_catalog",
    sql: `
      CREATE TABLE insight.adverse_effect_catalog_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version integer NOT NULL UNIQUE CHECK (version > 0),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE insight.adverse_effect_catalog_terms (
        catalog_version_id uuid NOT NULL
          REFERENCES insight.adverse_effect_catalog_versions(id),
        term_id text NOT NULL CHECK (
          term_id = btrim(term_id) AND term_id <> '' AND char_length(term_id) <= 200
        ),
        label text NOT NULL CHECK (
          label = btrim(label) AND label <> '' AND char_length(label) <= 500
        ),
        position integer NOT NULL CHECK (position >= 0),
        PRIMARY KEY (catalog_version_id, term_id),
        UNIQUE (catalog_version_id, position)
      );

      CREATE TABLE insight.adverse_effect_catalog_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        active_version_id uuid REFERENCES insight.adverse_effect_catalog_versions(id),
        activated_by_user_id uuid REFERENCES insight.users(id),
        activated_at timestamptz,
        CHECK (
          (active_version_id IS NULL AND activated_by_user_id IS NULL AND activated_at IS NULL)
          OR
          (active_version_id IS NOT NULL AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
        )
      );
      INSERT INTO insight.adverse_effect_catalog_state (singleton) VALUES (true);

      CREATE FUNCTION insight.reject_adverse_effect_catalog_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF TG_OP = 'INSERT'
           AND current_setting('insight.adverse_effect_catalog_write', true) = 'allowed'
        THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'adverse-effect catalog versions are immutable'
          USING ERRCODE = '55000';
      END;
      $function$;

      CREATE TRIGGER adverse_effect_catalog_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.adverse_effect_catalog_versions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_adverse_effect_catalog_mutation();
      CREATE TRIGGER adverse_effect_catalog_terms_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON insight.adverse_effect_catalog_terms
      FOR EACH ROW EXECUTE FUNCTION insight.reject_adverse_effect_catalog_mutation();
    `,
  },
  {
    version: 17,
    name: "comorbidity_knowledge",
    sql: `
      CREATE TABLE insight.comorbidity_knowledge_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version integer NOT NULL UNIQUE CHECK (version > 0),
        source_reference text NOT NULL CHECK (
          source_reference = btrim(source_reference) AND source_reference <> ''
          AND char_length(source_reference) <= 1000
        ),
        reviewer_id text NOT NULL CHECK (
          reviewer_id = btrim(reviewer_id) AND reviewer_id <> '' AND char_length(reviewer_id) <= 200
        ),
        reviewed_at timestamptz NOT NULL,
        reviewer_record_reference text NOT NULL CHECK (
          reviewer_record_reference = btrim(reviewer_record_reference)
          AND reviewer_record_reference <> '' AND char_length(reviewer_record_reference) <= 1000
        ),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL
      );

      CREATE TABLE insight.comorbidity_knowledge_terms (
        knowledge_version_id uuid NOT NULL REFERENCES insight.comorbidity_knowledge_versions(id),
        term_id text NOT NULL CHECK (
          term_id = btrim(term_id) AND term_id <> '' AND char_length(term_id) <= 200
        ),
        label text NOT NULL CHECK (
          label = btrim(label) AND label <> '' AND char_length(label) <= 500
        ),
        position integer NOT NULL CHECK (position >= 0),
        PRIMARY KEY (knowledge_version_id, term_id),
        UNIQUE (knowledge_version_id, position)
      );

      CREATE TABLE insight.comorbidity_knowledge_rules (
        knowledge_version_id uuid NOT NULL REFERENCES insight.comorbidity_knowledge_versions(id),
        rule_id text NOT NULL CHECK (
          rule_id = btrim(rule_id) AND rule_id <> '' AND char_length(rule_id) <= 200
        ),
        all_of_term_ids text[] NOT NULL CHECK (cardinality(all_of_term_ids) > 0),
        results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) > 0),
        PRIMARY KEY (knowledge_version_id, rule_id)
      );

      CREATE TABLE insight.comorbidity_knowledge_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        active_version_id uuid REFERENCES insight.comorbidity_knowledge_versions(id),
        activated_by_user_id uuid REFERENCES insight.users(id),
        activated_at timestamptz,
        CHECK (
          (active_version_id IS NULL AND activated_by_user_id IS NULL AND activated_at IS NULL)
          OR (active_version_id IS NOT NULL AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
        )
      );
      INSERT INTO insight.comorbidity_knowledge_state (singleton) VALUES (true);

      CREATE TABLE insight.comorbidity_rule_evaluations (
        research_case_id uuid PRIMARY KEY
          REFERENCES insight.medical_histories(research_case_id) ON DELETE CASCADE,
        knowledge_version_id uuid NOT NULL REFERENCES insight.comorbidity_knowledge_versions(id),
        knowledge_version integer NOT NULL CHECK (knowledge_version > 0)
      );

      CREATE TABLE insight.comorbidity_rule_results (
        research_case_id uuid NOT NULL
          REFERENCES insight.comorbidity_rule_evaluations(research_case_id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        knowledge_version_id uuid NOT NULL REFERENCES insight.comorbidity_knowledge_versions(id),
        knowledge_version integer NOT NULL CHECK (knowledge_version > 0),
        rule_id text NOT NULL,
        kind text NOT NULL CHECK (
          kind IN ('CONTRAINDICATION', 'CAUTION', 'MONITORING_REQUIREMENT', 'BN_ROUTING_FACT')
        ),
        target_id text NOT NULL,
        value text NOT NULL,
        explanation text NOT NULL,
        matched_term_ids text[] NOT NULL CHECK (cardinality(matched_term_ids) > 0),
        PRIMARY KEY (research_case_id, position),
        UNIQUE (research_case_id, kind, target_id)
      );

      CREATE FUNCTION insight.reject_comorbidity_knowledge_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'INSERT'
           AND current_setting('insight.comorbidity_knowledge_write', true) = 'allowed'
        THEN RETURN NEW;
        END IF;
        RAISE EXCEPTION 'comorbidity knowledge versions are immutable' USING ERRCODE = '55000';
      END;
      $function$;

      CREATE TRIGGER comorbidity_knowledge_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.comorbidity_knowledge_versions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_comorbidity_knowledge_mutation();
      CREATE TRIGGER comorbidity_knowledge_terms_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON insight.comorbidity_knowledge_terms
      FOR EACH ROW EXECUTE FUNCTION insight.reject_comorbidity_knowledge_mutation();
      CREATE TRIGGER comorbidity_knowledge_rules_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON insight.comorbidity_knowledge_rules
      FOR EACH ROW EXECUTE FUNCTION insight.reject_comorbidity_knowledge_mutation();
      CREATE TRIGGER comorbidity_rule_evaluations_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.comorbidity_rule_evaluations
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
      CREATE TRIGGER comorbidity_rule_results_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.comorbidity_rule_results
      FOR EACH ROW EXECUTE FUNCTION insight.protect_medical_history_write();
    `,
  },
  {
    version: 18,
    name: "model_endpoint_configuration",
    sql: `
      CREATE TABLE insight.model_endpoint_configurations (
        id uuid PRIMARY KEY,
        version integer NOT NULL UNIQUE CHECK (version > 0),
        base_url text NOT NULL CHECK (
          base_url = btrim(base_url) AND base_url <> '' AND char_length(base_url) <= 2000
        ),
        model text NOT NULL CHECK (
          model = btrim(model) AND model <> '' AND char_length(model) <= 500
        ),
        credential_ciphertext bytea,
        credential_iv bytea CHECK (credential_iv IS NULL OR octet_length(credential_iv) = 12),
        credential_tag bytea CHECK (credential_tag IS NULL OR octet_length(credential_tag) = 16),
        encryption_key_version integer REFERENCES insight.application_encryption_keys(version),
        compatibility_test_version text NOT NULL,
        configuration_fingerprint text NOT NULL CHECK (
          configuration_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (
          (credential_ciphertext IS NULL AND credential_iv IS NULL AND credential_tag IS NULL
            AND encryption_key_version IS NULL)
          OR
          (credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL
            AND credential_tag IS NOT NULL AND encryption_key_version IS NOT NULL)
        )
      );

      CREATE TABLE insight.model_endpoint_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        current_configuration_id uuid REFERENCES insight.model_endpoint_configurations(id),
        status text NOT NULL CHECK (status IN (
          'PENDING', 'CHECKING', 'COMPATIBLE', 'INCOMPATIBLE'
        )),
        failure_category text CHECK (failure_category IN (
          'AUTHENTICATION', 'ENDPOINT', 'RATE_LIMITED', 'PROVIDER', 'TIMEOUT',
          'MALFORMED_RESPONSE', 'TOOL_CALL', 'TOOL_ROUND_TRIP'
        )),
        returned_model text CHECK (returned_model IS NULL OR char_length(returned_model) <= 500),
        last_checked_at timestamptz,
        CHECK (status <> 'COMPATIBLE' OR failure_category IS NULL),
        CHECK (status <> 'INCOMPATIBLE' OR failure_category IS NOT NULL)
      );
      INSERT INTO insight.model_endpoint_state (singleton, status) VALUES (true, 'PENDING');

      CREATE TABLE insight.model_endpoint_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL CHECK (event_type IN (
          'MODEL_ENDPOINT_REPLACED', 'MODEL_ENDPOINT_CREDENTIAL_CLEARED'
        )),
        actor_user_id uuid REFERENCES insight.users(id) ON DELETE SET NULL,
        configuration_id uuid NOT NULL REFERENCES insight.model_endpoint_configurations(id),
        configuration_version integer NOT NULL CHECK (configuration_version > 0),
        base_url text NOT NULL,
        model text NOT NULL,
        request_id uuid,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE FUNCTION insight.reject_model_endpoint_configuration_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'model endpoint configuration versions are immutable'
          USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER model_endpoint_configurations_immutable
      BEFORE UPDATE OR DELETE ON insight.model_endpoint_configurations
      FOR EACH ROW EXECUTE FUNCTION insight.reject_model_endpoint_configuration_mutation();
      CREATE TRIGGER model_endpoint_audit_events_no_mutation
      BEFORE UPDATE OR DELETE ON insight.model_endpoint_audit_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();
    `,
  },
  {
    version: 19,
    name: "durable_jobs",
    sql: `
      CREATE TYPE insight.job_status AS ENUM (
        'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
      );

      CREATE TABLE insight.jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_type text NOT NULL CHECK (job_type ~ '^[A-Z][A-Z0-9_]{0,99}$'),
        research_case_id uuid NOT NULL
          REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        requested_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        requested_workflow_state insight.research_case_workflow_state NOT NULL,
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
        dependency_fingerprint text NOT NULL CHECK (dependency_fingerprint ~ '^[0-9a-f]{64}$'),
        command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
        payload_reference text NOT NULL CHECK (
          payload_reference = btrim(payload_reference) AND payload_reference <> ''
          AND char_length(payload_reference) <= 500
        ),
        status insight.job_status NOT NULL DEFAULT 'QUEUED',
        max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
        attempt_count integer NOT NULL DEFAULT 0 CHECK (
          attempt_count >= 0 AND attempt_count <= max_attempts
        ),
        lease_owner text CHECK (
          lease_owner IS NULL OR (lease_owner = btrim(lease_owner) AND lease_owner <> ''
          AND char_length(lease_owner) <= 200)
        ),
        lease_expires_at timestamptz,
        retry_eligible_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        idempotency_key text NOT NULL CHECK (
          idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
          AND char_length(idempotency_key) <= 200
        ),
        result_reference text CHECK (result_reference IS NULL OR (
          result_reference = btrim(result_reference) AND result_reference <> ''
          AND char_length(result_reference) <= 500
        )),
        provenance_reference text CHECK (provenance_reference IS NULL OR (
          provenance_reference = btrim(provenance_reference) AND provenance_reference <> ''
          AND char_length(provenance_reference) <= 500
        )),
        error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
        error_message text CHECK (
          error_message IS NULL OR (error_message <> '' AND char_length(error_message) <= 500)
        ),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        started_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (requested_by_user_id, research_case_id, job_type, idempotency_key),
        CHECK (
          (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (status <> 'RUNNING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        ),
        CHECK (
          (status = 'SUCCEEDED' AND result_reference IS NOT NULL
            AND provenance_reference IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
          OR (status = 'FAILED' AND result_reference IS NULL
            AND provenance_reference IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)
          OR (status IN ('QUEUED', 'RUNNING', 'CANCELLED')
            AND result_reference IS NULL AND provenance_reference IS NULL)
        ),
        CHECK (
          (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND completed_at IS NOT NULL)
          OR (status IN ('QUEUED', 'RUNNING') AND completed_at IS NULL)
        )
      );

      CREATE INDEX jobs_claim_idx
        ON insight.jobs (retry_eligible_at, created_at, id)
        WHERE status IN ('QUEUED', 'RUNNING');
      CREATE INDEX jobs_owner_idx
        ON insight.jobs (requested_by_user_id, created_at DESC, id);

      CREATE TABLE insight.job_events (
        job_id uuid NOT NULL REFERENCES insight.jobs(id) ON DELETE CASCADE,
        sequence bigint NOT NULL CHECK (sequence > 0),
        event_type text NOT NULL CHECK (event_type IN (
          'QUEUED', 'RUNNING', 'PROGRESS', 'RETRY_QUEUED',
          'SUCCEEDED', 'FAILED', 'CANCELLED'
        )),
        progress_code text CHECK (
          progress_code IS NULL OR progress_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
        ),
        completed_units integer CHECK (completed_units IS NULL OR completed_units >= 0),
        total_units integer CHECK (total_units IS NULL OR total_units > 0),
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (job_id, sequence),
        CHECK (completed_units IS NULL OR total_units IS NULL OR completed_units <= total_units),
        CHECK (
          (event_type = 'PROGRESS' AND progress_code IS NOT NULL)
          OR (event_type <> 'PROGRESS' AND progress_code IS NULL
            AND completed_units IS NULL AND total_units IS NULL)
        )
      );
    `,
  },
  {
    version: 20,
    name: "model_agent_executions",
    sql: `
      CREATE TABLE insight.model_agent_executions (
        id uuid PRIMARY KEY,
        job_id uuid NOT NULL UNIQUE REFERENCES insight.jobs(id) ON DELETE CASCADE,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        research_case_revision bigint NOT NULL CHECK (research_case_revision >= 0),
        input_revision bigint NOT NULL CHECK (input_revision >= 0),
        workflow_state insight.research_case_workflow_state NOT NULL,
        endpoint_configuration_id uuid NOT NULL
          REFERENCES insight.model_endpoint_configurations(id),
        endpoint_configuration_version integer NOT NULL CHECK (endpoint_configuration_version > 0),
        endpoint_fingerprint text NOT NULL CHECK (endpoint_fingerprint ~ '^[0-9a-f]{64}$'),
        prompt_version text NOT NULL CHECK (prompt_version <> ''),
        prompt text NOT NULL CHECK (prompt <> ''),
        input_schema jsonb NOT NULL CHECK (jsonb_typeof(input_schema) = 'object'),
        output_schema jsonb NOT NULL CHECK (jsonb_typeof(output_schema) = 'object'),
        input_payload jsonb NOT NULL,
        tool_manifest jsonb NOT NULL CHECK (jsonb_typeof(tool_manifest) = 'array'),
        settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
        trusted_context jsonb NOT NULL CHECK (jsonb_typeof(trusted_context) = 'object'),
        messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
        model_call_count integer NOT NULL DEFAULT 0 CHECK (model_call_count >= 0),
        tool_call_count integer NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
        consumed_tokens integer NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
        status text NOT NULL DEFAULT 'PENDING' CHECK (
          status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')
        ),
        output jsonb,
        failure_code text CHECK (
          failure_code IS NULL OR failure_code IN (
            'BUDGET_EXHAUSTED','ENDPOINT_EXHAUSTED','FINAL_SCHEMA_INVALID',
            'MALFORMED_MODEL_RESPONSE','STALE_RESEARCH_CASE_REVISION','TOOL_CALL_REJECTED'
          )
        ),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CHECK (
          (status = 'SUCCEEDED' AND output IS NOT NULL AND failure_code IS NULL
            AND completed_at IS NOT NULL)
          OR (status IN ('FAILED','CANCELLED') AND output IS NULL AND failure_code IS NOT NULL
            AND completed_at IS NOT NULL)
          OR (status IN ('PENDING','RUNNING') AND output IS NULL AND failure_code IS NULL
            AND completed_at IS NULL)
        )
      );

      CREATE FUNCTION insight.protect_model_agent_execution_pins()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF (NEW.job_id, NEW.research_case_id, NEW.research_case_revision, NEW.input_revision,
            NEW.workflow_state, NEW.endpoint_configuration_id, NEW.endpoint_configuration_version,
            NEW.endpoint_fingerprint, NEW.prompt_version, NEW.prompt, NEW.input_schema,
            NEW.output_schema, NEW.input_payload, NEW.tool_manifest, NEW.settings,
            NEW.trusted_context)
           IS DISTINCT FROM
           (OLD.job_id, OLD.research_case_id, OLD.research_case_revision, OLD.input_revision,
            OLD.workflow_state, OLD.endpoint_configuration_id, OLD.endpoint_configuration_version,
            OLD.endpoint_fingerprint, OLD.prompt_version, OLD.prompt, OLD.input_schema,
            OLD.output_schema, OLD.input_payload, OLD.tool_manifest, OLD.settings,
            OLD.trusted_context)
        THEN
          RAISE EXCEPTION 'model agent execution pins are immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER model_agent_execution_pins_immutable
      BEFORE UPDATE ON insight.model_agent_executions
      FOR EACH ROW EXECUTE FUNCTION insight.protect_model_agent_execution_pins();
    `,
  },
  {
    version: 21,
    name: "medication_catalog_and_mapping",
    sql: `
      CREATE TABLE insight.medication_catalog_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version integer NOT NULL UNIQUE CHECK (version > 0),
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE insight.medication_catalog_entries (
        catalog_version_id uuid NOT NULL REFERENCES insight.medication_catalog_versions(id),
        canonical_id text NOT NULL CHECK (
          canonical_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        ),
        preferred_name text NOT NULL CHECK (
          preferred_name = btrim(preferred_name) AND preferred_name <> ''
          AND char_length(preferred_name) <= 500
        ),
        synonyms text[] NOT NULL CHECK (cardinality(synonyms) <= 100),
        normalized_terms text[] NOT NULL CHECK (cardinality(normalized_terms) > 0),
        position integer NOT NULL CHECK (position >= 0),
        PRIMARY KEY (catalog_version_id, canonical_id),
        UNIQUE (catalog_version_id, position)
      );

      CREATE TABLE insight.medication_catalog_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        active_version_id uuid REFERENCES insight.medication_catalog_versions(id),
        activated_by_user_id uuid REFERENCES insight.users(id),
        activated_at timestamptz,
        CHECK (
          (active_version_id IS NULL AND activated_by_user_id IS NULL AND activated_at IS NULL)
          OR (active_version_id IS NOT NULL AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
        )
      );
      INSERT INTO insight.medication_catalog_state (singleton) VALUES (true);

      CREATE TABLE insight.medication_candidate_sets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_id text NOT NULL,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        medication_entry_ref text NOT NULL CHECK (
          medication_entry_ref ~ '^(current|prior)-[1-9][0-9]*$'
        ),
        catalog_version_id uuid NOT NULL REFERENCES insight.medication_catalog_versions(id),
        catalog_version integer NOT NULL CHECK (catalog_version > 0),
        raw_text text NOT NULL CHECK (raw_text <> '' AND char_length(raw_text) <= 500),
        normalized_text text NOT NULL CHECK (normalized_text <> ''),
        candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
        model text NOT NULL CHECK (model <> '' AND char_length(model) <= 500),
        prompt_version text NOT NULL CHECK (prompt_version <> '' AND char_length(prompt_version) <= 200),
        schema_version text NOT NULL CHECK (schema_version <> '' AND char_length(schema_version) <= 200),
        searched_at timestamptz NOT NULL
      );
      CREATE INDEX medication_candidate_sets_lookup_idx ON insight.medication_candidate_sets
        (execution_id, research_case_id, medication_entry_ref, catalog_version_id, searched_at DESC);

      CREATE TABLE insight.medication_mappings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        candidate_set_id uuid NOT NULL REFERENCES insight.medication_candidate_sets(id),
        execution_id text NOT NULL,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        medication_entry_ref text NOT NULL,
        catalog_version_id uuid NOT NULL REFERENCES insight.medication_catalog_versions(id),
        catalog_version integer NOT NULL CHECK (catalog_version > 0),
        raw_text text NOT NULL,
        candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
        normalization_state text NOT NULL CHECK (normalization_state IN ('NORMALIZED', 'UNKNOWN')),
        canonical_id text,
        preferred_name text,
        model text NOT NULL,
        prompt_version text NOT NULL,
        schema_version text NOT NULL,
        selected_at timestamptz NOT NULL,
        UNIQUE (execution_id, research_case_id, medication_entry_ref),
        CHECK (
          (normalization_state = 'NORMALIZED' AND canonical_id IS NOT NULL AND preferred_name IS NOT NULL)
          OR (normalization_state = 'UNKNOWN' AND canonical_id IS NULL AND preferred_name IS NULL)
        )
      );

      ALTER TABLE insight.current_medication_entries
        ADD COLUMN medication_mapping_id uuid REFERENCES insight.medication_mappings(id),
        ADD COLUMN medication_catalog_version_id uuid REFERENCES insight.medication_catalog_versions(id);
      ALTER TABLE insight.prior_antipsychotic_trials
        ADD COLUMN medication_mapping_id uuid REFERENCES insight.medication_mappings(id),
        ADD COLUMN medication_catalog_version_id uuid REFERENCES insight.medication_catalog_versions(id);

      CREATE FUNCTION insight.reject_medication_catalog_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'INSERT' AND current_setting('insight.medication_catalog_write', true) = 'allowed'
        THEN RETURN NEW;
        END IF;
        RAISE EXCEPTION 'medication catalog versions are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER medication_catalog_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.medication_catalog_versions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_medication_catalog_mutation();
      CREATE TRIGGER medication_catalog_entries_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON insight.medication_catalog_entries
      FOR EACH ROW EXECUTE FUNCTION insight.reject_medication_catalog_mutation();
      CREATE TRIGGER medication_candidate_sets_immutable
      BEFORE UPDATE OR DELETE ON insight.medication_candidate_sets
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();
      CREATE TRIGGER medication_mappings_immutable
      BEFORE UPDATE OR DELETE ON insight.medication_mappings
      FOR EACH ROW EXECUTE FUNCTION insight.reject_audit_row_mutation();
    `,
  },
  {
    version: 22,
    name: "medication_normalization_jobs",
    sql: `
      ALTER TABLE insight.prior_antipsychotic_trials
        ADD COLUMN route text,
        ADD COLUMN frequency text;

      CREATE TABLE insight.medication_normalization_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid UNIQUE REFERENCES insight.jobs(id) ON DELETE CASCADE,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        requested_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        workflow_revision bigint NOT NULL CHECK (workflow_revision > 0),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        medical_history_revision bigint NOT NULL CHECK (medical_history_revision > 0),
        execution_id uuid NOT NULL UNIQUE,
        endpoint_configuration_id uuid REFERENCES insight.model_endpoint_configurations(id),
        endpoint_configuration_version integer CHECK (endpoint_configuration_version > 0),
        endpoint_fingerprint text CHECK (endpoint_fingerprint ~ '^[0-9a-f]{64}$'),
        catalog_version_id uuid REFERENCES insight.medication_catalog_versions(id),
        catalog_version integer CHECK (catalog_version > 0),
        projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (
          (endpoint_configuration_id IS NULL AND endpoint_configuration_version IS NULL
            AND endpoint_fingerprint IS NULL AND catalog_version_id IS NULL
            AND catalog_version IS NULL)
          OR
          (endpoint_configuration_id IS NOT NULL AND endpoint_configuration_version IS NOT NULL
            AND endpoint_fingerprint IS NOT NULL AND catalog_version_id IS NOT NULL
            AND catalog_version IS NOT NULL)
        )
      );
      CREATE INDEX medication_normalization_runs_case_idx
        ON insight.medication_normalization_runs
          (research_case_id, input_revision, medical_history_revision, created_at DESC);
    `,
  },
  {
    version: 23,
    name: "ddi_source_governance",
    sql: `
      CREATE TABLE insight.ddi_source_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version integer NOT NULL CHECK (version > 0),
        drug_identity text NOT NULL CHECK (
          drug_identity ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        ),
        title text NOT NULL CHECK (title = btrim(title) AND title <> ''),
        source_url text NOT NULL CHECK (source_url ~ '^https://([^/]+\\.)?medscape\\.com/'),
        publisher text NOT NULL CHECK (lower(publisher) = 'medscape'),
        retrieved_at timestamptz NOT NULL,
        content_date date NOT NULL,
        content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        parser_version text NOT NULL CHECK (parser_version <> ''),
        transform_version text NOT NULL CHECK (transform_version <> ''),
        reviewer_id text NOT NULL CHECK (reviewer_id = btrim(reviewer_id) AND reviewer_id <> ''),
        reviewed_at timestamptz NOT NULL,
        review_reference text NOT NULL CHECK (
          review_reference = btrim(review_reference) AND review_reference <> ''
        ),
        permission_record jsonb NOT NULL CHECK (
          jsonb_typeof(permission_record) = 'object'
          AND permission_record ?& ARRAY[
            'status', 'basis', 'recordReference', 'coversStorage',
            'coversTransformation', 'coversResearchUse'
          ]
        ),
        artifact_path text NOT NULL CHECK (
          artifact_path = btrim(artifact_path) AND artifact_path <> ''
          AND artifact_path !~ '(^/|(^|/)\\.\\.(/|$))'
        ),
        artifact_media_type text NOT NULL CHECK (
          artifact_media_type = 'text/plain; charset=utf-8'
        ),
        artifact_byte_length bigint NOT NULL CHECK (artifact_byte_length > 0),
        interactions jsonb NOT NULL CHECK (
          jsonb_typeof(interactions) = 'array' AND jsonb_array_length(interactions) > 0
        ),
        imported_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        imported_at timestamptz NOT NULL,
        UNIQUE (drug_identity, version),
        UNIQUE (drug_identity, content_hash, parser_version, transform_version)
      );

      CREATE TABLE insight.ddi_source_lifecycle_events (
        source_version_id uuid NOT NULL REFERENCES insight.ddi_source_versions(id),
        sequence bigint GENERATED ALWAYS AS IDENTITY,
        lifecycle text NOT NULL CHECK (
          lifecycle IN ('quarantined', 'reviewed', 'active', 'superseded', 'rejected')
        ),
        actor_user_id uuid NOT NULL REFERENCES insight.users(id),
        occurred_at timestamptz NOT NULL,
        event_reference text CHECK (event_reference IS NULL OR btrim(event_reference) <> ''),
        legal_approval_reference text CHECK (
          legal_approval_reference IS NULL OR btrim(legal_approval_reference) <> ''
        ),
        clinical_approval_reference text CHECK (
          clinical_approval_reference IS NULL OR btrim(clinical_approval_reference) <> ''
        ),
        PRIMARY KEY (source_version_id, sequence),
        CHECK (
          (lifecycle = 'active' AND legal_approval_reference IS NOT NULL
            AND clinical_approval_reference IS NOT NULL)
          OR (lifecycle <> 'active' AND legal_approval_reference IS NULL
            AND clinical_approval_reference IS NULL)
        )
      );

      CREATE TABLE insight.ddi_active_sources (
        drug_identity text PRIMARY KEY,
        source_version_id uuid NOT NULL UNIQUE REFERENCES insight.ddi_source_versions(id),
        activated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        activated_at timestamptz NOT NULL
      );

      CREATE FUNCTION insight.reject_ddi_source_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'DDI source versions and lifecycle events are immutable'
          USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER ddi_source_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.ddi_source_versions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_ddi_source_mutation();
      CREATE TRIGGER ddi_source_lifecycle_events_immutable
      BEFORE UPDATE OR DELETE ON insight.ddi_source_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_ddi_source_mutation();
    `,
  },
  {
    version: 24,
    name: "ddi_regimen_evaluation",
    sql: `
      CREATE TABLE insight.ddi_executions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_ref text NOT NULL UNIQUE CHECK (
          execution_ref ~ '^ddi-execution-[0-9a-f]{64}$'
        ),
        tool_execution_id text NOT NULL,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        requested_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        purpose text NOT NULL CHECK (purpose IN ('PRIMARY_FILTER', 'FINAL_RECHECK')),
        workflow_revision bigint NOT NULL CHECK (workflow_revision > 0),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        exact_regimen jsonb NOT NULL CHECK (jsonb_typeof(exact_regimen) = 'array'),
        evaluated_pairs jsonb NOT NULL CHECK (jsonb_typeof(evaluated_pairs) = 'array'),
        source_versions jsonb NOT NULL CHECK (
          jsonb_typeof(source_versions) = 'array'
        ),
        source_version text NOT NULL,
        unknown_medication_entry_refs jsonb NOT NULL CHECK (
          jsonb_typeof(unknown_medication_entry_refs) = 'array'
        ),
        omitted_pair_count integer NOT NULL CHECK (omitted_pair_count >= 0),
        findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
        excluded_canonical_ids jsonb NOT NULL CHECK (
          jsonb_typeof(excluded_canonical_ids) = 'array'
        ),
        executed_at timestamptz NOT NULL,
        UNIQUE (tool_execution_id, purpose)
      );

      CREATE INDEX ddi_executions_case_idx
        ON insight.ddi_executions (research_case_id, executed_at DESC);
      CREATE FUNCTION insight.reject_ddi_execution_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD;
        END IF;
        RAISE EXCEPTION 'DDI executions are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER ddi_executions_immutable
      BEFORE UPDATE OR DELETE ON insight.ddi_executions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_ddi_execution_mutation();
    `,
  },
  {
    version: 25,
    name: "bn_model_registry",
    sql: `
      CREATE TABLE insight.bn_model_artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_path text NOT NULL CHECK (
          artifact_path = btrim(artifact_path) AND artifact_path <> ''
          AND artifact_path !~ '(^/|(^|/)\\.\\.(/|$))'
        ),
        media_type text NOT NULL CHECK (media_type = 'application/xml'),
        byte_length bigint NOT NULL CHECK (byte_length > 0),
        content_sha256 text NOT NULL UNIQUE CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        semantic_sha256 text CHECK (semantic_sha256 ~ '^[0-9a-f]{64}$'),
        topology_sha256 text CHECK (topology_sha256 ~ '^[0-9a-f]{64}$'),
        stored_at timestamptz NOT NULL,
        CHECK (
          (semantic_sha256 IS NULL AND topology_sha256 IS NULL)
          OR (semantic_sha256 IS NOT NULL AND topology_sha256 IS NOT NULL)
        )
      );

      CREATE TABLE insight.bn_model_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pathway_identity text NOT NULL CHECK (
          pathway_identity ~ '^[A-Z][A-Z0-9_]{0,127}$'
        ),
        version integer NOT NULL CHECK (version > 0),
        artifact_id uuid NOT NULL UNIQUE REFERENCES insight.bn_model_artifacts(id),
        registry_schema_version integer NOT NULL CHECK (registry_schema_version = 1),
        importer_version text NOT NULL CHECK (
          importer_version = btrim(importer_version) AND importer_version <> ''
        ),
        validation_report jsonb NOT NULL CHECK (
          jsonb_typeof(validation_report) = 'object'
          AND validation_report->>'clinicalValidity' = 'NOT_ESTABLISHED'
          AND validation_report ? 'softwareCompatible'
          AND jsonb_typeof(validation_report->'checks') = 'array'
          AND jsonb_typeof(validation_report->'diagnostics') = 'array'
        ),
        evidence_metadata jsonb NOT NULL CHECK (jsonb_typeof(evidence_metadata) = 'object'),
        calibration_metadata jsonb NOT NULL CHECK (
          jsonb_typeof(calibration_metadata) = 'object'
        ),
        clinical_review_metadata jsonb NOT NULL CHECK (
          jsonb_typeof(clinical_review_metadata) = 'object'
        ),
        initial_lifecycle text NOT NULL CHECK (
          initial_lifecycle IN ('IMPORTED', 'REJECTED', 'QUARANTINED', 'ACTIVE')
        ),
        quarantine_reason text CHECK (
          quarantine_reason IS NULL OR
          (quarantine_reason = btrim(quarantine_reason) AND quarantine_reason <> '')
        ),
        imported_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        imported_at timestamptz NOT NULL,
        UNIQUE (pathway_identity, version),
        UNIQUE (pathway_identity, artifact_id),
        CHECK (
          (initial_lifecycle = 'QUARANTINED' AND quarantine_reason IS NOT NULL)
          OR (initial_lifecycle <> 'QUARANTINED' AND quarantine_reason IS NULL)
        ),
        CHECK (
          (initial_lifecycle = 'ACTIVE'
            AND (validation_report->>'softwareCompatible')::boolean)
          OR initial_lifecycle <> 'ACTIVE'
        )
      );

      CREATE TABLE insight.bn_model_lifecycle_events (
        model_version_id uuid NOT NULL REFERENCES insight.bn_model_versions(id),
        sequence bigint GENERATED ALWAYS AS IDENTITY,
        lifecycle text NOT NULL CHECK (
          lifecycle IN ('IMPORTED', 'REJECTED', 'QUARANTINED', 'ACTIVE', 'SUPERSEDED')
        ),
        actor_user_id uuid NOT NULL REFERENCES insight.users(id),
        occurred_at timestamptz NOT NULL,
        event_reference text CHECK (
          event_reference IS NULL OR
          (event_reference = btrim(event_reference) AND event_reference <> '')
        ),
        PRIMARY KEY (model_version_id, sequence)
      );

      CREATE TABLE insight.bn_active_models (
        pathway_identity text PRIMARY KEY CHECK (
          pathway_identity ~ '^[A-Z][A-Z0-9_]{0,127}$'
        ),
        model_version_id uuid NOT NULL UNIQUE REFERENCES insight.bn_model_versions(id),
        activated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        activated_at timestamptz NOT NULL
      );

      CREATE FUNCTION insight.reject_bn_registry_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'BN model artifacts, versions, and lifecycle events are immutable'
          USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER bn_model_artifacts_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_model_artifacts
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_registry_mutation();
      CREATE TRIGGER bn_model_versions_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_model_versions
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_registry_mutation();
      CREATE TRIGGER bn_model_lifecycle_events_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_model_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_registry_mutation();
    `,
  },
  {
    version: 26,
    name: "bn_model_lifecycle",
    sql: `
      ALTER TABLE insight.bn_model_lifecycle_events
        DROP CONSTRAINT bn_model_lifecycle_events_lifecycle_check;
      ALTER TABLE insight.bn_model_lifecycle_events
        ADD CONSTRAINT bn_model_lifecycle_events_lifecycle_check CHECK (
          lifecycle IN (
            'IMPORTED', 'REJECTED', 'QUARANTINED', 'ACTIVE', 'SUPERSEDED', 'DISABLED'
          )
        );

      CREATE TABLE insight.bn_research_case_model_pins (
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        pathway_identity text NOT NULL CHECK (
          pathway_identity ~ '^[A-Z][A-Z0-9_]{0,127}$'
        ),
        model_version_id uuid NOT NULL REFERENCES insight.bn_model_versions(id),
        model_version integer NOT NULL CHECK (model_version > 0),
        content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        semantic_sha256 text NOT NULL CHECK (semantic_sha256 ~ '^[0-9a-f]{64}$'),
        pinned_at timestamptz NOT NULL,
        PRIMARY KEY (research_case_id, pathway_identity)
      );

      CREATE FUNCTION insight.reject_bn_model_pin_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD;
        END IF;
        RAISE EXCEPTION 'BN model execution pins are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER bn_research_case_model_pins_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_research_case_model_pins
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_model_pin_mutation();
    `,
  },
  {
    version: 27,
    name: "deterministic_bn_routing",
    sql: `
      CREATE TABLE insight.bn_routing_evaluations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        research_case_revision integer NOT NULL CHECK (research_case_revision > 0),
        routing_artifact_version text NOT NULL CHECK (
          routing_artifact_version = btrim(routing_artifact_version)
          AND routing_artifact_version <> ''
        ),
        routing_approval_ref text NOT NULL CHECK (
          routing_approval_ref = btrim(routing_approval_ref) AND routing_approval_ref <> ''
        ),
        input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
        matched_rule_refs jsonb NOT NULL CHECK (
          jsonb_typeof(matched_rule_refs) = 'array' AND jsonb_array_length(matched_rule_refs) > 0
        ),
        selected_models jsonb NOT NULL CHECK (
          jsonb_typeof(selected_models) = 'array' AND jsonb_array_length(selected_models) > 0
        ),
        evaluated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        evaluated_at timestamptz NOT NULL
      );

      CREATE FUNCTION insight.reject_bn_routing_evaluation_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD;
        END IF;
        RAISE EXCEPTION 'BN routing evaluations are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER bn_routing_evaluations_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_routing_evaluations
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_routing_evaluation_mutation();
    `,
  },
  {
    version: 28,
    name: "patient_specific_cpt_snapshots",
    sql: `
      CREATE TABLE insight.bn_cpt_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_id text NOT NULL,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        model_version_id uuid NOT NULL REFERENCES insight.bn_model_versions(id),
        dependency_fingerprint text NOT NULL CHECK (
          dependency_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
        raw_response jsonb NOT NULL CHECK (jsonb_typeof(raw_response) = 'array'),
        diagnostics jsonb NOT NULL CHECK (jsonb_typeof(diagnostics) = 'array'),
        accepted boolean NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE (execution_id, model_version_id, attempt_number),
        UNIQUE (id, research_case_id, model_version_id),
        CHECK (
          (accepted AND jsonb_array_length(diagnostics) = 0)
          OR (NOT accepted AND jsonb_array_length(diagnostics) > 0)
        )
      );

      CREATE TABLE insight.bn_cpt_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_ref text NOT NULL UNIQUE CHECK (
          snapshot_ref ~ '^cpt-snapshot-[0-9a-f]{64}$'
        ),
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        model_version_id uuid NOT NULL REFERENCES insight.bn_model_versions(id),
        dependency_fingerprint text NOT NULL CHECK (
          dependency_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        dependency_manifest jsonb NOT NULL CHECK (jsonb_typeof(dependency_manifest) = 'object'),
        snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
        tables jsonb NOT NULL CHECK (
          jsonb_typeof(tables) = 'array' AND jsonb_array_length(tables) > 0
        ),
        accepted_attempt_id uuid NOT NULL UNIQUE,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL,
        UNIQUE (research_case_id, model_version_id, dependency_fingerprint),
        FOREIGN KEY (accepted_attempt_id, research_case_id, model_version_id)
          REFERENCES insight.bn_cpt_attempts (id, research_case_id, model_version_id)
      );

      CREATE INDEX bn_cpt_attempts_case_idx ON insight.bn_cpt_attempts
        (research_case_id, dependency_fingerprint, model_version_id, attempt_number);
      CREATE INDEX bn_cpt_snapshots_reuse_idx ON insight.bn_cpt_snapshots
        (research_case_id, dependency_fingerprint, model_version_id);

      CREATE FUNCTION insight.reject_bn_cpt_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD;
        END IF;
        RAISE EXCEPTION 'BN CPT attempts and snapshots are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER bn_cpt_attempts_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_cpt_attempts
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_cpt_mutation();
      CREATE TRIGGER bn_cpt_snapshots_immutable
      BEFORE UPDATE OR DELETE ON insight.bn_cpt_snapshots
      FOR EACH ROW EXECUTE FUNCTION insight.reject_bn_cpt_mutation();
    `,
  },
  {
    version: 29,
    name: "primary_treatment_plan_drafts",
    sql: `
      CREATE TABLE insight.primary_treatment_plan_drafts (
        research_case_id uuid PRIMARY KEY REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        draft_ref text NOT NULL UNIQUE CHECK (
          draft_ref ~ '^primary-plan-draft-[0-9a-f]{64}$'
        ),
        revision bigint NOT NULL CHECK (revision > 0),
        schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
        plan_payload jsonb NOT NULL CHECK (jsonb_typeof(plan_payload) = 'object'),
        plan_hash text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
        source_execution_refs jsonb NOT NULL CHECK (
          jsonb_typeof(source_execution_refs) = 'array'
          AND jsonb_array_length(source_execution_refs) > 0
        ),
        primary_ddi_execution_ref text NOT NULL REFERENCES insight.ddi_executions(execution_ref),
        ai_imputation_notice_visible boolean NOT NULL,
        workflow_revision bigint NOT NULL CHECK (workflow_revision > 0),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        last_tool_execution_id text NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        updated_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE FUNCTION insight.protect_primary_plan_draft_write()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF current_setting('insight.primary_plan_write', true) IS DISTINCT FROM 'allowed'
           AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
        THEN
          RAISE EXCEPTION 'Primary Treatment Plan drafts are service-owned' USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $function$;
      CREATE TRIGGER primary_treatment_plan_drafts_service_owned
      BEFORE INSERT OR UPDATE OR DELETE ON insight.primary_treatment_plan_drafts
      FOR EACH ROW EXECUTE FUNCTION insight.protect_primary_plan_draft_write();
    `,
  },
  {
    version: 30,
    name: "research_case_orchestration",
    sql: `
      CREATE TABLE insight.research_case_orchestration_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL UNIQUE REFERENCES insight.jobs(id) ON DELETE CASCADE,
        research_case_id uuid NOT NULL REFERENCES insight.research_cases(id) ON DELETE CASCADE,
        requested_by_user_id uuid NOT NULL REFERENCES insight.users(id),
        idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        dependency_fingerprint text NOT NULL CHECK (
          dependency_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        dependency_manifest jsonb NOT NULL CHECK (jsonb_typeof(dependency_manifest) = 'object'),
        status text NOT NULL DEFAULT 'RUNNING' CHECK (
          status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
        ),
        current_state insight.research_case_workflow_state NOT NULL,
        failure_code text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        UNIQUE (requested_by_user_id, research_case_id, idempotency_key)
      );

      CREATE TABLE insight.research_case_orchestration_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid NOT NULL REFERENCES insight.research_case_orchestration_runs(id) ON DELETE CASCADE,
        workflow_state insight.research_case_workflow_state NOT NULL,
        workflow_revision bigint NOT NULL CHECK (workflow_revision > 0),
        input_revision bigint NOT NULL CHECK (input_revision > 0),
        attempt_number integer NOT NULL CHECK (attempt_number > 0),
        status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')),
        result_type text,
        result_reference text,
        dependency_fingerprint text NOT NULL CHECK (
          dependency_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
        error_code text,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, workflow_state, workflow_revision, attempt_number),
        CHECK (
          (status = 'SUCCEEDED' AND result_type IS NOT NULL AND result_reference IS NOT NULL
            AND error_code IS NULL)
          OR (status <> 'SUCCEEDED' AND result_reference IS NULL AND error_code IS NOT NULL)
        )
      );

      CREATE INDEX research_case_orchestration_runs_resume_idx
        ON insight.research_case_orchestration_runs (status, updated_at, id);
      CREATE UNIQUE INDEX research_case_orchestration_one_active_idx
        ON insight.research_case_orchestration_runs (research_case_id)
        WHERE status = 'RUNNING';
      CREATE INDEX research_case_orchestration_attempts_audit_idx
        ON insight.research_case_orchestration_attempts (run_id, recorded_at, id);

      CREATE FUNCTION insight.reject_orchestration_attempt_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Research Case orchestration attempts are immutable' USING ERRCODE = '55000';
      END;
      $function$;
      CREATE TRIGGER research_case_orchestration_attempts_immutable
      BEFORE UPDATE OR DELETE ON insight.research_case_orchestration_attempts
      FOR EACH ROW EXECUTE FUNCTION insight.reject_orchestration_attempt_mutation();
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationalAuditAuthorizationError,
  PatientAuthorizationError,
  createManagedUser,
  createOrOverwritePatient,
  createUser,
  listOperationalAuditEvents,
  listPatientAuditEvents,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";
import { makeSyntheticPatientIdentity } from "./support/synthetic-data.mjs";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};

test("operational and clinical audit persistence", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("audit failure rolls back identity and Patient mutations", () =>
    withAuditDatabase(async (pool) => {
      const administrator = (
        await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
      ).rows[0];
      await pool.query(`
        CREATE FUNCTION insight.reject_security_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic operational audit failure'; END $$;
        CREATE TRIGGER reject_security_audit_insert BEFORE INSERT ON insight.security_audit_events
        FOR EACH ROW EXECUTE FUNCTION insight.reject_security_audit_insert();
      `);
      await assert.rejects(
        () =>
          createManagedUser(pool, administrator.id, {
            username: "RolledBackUser",
            password: "not-stored-in-audit",
            role: "PSYCHIATRIST",
          }),
        /synthetic operational audit failure/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM insight.users WHERE username_normalized = 'rolledbackuser'",
          )
        ).rows[0].count,
        0,
      );
      await pool.query(`
        DROP TRIGGER reject_security_audit_insert ON insight.security_audit_events;
        DROP FUNCTION insight.reject_security_audit_insert();
      `);

      const psychiatrist = await createUser(pool, {
        username: "PatientRollbackActor",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      await pool.query(`
        CREATE FUNCTION insight.reject_patient_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic clinical audit failure'; END $$;
        CREATE TRIGGER reject_patient_audit_insert BEFORE INSERT ON insight.patient_audit_events
        FOR EACH ROW EXECUTE FUNCTION insight.reject_patient_audit_insert();
      `);
      const synthetic = makeSyntheticPatientIdentity(40);
      await assert.rejects(
        () =>
          createOrOverwritePatient(
            pool,
            { id: psychiatrist.id, role: psychiatrist.role },
            patientInput(synthetic),
            identifierConfiguration,
            "00000000-0000-4000-8000-000000000401",
            new Date("2026-08-22T10:00:00.000Z"),
          ),
        /synthetic clinical audit failure/,
      );
      const counts = await pool.query(`
        SELECT (SELECT count(*)::integer FROM insight.patients) AS patients,
               (SELECT count(*)::integer FROM insight.research_cases) AS cases,
               (SELECT count(*)::integer FROM insight.patient_audit_events) AS audits
      `);
      assert.deepEqual(counts.rows[0], { patients: 0, cases: 0, audits: 0 });
    }),
  );

  await suite.test(
    "roles stay separate, clinical payload is redacted, and Patient link survives",
    () =>
      withAuditDatabase(async (pool) => {
        const administrator = (
          await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
        ).rows[0];
        const psychiatrist = await createManagedUser(pool, administrator.id, {
          username: "AuditResearcher",
          password: "secret-never-audited",
          role: "PSYCHIATRIST",
        });
        const synthetic = makeSyntheticPatientIdentity(41);
        const saved = await createOrOverwritePatient(
          pool,
          { id: psychiatrist.id, role: psychiatrist.role },
          patientInput(synthetic),
          identifierConfiguration,
          "00000000-0000-4000-8000-000000000411",
          new Date("2026-08-22T10:00:00.000Z"),
        );

        const operational = await listOperationalAuditEvents(pool, {
          id: administrator.id,
          role: "ADMINISTRATOR",
        });
        const serializedOperational = JSON.stringify(operational);
        assert.doesNotMatch(serializedOperational, /secret-never-audited/);
        assert.doesNotMatch(serializedOperational, new RegExp(synthetic.firstName, "i"));
        assert.doesNotMatch(serializedOperational, new RegExp(synthetic.birthDate));
        assert.ok(operational.some(({ eventType }) => eventType === "USER_CREATED"));
        await assert.rejects(
          () =>
            listOperationalAuditEvents(pool, {
              id: psychiatrist.id,
              role: "PSYCHIATRIST",
            }),
          OperationalAuditAuthorizationError,
        );
        await assert.rejects(
          () =>
            listOperationalAuditEvents(pool, {
              id: psychiatrist.id,
              role: "ADMINISTRATOR",
            }),
          OperationalAuditAuthorizationError,
        );
        await assert.rejects(
          () =>
            listPatientAuditEvents(
              pool,
              { id: administrator.id, role: "ADMINISTRATOR" },
              saved.patient.id,
            ),
          PatientAuthorizationError,
        );
        await assert.rejects(
          () =>
            listPatientAuditEvents(
              pool,
              { id: administrator.id, role: "PSYCHIATRIST" },
              saved.patient.id,
            ),
          PatientAuthorizationError,
        );

        const clinical = await listPatientAuditEvents(
          pool,
          { id: psychiatrist.id, role: "PSYCHIATRIST" },
          saved.patient.id,
        );
        assert.deepEqual(clinical[0].patientLink, {
          patientId: saved.patient.id,
          researchCaseId: saved.patient.researchCase.id,
        });
        assert.equal(clinical[0].targetVersion, 1);
        assert.equal(clinical[0].after.firstName, synthetic.firstName);

        await pool.query("DELETE FROM insight.patients WHERE id = $1", [saved.patient.id]);
        const retained = await listPatientAuditEvents(
          pool,
          { id: psychiatrist.id, role: "PSYCHIATRIST" },
          saved.patient.id,
        );
        assert.deepEqual(retained, clinical);

        await assert.rejects(
          () =>
            pool.query("DELETE FROM insight.patient_audit_events WHERE patient_id = $1", [
              saved.patient.id,
            ]),
          /audit row update\/delete is not allowed/,
        );
        await assert.rejects(
          () => pool.query("UPDATE insight.security_audit_events SET event_type = event_type"),
          /audit row update\/delete is not allowed/,
        );
      }),
  );
});

function patientInput(synthetic) {
  return {
    officialIdentifier: {
      type: identifierConfiguration.type,
      issuingAuthority: identifierConfiguration.issuingAuthority,
      value: synthetic.officialIdentifier,
    },
    firstName: synthetic.firstName,
    lastName: "Researcher",
    dateOfBirth: synthetic.birthDate,
    sex: synthetic.sex,
  };
}

async function withAuditDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      return await operation(pool);
    } finally {
      await pool.end();
    }
  });
}

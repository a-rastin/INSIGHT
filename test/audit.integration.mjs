import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationalAuditAuthorizationError,
  PatientAuthorizationError,
  buildApp,
  createManagedUser,
  createOrOverwritePatient,
  createUser,
  listOperationalAuditEvents,
  listPatientAuditEvents,
  queryClinicalAuditEvents,
  queryOperationalAuditEvents,
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
        await pool.query(
          `INSERT INTO insight.security_audit_events
             (event_type, actor_user_id, request_id, after_metadata)
           VALUES ('SIGN_IN', $1, $2, $3)`,
          [
            administrator.id,
            "00000000-0000-4000-8000-000000000412",
            {
              role: "ADMINISTRATOR",
              patientId: saved.patient.id,
              patientName: synthetic.firstName,
              officialIdentifier: synthetic.officialIdentifier,
              freeText: "synthetic clinical narrative",
              clinicalValue: 7,
              plan: "synthetic plan",
            },
          ],
        );

        const operational = await listOperationalAuditEvents(pool, {
          id: administrator.id,
          role: "ADMINISTRATOR",
        });
        const serializedOperational = JSON.stringify(operational);
        assert.doesNotMatch(serializedOperational, /secret-never-audited/);
        assert.doesNotMatch(serializedOperational, new RegExp(synthetic.firstName, "i"));
        assert.doesNotMatch(serializedOperational, new RegExp(synthetic.birthDate));
        assert.doesNotMatch(serializedOperational, new RegExp(saved.patient.id, "i"));
        assert.doesNotMatch(serializedOperational, new RegExp(synthetic.officialIdentifier, "i"));
        assert.doesNotMatch(serializedOperational, /synthetic clinical narrative|synthetic plan/);
        assert.ok(operational.some(({ eventType }) => eventType === "USER_CREATED"));
        const operationalPage = await queryOperationalAuditEvents(
          pool,
          { id: administrator.id, role: "ADMINISTRATOR" },
          { eventType: "SIGN_IN", offset: 0, limit: 1 },
        );
        assert.equal(operationalPage.events.length, 1);
        assert.equal(operationalPage.events[0].eventType, "SIGN_IN");
        assert.ok(operationalPage.total >= 1);
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
            queryClinicalAuditEvents(
              pool,
              { id: administrator.id, role: "ADMINISTRATOR" },
              { patientId: saved.patient.id },
            ),
          PatientAuthorizationError,
        );
        await assert.rejects(
          () => queryOperationalAuditEvents(pool, { id: psychiatrist.id, role: "ADMINISTRATOR" }),
          OperationalAuditAuthorizationError,
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
        const retainedPage = await queryClinicalAuditEvents(
          pool,
          { id: psychiatrist.id, role: "PSYCHIATRIST" },
          {
            patientId: saved.patient.id,
            eventType: "PATIENT_CREATED",
            offset: 0,
            limit: 1,
            from: "2026-08-22T09:59:00.000Z",
            to: "2026-08-22T10:01:00.000Z",
          },
        );
        assert.equal(retainedPage.total, 1);
        assert.equal(retainedPage.events[0].patientLink.patientId, saved.patient.id);
        assert.equal(retainedPage.events[0].after.firstName, synthetic.firstName);

        const app = buildApp({
          authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        });
        try {
          const administratorCookie = await login(app, "admin", "admin");
          const psychiatristCookie = await login(
            app,
            psychiatrist.username,
            "secret-never-audited",
          );
          assert.equal(
            (await app.inject({ method: "GET", url: "/api/v1/admin/operational-audit" }))
              .statusCode,
            401,
          );
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/api/v1/admin/operational-audit",
                headers: { cookie: psychiatristCookie },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/api/v1/admin/operational-audit?limit=1",
                headers: { cookie: administratorCookie },
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: `/api/v1/clinical-audit?patientId=${saved.patient.id}`,
                headers: { cookie: administratorCookie },
              })
            ).statusCode,
            403,
          );
          const authorizedClinical = await app.inject({
            method: "GET",
            url: `/api/v1/clinical-audit?patientId=${saved.patient.id}&limit=1`,
            headers: { cookie: psychiatristCookie },
          });
          assert.equal(authorizedClinical.statusCode, 200);
          assert.equal(authorizedClinical.json().page.total, 1);
        } finally {
          await app.close();
        }

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

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  return response.headers["set-cookie"].split(";", 1)[0];
}

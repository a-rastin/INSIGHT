import assert from "node:assert/strict";
import test from "node:test";

import {
  PatientAuthorizationError,
  activateIdentifiedResearchMode,
  buildApp,
  createOrOverwritePatient,
  createUser,
  getPatient,
  listPatientAuditEvents,
  listPatients,
  recordDeploymentEvidence,
  savePatientDemographics,
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
const allControls = {
  participantConsentOrWaiver: true,
  administratorSeparation: true,
  encryptionInTransit: true,
  encryptionAtRest: true,
  auditControls: true,
  dataGovernanceRules: true,
  modelDisclosureControls: true,
  environmentSeparation: true,
};

test("PAT-01 transactional Patient identity and one Research Case", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("concurrent duplicate creation overwrites atomically and audits values", () =>
    withPatientDatabase(async (pool) => {
      const psychiatrist = await createUser(pool, {
        username: "PatientResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const actor = { id: psychiatrist.id, role: psychiatrist.role };
      const synthetic = makeSyntheticPatientIdentity(1);
      const first = patientInput(synthetic, { firstName: "Alice", sex: "FEMALE" });
      const second = patientInput(synthetic, {
        firstName: "Robert",
        lastName: "ResearcherTwo",
        dateOfBirth: "1992-08-23",
        sex: "MALE",
        identifierValue: " synthetic-000001 ",
      });
      const now = new Date("2026-08-22T10:00:00.000Z");

      const results = await Promise.all([
        createOrOverwritePatient(
          pool,
          actor,
          first,
          identifierConfiguration,
          "00000000-0000-4000-8000-000000000101",
          now,
        ),
        createOrOverwritePatient(
          pool,
          actor,
          second,
          identifierConfiguration,
          "00000000-0000-4000-8000-000000000102",
          now,
        ),
      ]);

      assert.equal(new Set(results.map(({ patient }) => patient.id)).size, 1);
      assert.equal(new Set(results.map(({ patient }) => patient.researchCase.id)).size, 1);
      assert.deepEqual(results.map(({ created }) => created).sort(), [false, true]);
      assert.deepEqual(await tableCounts(pool), { patients: 1, researchCases: 1, audits: 2 });

      const patientId = results[0].patient.id;
      const audit = await listPatientAuditEvents(pool, actor, patientId);
      assert.deepEqual(audit.map(({ eventType }) => eventType).sort(), [
        "PATIENT_CREATED",
        "PATIENT_DEMOGRAPHICS_SAVED",
      ]);
      const creationAudit = audit.find(({ eventType }) => eventType === "PATIENT_CREATED");
      const overwriteAudit = audit.find(
        ({ eventType }) => eventType === "PATIENT_DEMOGRAPHICS_SAVED",
      );
      assert.equal(creationAudit.before, null);
      assert.deepEqual(overwriteAudit.before, creationAudit.after);
      assert.ok([first.firstName, second.firstName].includes(overwriteAudit.after.firstName));

      const saved = await savePatientDemographics(
        pool,
        actor,
        patientId,
        { firstName: "Latest", lastName: "Writer", dateOfBirth: "1990-08-23", sex: "FEMALE" },
        "00000000-0000-4000-8000-000000000103",
        new Date("2027-08-22T10:00:00.000Z"),
      );
      assert.equal(saved.id, patientId);
      assert.equal(saved.firstName, "Latest");
      assert.equal(saved.profileAge, 36);
      assert.equal(saved.researchCase.ageAtStart, 35);
      assert.equal(saved.researchCase.startedAt, now.toISOString());

      const secondPsychiatrist = await createUser(pool, {
        username: "SharedRegistryResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const secondActor = { id: secondPsychiatrist.id, role: secondPsychiatrist.role };
      assert.deepEqual(
        (await listPatients(pool, secondActor, new Date("2027-08-22T10:00:00.000Z"))).map(
          ({ id }) => id,
        ),
        [patientId],
      );
      assert.equal(
        (await getPatient(pool, secondActor, patientId, new Date("2027-08-22T10:00:00.000Z")))
          .firstName,
        "Latest",
      );

      const finalAudit = await listPatientAuditEvents(pool, actor, patientId);
      assert.equal(finalAudit.length, 3);
      assert.deepEqual(finalAudit[2].before, overwriteAudit.after);
      assert.deepEqual(finalAudit[2].after, {
        firstName: "Latest",
        lastName: "Writer",
        dateOfBirth: "1990-08-23",
        sex: "FEMALE",
      });

      await assert.rejects(
        () =>
          createOrOverwritePatient(
            pool,
            { id: psychiatrist.id, role: "ADMINISTRATOR" },
            first,
            identifierConfiguration,
            "00000000-0000-4000-8000-000000000104",
            now,
          ),
        PatientAuthorizationError,
      );
    }),
  );

  await suite.test("Research Case failure rolls back Patient and no Encounter schema exists", () =>
    withPatientDatabase(async (pool) => {
      const psychiatrist = await createUser(pool, {
        username: "RollbackResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      await pool.query(`
        CREATE FUNCTION insight.reject_research_case() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic case failure'; END $$;
        CREATE TRIGGER reject_research_case BEFORE INSERT ON insight.research_cases
        FOR EACH ROW EXECUTE FUNCTION insight.reject_research_case();
      `);
      await assert.rejects(
        () =>
          createOrOverwritePatient(
            pool,
            { id: psychiatrist.id, role: psychiatrist.role },
            patientInput(makeSyntheticPatientIdentity(2)),
            identifierConfiguration,
            "00000000-0000-4000-8000-000000000201",
            new Date("2026-08-22T10:00:00.000Z"),
          ),
        /synthetic case failure/,
      );
      assert.deepEqual(await tableCounts(pool), { patients: 0, researchCases: 0, audits: 0 });
      const forbiddenTables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'insight' AND table_name ~ '(encounter|visit)'`,
      );
      assert.deepEqual(forbiddenTables.rows, []);
    }),
  );

  await suite.test(
    "routes validate complete data, overwrite duplicates, and deny Administrator",
    () =>
      withPatientDatabase(async (pool) => {
        const psychiatrist = await createUser(pool, {
          username: "RouteResearcher",
          password: "research-password",
          role: "PSYCHIATRIST",
        });
        const secondPsychiatrist = await createUser(pool, {
          username: "SecondRouteResearcher",
          password: "research-password",
          role: "PSYCHIATRIST",
        });
        await enableIdentifiedMode(pool);
        const app = buildApp({
          authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
          patient: { officialIdentifier: identifierConfiguration },
        });
        try {
          const clinicianSession = await login(app, psychiatrist.username, "research-password");
          const secondClinicianSession = await login(
            app,
            secondPsychiatrist.username,
            "research-password",
          );
          const administratorSession = await login(app, "admin", "admin");
          const invalid = await app.inject({
            method: "POST",
            url: "/api/v1/patients",
            headers: unsafeHeaders(clinicianSession),
            payload: {
              schemaVersion: "1",
              officialIdentifier: {
                type: identifierConfiguration.type,
                issuingAuthority: identifierConfiguration.issuingAuthority,
                value: makeSyntheticPatientIdentity(3).officialIdentifier,
              },
              firstName: "Missing",
            },
          });
          assert.equal(invalid.statusCode, 400);
          assert.deepEqual(await tableCounts(pool), { patients: 0, researchCases: 0, audits: 0 });

          const synthetic = makeSyntheticPatientIdentity(3);
          const created = await app.inject({
            method: "POST",
            url: "/api/v1/patients",
            headers: unsafeHeaders(clinicianSession),
            payload: { schemaVersion: "1", ...patientInput(synthetic) },
          });
          assert.equal(created.statusCode, 201);

          const overwritten = await app.inject({
            method: "POST",
            url: "/api/v1/patients",
            headers: unsafeHeaders(clinicianSession),
            payload: {
              schemaVersion: "1",
              ...patientInput(synthetic, {
                firstName: "Overwrite",
                identifierValue: " synthetic-000003 ",
              }),
            },
          });
          assert.equal(overwritten.statusCode, 200);
          assert.equal(overwritten.json().patient.id, created.json().patient.id);
          assert.equal(overwritten.json().patient.firstName, "Overwrite");
          assert.equal(
            overwritten.json().patient.researchCase.id,
            created.json().patient.researchCase.id,
          );

          const saved = await app.inject({
            method: "PUT",
            url: `/api/v1/patients/${created.json().patient.id}`,
            headers: unsafeHeaders(clinicianSession),
            payload: {
              schemaVersion: "1",
              firstName: "Last",
              lastName: "Writer",
              dateOfBirth: "1991-08-22",
              sex: "MALE",
            },
          });
          assert.equal(saved.statusCode, 200);
          assert.equal(saved.json().patient.firstName, "Last");

          const sharedList = await app.inject({
            method: "GET",
            url: "/api/v1/patients",
            headers: { cookie: secondClinicianSession.cookie },
          });
          assert.equal(sharedList.statusCode, 200);
          assert.deepEqual(
            sharedList.json().patients.map(({ id }) => id),
            [created.json().patient.id],
          );
          const sharedProfile = await app.inject({
            method: "GET",
            url: `/api/v1/patients/${created.json().patient.id}`,
            headers: { cookie: secondClinicianSession.cookie },
          });
          assert.equal(sharedProfile.statusCode, 200);
          assert.equal(sharedProfile.json().patient.firstName, "Last");

          for (const deniedRequest of [
            { method: "GET", url: "/api/v1/patients" },
            { method: "GET", url: `/api/v1/patients/${created.json().patient.id}` },
            {
              method: "POST",
              url: "/api/v1/patients",
              headers: unsafeHeaders(administratorSession),
              payload: { schemaVersion: "1", ...patientInput(makeSyntheticPatientIdentity(4)) },
            },
          ]) {
            const denied = await app.inject({
              ...deniedRequest,
              headers: deniedRequest.headers ?? { cookie: administratorSession.cookie },
            });
            assert.equal(denied.statusCode, 403);
          }

          for (const path of ["/api/v1/encounters", "/api/v1/visits"]) {
            const missing = await app.inject({
              method: "GET",
              url: path,
              headers: { cookie: clinicianSession.cookie },
            });
            assert.equal(missing.statusCode, 404);
          }
          const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
          assert.ok(openapi.json().paths["/api/v1/patients"]);
          assert.ok(openapi.json().paths["/api/v1/patients/{patientId}"]);
          assert.doesNotMatch(JSON.stringify(openapi.json().paths), /encounter|visit/i);
        } finally {
          await app.close();
        }
      }),
  );
});

function patientInput(synthetic, overrides = {}) {
  return {
    officialIdentifier: {
      type: identifierConfiguration.type,
      issuingAuthority: identifierConfiguration.issuingAuthority,
      value: overrides.identifierValue ?? synthetic.officialIdentifier,
    },
    firstName: overrides.firstName ?? synthetic.firstName,
    lastName: overrides.lastName ?? "Researcher",
    dateOfBirth: overrides.dateOfBirth ?? synthetic.birthDate,
    sex: overrides.sex ?? synthetic.sex,
  };
}

async function tableCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM insight.patients) AS patients,
      (SELECT count(*)::integer FROM insight.research_cases) AS "researchCases",
      (SELECT count(*)::integer FROM insight.patient_audit_events) AS audits
  `);
  return result.rows[0];
}

async function enableIdentifiedMode(pool) {
  const administrator = (
    await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
  ).rows[0];
  const evidence = await recordDeploymentEvidence(pool, administrator.id, {
    responsibleAuthority: "Synthetic Research Authority",
    approvalBasis: "Synthetic integration test",
    approvalReference: "SYNTHETIC-PATIENT-TEST",
    approvalGrantedAt: new Date("2020-01-01T00:00:00.000Z"),
    approvalExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    environmentStatus: "APPROVED_IDENTIFIED_RESEARCH",
    securityControls: allControls,
  });
  await activateIdentifiedResearchMode(pool, administrator.id, evidence.version);
}

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  return { cookie: setCookie.split(";", 1)[0], csrfToken: response.json().csrfToken };
}

function unsafeHeaders(session) {
  return { cookie: session.cookie, "x-csrf-token": session.csrfToken };
}

async function withPatientDatabase(operation) {
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

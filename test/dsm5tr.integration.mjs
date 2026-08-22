import assert from "node:assert/strict";
import test from "node:test";

import { buildApp, createOrOverwritePatient, createUser } from "../.tsbuild/server/index.js";
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
const answers = {
  criterionA: {
    delusions: true,
    hallucinations: true,
    disorganizedSpeech: false,
    disorganizedOrCatatonicBehavior: false,
    negativeSymptoms: false,
  },
  criterionBFunctionalDecline: true,
  criterionCDuration: true,
  criterionDMoodDisorderExclusion: true,
  criterionESubstanceOrMedicalExclusion: true,
  criterionFDevelopmentalHistory: false,
};

test("DSM-5-TR REST persistence keeps calculation and Psychiatrist authority separate", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const user = await createUser(pool, {
        username: "DsmResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(880);
      const created = await createOrOverwritePatient(
        pool,
        { id: user.id, role: user.role },
        {
          officialIdentifier: {
            type: identifierConfiguration.type,
            issuingAuthority: identifierConfiguration.issuingAuthority,
            value: synthetic.officialIdentifier,
          },
          firstName: synthetic.firstName,
          lastName: "Assessment",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000880",
        new Date("2026-08-22T10:00:00.000Z"),
      );
      const patientId = created.patient.id;
      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        patient: { officialIdentifier: identifierConfiguration },
      });
      try {
        const session = await login(app, user.username, "research-password");
        const initial = await request(app, session, "GET", patientId);
        assert.equal(initial.statusCode, 200);
        assert.equal(initial.json().assessment.status, "NOT_STARTED");
        assert.equal(initial.json().assessment.answers, null);

        const completed = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "COMPLETE",
          expectedRevision: 1,
          answers,
          psychiatristDecision: "SCHIZOPHRENIA_NOT_CONFIRMED",
        });
        assert.equal(completed.statusCode, 200);
        assert.equal(completed.json().assessment.status, "COMPLETED");
        assert.equal(completed.json().assessment.calculation.disposition, "CRITERIA_MET");
        assert.equal(
          completed.json().assessment.psychiatristDecision,
          "SCHIZOPHRENIA_NOT_CONFIRMED",
        );

        const stored = await pool.query(
          `SELECT instrument_version, schema_version, calculation_version,
                  created_by_user_id, updated_by_user_id, created_at, updated_at
           FROM insight.dsm5tr_assessments`,
        );
        assert.equal(stored.rowCount, 1);
        assert.equal(stored.rows[0].instrument_version, "DSM-5-TR-2022");
        assert.equal(stored.rows[0].schema_version, "1.0.0");
        assert.equal(stored.rows[0].calculation_version, "1.0.0");
        assert.equal(stored.rows[0].created_by_user_id, user.id);
        assert.equal(stored.rows[0].updated_by_user_id, user.id);
        assert.ok(stored.rows[0].created_at instanceof Date);
        assert.ok(stored.rows[0].updated_at instanceof Date);
        await assert.rejects(
          () =>
            pool.query(
              `UPDATE insight.dsm5tr_assessments
               SET calculation_result = '{"disposition":"CRITERIA_NOT_MET"}'`,
            ),
          /service-owned/,
        );

        const bypassed = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "BYPASS",
          expectedRevision: 1,
        });
        assert.equal(bypassed.statusCode, 200);
        assert.equal(bypassed.json().assessment.status, "BYPASSED");
        assert.equal(bypassed.json().assessment.answers, null);
        assert.equal(bypassed.json().assessment.calculation, null);
        assert.equal(bypassed.json().assessment.psychiatristDecision, null);
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
    }
  });
});

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers["set-cookie"].split(";", 1)[0];
  return { cookie, csrfToken: response.json().csrfToken };
}

function request(app, session, method, patientId, payload) {
  return app.inject({
    method,
    url: `/api/v1/patients/${patientId}/research-case/dsm5tr`,
    headers: {
      cookie: session.cookie,
      ...(method === "PUT" ? { "x-csrf-token": session.csrfToken } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

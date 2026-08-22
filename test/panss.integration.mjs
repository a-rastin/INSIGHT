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
const itemIds = [
  ...Array.from({ length: 7 }, (_, index) => `P${index + 1}`),
  ...Array.from({ length: 7 }, (_, index) => `N${index + 1}`),
  ...Array.from({ length: 16 }, (_, index) => `G${index + 1}`),
];
const minimum = Object.fromEntries(itemIds.map((id) => [id, 1]));

test("PANSS REST validation, persistence, completion, and bypass are server-authoritative", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const user = await createUser(pool, {
        username: "PanssResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(881);
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
          lastName: "Panss",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000881",
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
        assert.equal(initial.json().definition.items.length, 30);
        assert.equal(initial.json().assessment.status, "NOT_STARTED");

        const invalid = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: 1,
          answers: { P1: 0 },
        });
        assert.equal(invalid.statusCode, 400);

        const incompleteCompletion = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "COMPLETE",
          expectedRevision: 1,
          answers: { P1: 1 },
        });
        assert.equal(incompleteCompletion.statusCode, 409);

        const partial = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: 1,
          answers: { P1: 1 },
        });
        assert.equal(partial.statusCode, 200);
        assert.equal(partial.json().assessment.status, "IN_PROGRESS");
        assert.equal(partial.json().assessment.calculation.status, "INCOMPLETE");
        assert.equal(partial.json().assessment.calculation.scores, null);

        const completed = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "COMPLETE",
          expectedRevision: 1,
          answers: minimum,
        });
        assert.equal(completed.statusCode, 200);
        assert.equal(completed.json().assessment.status, "COMPLETED");
        assert.deepEqual(completed.json().assessment.calculation.scores, {
          positive: 7,
          negative: 7,
          general: 16,
          total: 30,
        });

        const stored = await pool.query(
          `SELECT instrument_version, schema_version, calculation_version, review_reference,
                  created_by_user_id, updated_by_user_id
           FROM insight.panss_assessments`,
        );
        assert.equal(stored.rowCount, 1);
        assert.equal(stored.rows[0].instrument_version, "KAY-OPLER-FISZBEIN-1987");
        assert.equal(stored.rows[0].schema_version, "1.0.0");
        assert.equal(stored.rows[0].calculation_version, "1.0.0");
        assert.match(stored.rows[0].review_reference, /PENDING-CLINICAL-REVIEW/);
        assert.equal(stored.rows[0].created_by_user_id, user.id);
        assert.equal(stored.rows[0].updated_by_user_id, user.id);
        await assert.rejects(
          () =>
            pool.query(
              `UPDATE insight.panss_assessments
               SET calculation_result = '{"status":"COMPLETE"}'`,
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
  return {
    cookie: response.headers["set-cookie"].split(";", 1)[0],
    csrfToken: response.json().csrfToken,
  };
}

function request(app, session, method, patientId, payload) {
  return app.inject({
    method,
    url: `/api/v1/patients/${patientId}/research-case/panss`,
    headers: {
      cookie: session.cookie,
      ...(method === "PUT" ? { "x-csrf-token": session.csrfToken } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

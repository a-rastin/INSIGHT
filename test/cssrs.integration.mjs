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

test("C-SSRS REST validation, exact persistence, local scoring, and bypass are authoritative", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const user = await createUser(pool, {
        username: "CssrsResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(882);
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
          lastName: "Cssrs",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000882",
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
        assert.equal(initial.json().definition.questions.length, 6);
        assert.equal(initial.json().assessment.status, "NOT_STARTED");
        assert.equal(initial.json().assessment.activationGate.status, "INACTIVE");

        const hiddenBranch = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: 1,
          answers: { q2SuicidalThoughts: false, q3Method: true },
        });
        assert.equal(hiddenBranch.statusCode, 409);

        const partial = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: 1,
          answers: { q1WishDead: false, q2SuicidalThoughts: false },
        });
        assert.equal(partial.statusCode, 200);
        assert.equal(partial.json().assessment.calculation.status, "INCOMPLETE");
        assert.equal(partial.json().assessment.calculation.band, null);

        const answers = {
          q1WishDead: false,
          q2SuicidalThoughts: true,
          q3Method: false,
          q4Intent: true,
          q5Plan: false,
          q6Behavior: true,
          q6WithinThreeMonths: false,
        };
        const autosaved = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "SAVE",
          expectedRevision: 1,
          answers,
        });
        assert.equal(autosaved.statusCode, 200);
        assert.equal(autosaved.json().assessment.status, "IN_PROGRESS");
        assert.equal(autosaved.json().assessment.calculation.band, "HIGH");

        const completed = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          mode: "COMPLETE",
          expectedRevision: 1,
          answers,
        });
        assert.equal(completed.statusCode, 200);
        assert.equal(completed.json().assessment.calculation.band, "HIGH");
        assert.deepEqual(completed.json().assessment.answers, answers);
        assert.deepEqual(completed.json().assessment.calculation.traversedQuestions, [
          "Q1",
          "Q2",
          "Q3",
          "Q4",
          "Q5",
          "Q6",
          "Q6_RECENCY",
        ]);

        const stored = await pool.query(
          `SELECT answers, calculation_result, instrument_version, source_sha256,
                  review_reference, research_activation_status,
                  created_by_user_id, updated_by_user_id
           FROM insight.cssrs_recent_assessments`,
        );
        assert.equal(stored.rowCount, 1);
        assert.deepEqual(stored.rows[0].answers, answers);
        assert.equal(stored.rows[0].calculation_result.traversedBranch, "Q2_YES_ASK_Q3_TO_Q5");
        assert.equal(
          stored.rows[0].source_sha256,
          "8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2",
        );
        assert.match(stored.rows[0].review_reference, /PENDING/);
        assert.equal(stored.rows[0].research_activation_status, "INACTIVE");
        assert.equal(stored.rows[0].created_by_user_id, user.id);
        assert.equal(stored.rows[0].updated_by_user_id, user.id);
        await assert.rejects(
          () =>
            pool.query(
              `UPDATE insight.cssrs_recent_assessments
               SET calculation_result = '{"status":"COMPLETE"}'`,
            ),
          /service-owned/,
        );

        const workflow = await pool.query(
          `SELECT workflow_state, workflow_revision
           FROM insight.research_cases WHERE patient_id = $1`,
          [patientId],
        );
        assert.deepEqual(workflow.rows[0], {
          workflow_state: "DATA_COLLECTION",
          workflow_revision: "1",
        });

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
    url: `/api/v1/patients/${patientId}/research-case/cssrs-recent`,
    headers: {
      cookie: session.cookie,
      ...(method === "PUT" ? { "x-csrf-token": session.csrfToken } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApp,
  createOrOverwritePatient,
  createUser,
  deletePatient,
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
const common = {
  currentMedications: [{ rawMedication: "metformin" }],
  comorbidities: [],
  supplementalNotes: "Synthetic history note",
};

test("medical-history API persists snapshots, validates conditions, clears first-presentation trials, and audits atomically", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const user = await createUser(pool, {
        username: "HistoryResearcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(884);
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
          lastName: "History",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000884",
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
        assert.equal(initial.json().medicalHistory, null);

        const known = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          expectedRevision: 1,
          history: {
            presentationStatus: "KNOWN_SCHIZOPHRENIA",
            previouslyTreated: true,
            priorTrials: [{ medication: "haloperidol" }],
            ...common,
          },
        });
        assert.equal(known.statusCode, 200);
        assert.equal(known.json().medicalHistory.revision, 1);
        assert.equal(Object.hasOwn(known.json().medicalHistory.priorTrials[0], "response"), false);
        assert.deepEqual(known.json().medicalHistory.currentMedications, common.currentMedications);

        const invalid = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          expectedRevision: 2,
          history: {
            presentationStatus: "KNOWN_SCHIZOPHRENIA",
            previouslyTreated: true,
            ...common,
          },
        });
        assert.equal(invalid.statusCode, 400);
        assert.equal(invalid.json().error.code, "INVALID_MEDICAL_HISTORY");
        assert.equal(await eventCount(pool), 1);

        const first = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          expectedRevision: 2,
          history: { presentationStatus: "FIRST_PRESENTATION", ...common },
        });
        assert.equal(first.statusCode, 200);
        assert.equal(first.json().medicalHistory.presentationStatus, "FIRST_PRESENTATION");
        assert.equal(Object.hasOwn(first.json().medicalHistory, "previouslyTreated"), false);
        assert.equal(Object.hasOwn(first.json().medicalHistory, "priorTrials"), false);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM insight.prior_antipsychotic_trials",
            )
          ).rows[0].count,
          0,
        );

        const explicitUnknown = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          expectedRevision: 3,
          history: {
            presentationStatus: "KNOWN_SCHIZOPHRENIA",
            previouslyTreated: true,
            priorTrials: [{ medication: "haloperidol", response: "UNKNOWN" }],
            ...common,
          },
        });
        assert.equal(explicitUnknown.statusCode, 200);
        assert.equal(explicitUnknown.json().medicalHistory.priorTrials[0].response, "UNKNOWN");

        const stale = await request(app, session, "PUT", patientId, {
          schemaVersion: "1",
          expectedRevision: 3,
          history: { presentationStatus: "FIRST_PRESENTATION", ...common },
        });
        assert.equal(stale.statusCode, 409);
        assert.equal(await eventCount(pool), 3);

        const events = await pool.query(
          `SELECT revision, actor_user_id, request_id
           FROM insight.medical_history_save_events ORDER BY revision`,
        );
        assert.deepEqual(
          events.rows.map(({ revision }) => Number(revision)),
          [1, 2, 3],
        );
        assert.ok(events.rows.every(({ actor_user_id }) => actor_user_id === user.id));
        assert.ok(events.rows.every(({ request_id }) => request_id));
        await assert.rejects(
          () => pool.query("UPDATE insight.medical_histories SET supplemental_notes = 'unaudited'"),
          /service-owned/,
        );

        await deletePatient(
          pool,
          { id: user.id, role: user.role },
          patientId,
          "00000000-0000-4000-8000-000000000885",
          { artifactRoot: "/tmp/insight-medical-history-test" },
        );
        assert.equal(
          (await pool.query("SELECT count(*)::integer AS count FROM insight.medical_histories"))
            .rows[0].count,
          0,
        );
        assert.equal(await eventCount(pool), 3);
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
    }
  });
});

async function eventCount(pool) {
  return (
    await pool.query("SELECT count(*)::integer AS count FROM insight.medical_history_save_events")
  ).rows[0].count;
}

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
    url: `/api/v1/patients/${patientId}/research-case/medical-history`,
    headers: {
      cookie: session.cookie,
      ...(method === "PUT" ? { "x-csrf-token": session.csrfToken } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

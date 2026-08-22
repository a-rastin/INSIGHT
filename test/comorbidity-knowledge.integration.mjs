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

function knowledge(label, value) {
  return {
    sourceReference: `synthetic://source/${label}`,
    reviewerRecord: {
      reviewerId: "synthetic-reviewer",
      reviewedAt: "2026-01-01T00:00:00.000Z",
      recordReference: `synthetic://review/${label}`,
    },
    terms: [
      { termId: "TERM_A", label: `${label} A` },
      { termId: "TERM_B", label: `${label} B` },
    ],
    rules: [
      {
        ruleId: "RULE_A",
        allOfTermIds: ["TERM_A"],
        results: [
          {
            kind: "CONTRAINDICATION",
            targetId: "OPTION_X",
            value,
            explanation: `${label} explanation`,
          },
        ],
      },
      {
        ruleId: "RULE_B",
        allOfTermIds: ["TERM_B"],
        results: [
          {
            kind: "BN_ROUTING_FACT",
            targetId: "PATHWAY_B",
            value: "ELIGIBLE",
            explanation: `${label} B explanation`,
          },
        ],
      },
    ],
  };
}

test("comorbidity results and reviewer provenance remain pinned after later activation", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const administrator = await createUser(pool, {
        username: "ComorbidityAdministrator",
        password: "catalog-admin-password",
        role: "ADMINISTRATOR",
      });
      const psychiatrist = await createUser(pool, {
        username: "ComorbidityPsychiatrist",
        password: "catalog-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(933);
      const created = await createOrOverwritePatient(
        pool,
        { id: psychiatrist.id, role: psychiatrist.role },
        {
          officialIdentifier: {
            type: identifierConfiguration.type,
            issuingAuthority: identifierConfiguration.issuingAuthority,
            value: synthetic.officialIdentifier,
          },
          firstName: synthetic.firstName,
          lastName: "Comorbidity",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000933",
      );
      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        patient: { officialIdentifier: identifierConfiguration },
      });
      try {
        const adminSession = await login(app, administrator.username, "catalog-admin-password");
        const psychiatristSession = await login(
          app,
          psychiatrist.username,
          "catalog-psychiatrist-password",
        );
        const v1 = (await saveKnowledge(app, adminSession, knowledge("v1", "EXCLUDE_V1"))).json()
          .knowledge;
        assert.equal(v1.reviewerRecord.reviewerId, "synthetic-reviewer");

        const saved = await request(
          app,
          psychiatristSession,
          "PUT",
          `/patients/${created.patient.id}/research-case/medical-history`,
          {
            schemaVersion: "1",
            expectedRevision: 1,
            history: {
              presentationStatus: "FIRST_PRESENTATION",
              currentMedications: [],
              comorbidities: [
                {
                  catalogVersionId: v1.id,
                  termId: "TERM_A",
                  supplementalText: "TERM_B must not match",
                },
              ],
            },
          },
        );
        assert.equal(saved.statusCode, 200);
        assert.equal(saved.json().medicalHistory.comorbidities[0].label, "v1 A");
        assert.equal(saved.json().medicalHistory.ruleEvaluation.knowledgeVersionId, v1.id);
        assert.deepEqual(
          saved
            .json()
            .medicalHistory.ruleEvaluation.results.map(({ ruleId, value }) => [ruleId, value]),
          [["RULE_A", "EXCLUDE_V1"]],
        );

        const v2 = (await saveKnowledge(app, adminSession, knowledge("v2", "EXCLUDE_V2"))).json()
          .knowledge;
        assert.notEqual(v2.id, v1.id);
        const pinned = await request(
          app,
          psychiatristSession,
          "GET",
          `/patients/${created.patient.id}/research-case/medical-history`,
        );
        assert.equal(pinned.json().medicalHistory.ruleEvaluation.knowledgeVersionId, v1.id);
        assert.equal(pinned.json().medicalHistory.ruleEvaluation.results[0].value, "EXCLUDE_V1");

        const history = await request(app, adminSession, "GET", "/admin/comorbidity-knowledge");
        assert.deepEqual(
          history.json().versions.map(({ version, active }) => [version, active]),
          [
            [2, true],
            [1, false],
          ],
        );
        await assert.rejects(
          () =>
            pool.query(
              "UPDATE insight.comorbidity_knowledge_terms SET label = 'changed' WHERE knowledge_version_id = $1",
              [v1.id],
            ),
          /immutable/,
        );
        assert.equal(
          (
            await request(app, psychiatristSession, "POST", "/admin/comorbidity-knowledge", {
              schemaVersion: "1",
              knowledge: knowledge("v3", "EXCLUDE_V3"),
            })
          ).statusCode,
          403,
        );
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
    }
  });
});

async function saveKnowledge(app, session, value) {
  const response = await request(app, session, "POST", "/admin/comorbidity-knowledge", {
    schemaVersion: "1",
    knowledge: value,
  });
  assert.equal(response.statusCode, 201);
  return response;
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

function request(app, session, method, path, payload) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      cookie: session.cookie,
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
        ? { "x-csrf-token": session.csrfToken }
        : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

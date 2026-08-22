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

const v1Terms = [
  { termId: "AKATHISIA", label: "Akathisia v1" },
  { termId: "NAUSEA", label: "Nausea" },
  { termId: "OTHER", label: "Other" },
];
const v2Terms = [
  { termId: "AKATHISIA", label: "Akathisia v2" },
  { termId: "SEDATION", label: "Sedation" },
  { termId: "OTHER", label: "Other" },
];

test("adverse-effect versions activate immediately while case selections remain pinned and role-separated", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const administrator = await createUser(pool, {
        username: "CatalogAdministrator",
        password: "catalog-admin-password",
        role: "ADMINISTRATOR",
      });
      const psychiatrist = await createUser(pool, {
        username: "CatalogPsychiatrist",
        password: "catalog-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(932);
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
          lastName: "Catalog",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000932",
      );
      const patientId = created.patient.id;
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

        const first = await catalogSave(app, adminSession, v1Terms);
        assert.equal(first.statusCode, 201);
        const v1 = first.json().catalog;
        assert.equal(v1.version, 1);
        assert.equal(v1.active, true);

        const activeV1 = await request(app, psychiatristSession, "GET", "/adverse-effect-catalog");
        assert.equal(activeV1.statusCode, 200);
        assert.equal(activeV1.json().catalog.id, v1.id);

        const history = historyInput(v1.id);
        const saved = await request(
          app,
          psychiatristSession,
          "PUT",
          `/patients/${patientId}/research-case/medical-history`,
          { schemaVersion: "1", expectedRevision: 1, history },
        );
        assert.equal(saved.statusCode, 200);
        assert.equal(saved.json().medicalHistory.priorTrials[0].otherAdverseEffectDetail, "");
        assert.deepEqual(
          saved.json().medicalHistory.priorTrials[0].adverseEffects.map(({ termId }) => termId),
          ["AKATHISIA", "OTHER"],
        );

        const second = await catalogSave(app, adminSession, v2Terms);
        assert.equal(second.statusCode, 201);
        const v2 = second.json().catalog;
        assert.equal(v2.version, 2);
        assert.notEqual(v2.id, v1.id);

        const activeV2 = await request(app, psychiatristSession, "GET", "/adverse-effect-catalog");
        assert.equal(activeV2.json().catalog.id, v2.id);
        const pinned = await request(
          app,
          psychiatristSession,
          "GET",
          `/patients/${patientId}/research-case/medical-history`,
        );
        assert.equal(pinned.statusCode, 200);
        assert.deepEqual(pinned.json().medicalHistory.priorTrials[0].adverseEffects, [
          { catalogVersionId: v1.id, termId: "AKATHISIA", label: "Akathisia v1" },
          { catalogVersionId: v1.id, termId: "OTHER", label: "Other" },
        ]);

        const unchangedPinned = await request(
          app,
          psychiatristSession,
          "PUT",
          `/patients/${patientId}/research-case/medical-history`,
          { schemaVersion: "1", expectedRevision: 2, history },
        );
        assert.equal(unchangedPinned.statusCode, 200);
        assert.equal(
          unchangedPinned.json().medicalHistory.priorTrials[0].adverseEffects[0].catalogVersionId,
          v1.id,
        );

        const staleNewSelection = historyInput(v1.id);
        staleNewSelection.priorTrials[0].adverseEffects.push({
          catalogVersionId: v1.id,
          termId: "NAUSEA",
        });
        const rejected = await request(
          app,
          psychiatristSession,
          "PUT",
          `/patients/${patientId}/research-case/medical-history`,
          { schemaVersion: "1", expectedRevision: 3, history: staleNewSelection },
        );
        assert.equal(rejected.statusCode, 400);

        const activeSelection = historyInput(v2.id);
        activeSelection.priorTrials[0].adverseEffects.push({
          catalogVersionId: v2.id,
          termId: "SEDATION",
        });
        const selectedFromActive = await request(
          app,
          psychiatristSession,
          "PUT",
          `/patients/${patientId}/research-case/medical-history`,
          { schemaVersion: "1", expectedRevision: 3, history: activeSelection },
        );
        assert.equal(selectedFromActive.statusCode, 200);
        assert.ok(
          selectedFromActive
            .json()
            .medicalHistory.priorTrials[0].adverseEffects.every(
              ({ catalogVersionId }) => catalogVersionId === v2.id,
            ),
        );

        const historyVersions = await request(
          app,
          adminSession,
          "GET",
          "/admin/adverse-effect-catalog",
        );
        assert.deepEqual(
          historyVersions.json().versions.map(({ version, active }) => [version, active]),
          [
            [2, true],
            [1, false],
          ],
        );
        await assert.rejects(
          () =>
            pool.query(
              "UPDATE insight.adverse_effect_catalog_terms SET label = 'Changed' WHERE catalog_version_id = $1",
              [v1.id],
            ),
          /immutable/,
        );
        await assert.rejects(
          () =>
            pool.query(
              `INSERT INTO insight.adverse_effect_catalog_terms
                 (catalog_version_id, term_id, label, position)
               VALUES ($1, 'LATE_TERM', 'Late term', 99)`,
              [v1.id],
            ),
          /immutable/,
        );

        assert.equal(
          (
            await request(app, psychiatristSession, "POST", "/admin/adverse-effect-catalog", {
              schemaVersion: "1",
              catalog: { terms: v2Terms },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              app,
              adminSession,
              "GET",
              `/patients/${patientId}/research-case/medical-history`,
            )
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

function historyInput(catalogVersionId) {
  return {
    presentationStatus: "KNOWN_SCHIZOPHRENIA",
    previouslyTreated: true,
    priorTrials: [
      {
        medication: "haloperidol",
        adverseEffects: [
          { catalogVersionId, termId: "AKATHISIA" },
          { catalogVersionId, termId: "OTHER" },
        ],
        otherAdverseEffectDetail: "",
      },
    ],
    currentMedications: [],
    comorbidities: [],
    contraindications: [],
  };
}

async function catalogSave(app, session, terms) {
  return request(app, session, "POST", "/admin/adverse-effect-catalog", {
    schemaVersion: "1",
    catalog: { terms },
  });
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

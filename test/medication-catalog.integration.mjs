import assert from "node:assert/strict";
import test from "node:test";

import {
  InternalMcpGateway,
  MedicationAuthorizationError,
  buildApp,
  createOrOverwritePatient,
  createMedicationToolHandlers,
  createUser,
  saveMedicalHistory,
  saveMedicationCatalog,
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

const v1Entries = [
  { canonicalId: "RX-HALOPERIDOL", preferredName: "Haloperidol", synonyms: ["Haldol"] },
  { canonicalId: "RX-RISPERIDONE", preferredName: "Risperidone", synonyms: ["Risperdal"] },
];
const v2Entries = [
  { canonicalId: "RX-HALOPERIDOL", preferredName: "Haloperidol v2", synonyms: ["Haldol"] },
  { canonicalId: "RX-CLOZAPINE", preferredName: "Clozapine", synonyms: ["Clozaril"] },
];

test("candidate commits validate exact returned set, pin versions, persist provenance, and allow UNKNOWN", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target PostgreSQL 16 with create-database permission.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const administrator = await createUser(pool, {
        username: "MedicationAdministrator",
        password: "medication-admin-password",
        role: "ADMINISTRATOR",
      });
      const psychiatrist = await createUser(pool, {
        username: "MedicationPsychiatrist",
        password: "medication-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      const synthetic = makeSyntheticPatientIdentity(947);
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
          lastName: "Medication",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000947",
      );
      await saveMedicalHistory(
        pool,
        { id: psychiatrist.id, role: psychiatrist.role },
        created.patient.id,
        {
          presentationStatus: "KNOWN_SCHIZOPHRENIA",
          previouslyTreated: true,
          priorTrials: [{ medication: "unlisted medicine" }],
          currentMedications: [{ rawMedication: "Haldol 5 mg" }],
          comorbidities: [],
        },
        1,
        "00000000-0000-4000-8000-000000000948",
      );
      const caseId = created.patient.researchCase.id;
      const v1 = await saveMedicationCatalog(pool, administrator, { entries: v1Entries });
      const execution1 = {
        executionId: "medication-execution-1",
        researchCaseId: caseId,
        model: "synthetic-model-v1",
        promptVersion: "medication-prompt-v3",
        schemaVersion: "medication-tools-1.0.0",
      };
      const gateway1 = new InternalMcpGateway(
        createMedicationToolHandlers(pool, async () => execution1),
        () => new Date("2026-08-23T12:00:00.000Z"),
      );
      const context1 = toolContext(execution1.executionId);
      const searchResult = await gateway1.invoke(context1, {
        name: "medication.search_candidates",
        input: { medicationEntryRef: "current-1", query: "  HALDOL® 5 mg " },
      });
      assert.equal(searchResult.ok, true);
      const searched = searchResult.data;
      assert.equal(searched.catalogVersion, "medication-catalog-1");
      assert.deepEqual(
        searched.candidates.map(({ canonicalId }) => canonicalId),
        ["RX-HALOPERIDOL"],
      );
      const secondSearch = await gateway1.invoke(context1, {
        name: "medication.search_candidates",
        input: { medicationEntryRef: "current-1", query: "Risperdal" },
      });
      assert.equal(secondSearch.ok, true);
      assert.deepEqual(
        secondSearch.data.candidates.map(({ canonicalId }) => canonicalId),
        ["RX-RISPERIDONE"],
      );

      for (const input of [
        {
          medicationEntryRef: "current-1",
          catalogVersion: searched.catalogVersion,
          selectedCanonicalId: "RX-CLOZAPINE",
        },
        {
          medicationEntryRef: "prior-1",
          catalogVersion: searched.catalogVersion,
          selectedCanonicalId: "RX-HALOPERIDOL",
        },
      ]) {
        const invalid = await gateway1.invoke(context1, {
          name: "medication.commit_mapping",
          input,
        });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.error.code, "MEDICATION_CANDIDATE_INVALID");
      }

      const v2 = await saveMedicationCatalog(pool, administrator, { entries: v2Entries });
      const commitResult = await gateway1.invoke(context1, {
        name: "medication.commit_mapping",
        input: {
          medicationEntryRef: "current-1",
          catalogVersion: searched.catalogVersion,
          selectedCanonicalId: "RX-HALOPERIDOL",
        },
      });
      assert.equal(commitResult.ok, true);
      const committed = commitResult.data;
      assert.deepEqual(committed, {
        normalizationState: "NORMALIZED",
        canonicalId: "RX-HALOPERIDOL",
        preferredName: "Haloperidol",
      });

      const execution2 = { ...execution1, executionId: "medication-execution-2" };
      const gateway2 = new InternalMcpGateway(
        createMedicationToolHandlers(pool, async () => execution2),
      );
      const context2 = toolContext(execution2.executionId);
      const noCandidateResult = await gateway2.invoke(context2, {
        name: "medication.search_candidates",
        input: { medicationEntryRef: "prior-1", query: "unlisted medicine" },
      });
      assert.equal(noCandidateResult.ok, true);
      const noCandidates = noCandidateResult.data;
      assert.equal(noCandidates.catalogVersion, "medication-catalog-2");
      assert.deepEqual(noCandidates.candidates, []);
      const unknown = await gateway2.invoke(context2, {
        name: "medication.commit_mapping",
        input: {
          medicationEntryRef: "prior-1",
          catalogVersion: noCandidates.catalogVersion,
          selectedCanonicalId: null,
        },
      });
      assert.equal(unknown.ok, true);
      assert.deepEqual(unknown.data, { normalizationState: "UNKNOWN" });

      const mappings = await pool.query(
        `SELECT mapping.medication_entry_ref,mapping.catalog_version,mapping.raw_text,mapping.candidates,
                mapping.canonical_id,mapping.preferred_name,mapping.model,mapping.prompt_version,
                mapping.schema_version,mapping.selected_at
         FROM insight.medication_mappings mapping ORDER BY medication_entry_ref`,
      );
      assert.equal(mappings.rows.length, 2);
      const normalized = mappings.rows.find(
        ({ medication_entry_ref }) => medication_entry_ref === "current-1",
      );
      assert.equal(normalized.catalog_version, 1);
      assert.equal(normalized.raw_text, "Haldol 5 mg");
      assert.equal(normalized.preferred_name, "Haloperidol");
      assert.equal(normalized.model, execution1.model);
      assert.equal(normalized.prompt_version, execution1.promptVersion);
      assert.equal(normalized.schema_version, execution1.schemaVersion);
      assert.ok(normalized.selected_at instanceof Date);
      assert.deepEqual(
        normalized.candidates.map(({ canonicalId }) => canonicalId),
        ["RX-HALOPERIDOL"],
      );

      const stored = await pool.query(
        `SELECT normalization_state,canonical_medication_id,medication_catalog_version_id
         FROM insight.current_medication_entries WHERE research_case_id=$1`,
        [caseId],
      );
      assert.equal(stored.rows[0].normalization_state, "NORMALIZED");
      assert.equal(stored.rows[0].canonical_medication_id, "RX-HALOPERIDOL");
      assert.equal(stored.rows[0].medication_catalog_version_id, v1.id);
      assert.notEqual(stored.rows[0].medication_catalog_version_id, v2.id);

      await assert.rejects(
        () =>
          pool.query(
            "UPDATE insight.medication_catalog_entries SET preferred_name='Changed' WHERE catalog_version_id=$1",
            [v1.id],
          ),
        /immutable/,
      );
      await assert.rejects(
        () => saveMedicationCatalog(pool, psychiatrist, { entries: v2Entries }),
        MedicationAuthorizationError,
      );

      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        patient: { officialIdentifier: identifierConfiguration },
      });
      try {
        const adminSession = await login(app, administrator.username, "medication-admin-password");
        const psychiatristSession = await login(
          app,
          psychiatrist.username,
          "medication-psychiatrist-password",
        );
        assert.equal(
          (await request(app, adminSession, "GET", "/admin/medication-catalog")).statusCode,
          200,
        );
        assert.equal(
          (
            await request(app, psychiatristSession, "POST", "/admin/medication-catalog", {
              schemaVersion: "1",
              catalog: { entries: v2Entries },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await request(app, adminSession, "GET", `/patients/${created.patient.id}`)).statusCode,
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

function toolContext(executionId) {
  return {
    executionId,
    jobId: `${executionId}-job`,
    subjectRef: `${executionId}-subject`,
    researchCaseRevision: 2,
    workflowState: "NORMALIZING_MEDICATIONS",
    actorRole: "PSYCHIATRIST",
    allowedToolNames: [
      "research_case.get_context",
      "medication.search_candidates",
      "medication.commit_mapping",
    ],
    idempotencyKey: `${executionId}-key`,
  };
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

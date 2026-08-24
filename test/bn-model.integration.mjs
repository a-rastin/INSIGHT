import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BnModelAuthorizationError,
  BnModelUnavailableError,
  createOrOverwritePatient,
  createBnModelCandidate,
  createUser,
  disableBnModel,
  getBnModelHistory,
  getBnModelSource,
  importAndRegisterBnModel,
  pinBnModelForExecution,
  rollbackBnModel,
  routeAndRecordBnModels,
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
const source = (table) => `<BIF VERSION="0.3"><NETWORK><NAME>MedicationChoice</NAME>
  <VARIABLE TYPE="nature"><NAME>Input</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="nature"><NAME>Choice</NAME><OUTCOME>first</OUTCOME><OUTCOME>second</OUTCOME></VARIABLE>
  <DEFINITION><FOR>Input</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
  <DEFINITION><FOR>Choice</FOR><GIVEN>Input</GIVEN><TABLE>${table}</TABLE></DEFINITION>
</NETWORK></BIF>`;
const pharmacotherapyOnlyRouting = {
  version: "test-pharmacotherapy-only-v1",
  approvalRef: "TEST-ONLY-PHARMACOTHERAPY-ROUTE",
  requiredRouteGroups: ["PRIMARY_TREATMENT"],
  optionalRouteGroups: [],
  rules: [
    {
      ref: "BN-ROUTE-PHARMACOTHERAPY-001",
      routeGroup: "PRIMARY_TREATMENT",
      pathwayIdentity: "PHARMACOTHERAPY",
      all: [
        {
          fact: "PRESENTATION_STATUS_IN",
          values: ["FIRST_PRESENTATION", "KNOWN_SCHIZOPHRENIA"],
        },
      ],
    },
  ],
};

function input(xml, fileName) {
  return {
    candidate: { pathwayIdentity: "PHARMACOTHERAPY", artifactPath: fileName, version: 99 },
    source: xml,
  };
}

test("BN registry assigns immutable valid and invalid versions with matching projections", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-bn-model-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "BnAdministrator",
          password: "bn-admin-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "BnPsychiatrist",
          password: "bn-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        const actor = { id: administrator.id, role: administrator.role };
        const valid = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.1 0.9 0.8 0.2"), "valid.xml"),
          { artifactRoot },
        );
        const duplicate = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.1 0.9 0.8 0.2"), "renamed.xml"),
          { artifactRoot },
        );
        const editedSource = source("0.1 0.9 0.8 0.2").replace(
          "</VARIABLE>",
          "<PROPERTY>position = (120, 80)</PROPERTY></VARIABLE>",
        );
        const formattingCandidate = await createBnModelCandidate(
          pool,
          actor,
          valid.id,
          `\n${source("0.1 0.9 0.8 0.2")}`,
          { artifactRoot },
        );
        const candidate = await createBnModelCandidate(pool, actor, valid.id, editedSource, {
          artifactRoot,
        });
        await assert.rejects(
          createBnModelCandidate(pool, actor, valid.id, source("0.2 0.2 0.8 0.2"), {
            artifactRoot,
          }),
          /must pass all software validation checks/,
        );
        const invalid = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.2 0.2 0.8 0.2"), "invalid.xml"),
          { artifactRoot },
        );

        assert.equal(valid.version, 1);
        assert.equal(valid.lifecycle, "ACTIVE");
        assert.equal(duplicate.id, valid.id);
        assert.equal(formattingCandidate.version, 2);
        assert.equal(formattingCandidate.lifecycle, "ACTIVE");
        assert.equal(formattingCandidate.source.semanticSha256, valid.source.semanticSha256);
        assert.equal(candidate.version, 3);
        assert.equal(candidate.lifecycle, "ACTIVE");
        assert.notEqual(candidate.source.contentSha256, valid.source.contentSha256);
        assert.equal(await getBnModelSource(pool, actor, candidate.id, artifactRoot), editedSource);
        const active = await pool.query(
          "SELECT model_version_id FROM insight.bn_active_models WHERE pathway_identity = $1",
          ["PHARMACOTHERAPY"],
        );
        assert.equal(active.rows[0].model_version_id, candidate.id);
        assert.equal(invalid.version, 4);
        assert.equal(invalid.lifecycle, "REJECTED");
        assert.equal(invalid.validation.softwareCompatible, false);
        assert.ok(
          invalid.validation.diagnostics.some(
            ({ code }) => code === "CPT_DISTRIBUTION_NOT_NORMALIZED",
          ),
        );
        assert.deepEqual(invalid.networks[0].edges, [{ source: "Input", target: "Choice" }]);
        assert.equal(invalid.calibration.status, "UNCALIBRATED");
        assert.equal(invalid.validation.clinicalValidity, "NOT_ESTABLISHED");

        const patient = await createPatient(pool, psychiatrist, 941);
        const routing = await routeAndRecordBnModels(
          pool,
          { id: psychiatrist.id, role: psychiatrist.role },
          {
            researchCaseId: patient.patient.researchCase.id,
            researchCaseRevision: 1,
            facts: {
              demographics: { age: 36, sex: "FEMALE" },
              presentationStatus: "KNOWN_SCHIZOPHRENIA",
              assessments: [
                { type: "DSM5TR", state: "COMPLETED", result: "SCHIZOPHRENIA_CONFIRMED" },
                { type: "PANSS", state: "COMPLETED", result: "TOTAL_82" },
                { type: "CSSRS_RECENT", state: "BYPASSED" },
              ],
              comorbidityTermIds: [],
              medicationHistory: [],
              currentRegimen: [],
            },
            artifact: pharmacotherapyOnlyRouting,
          },
        );
        assert.deepEqual(routing.matchedRuleRefs, ["BN-ROUTE-PHARMACOTHERAPY-001"]);
        assert.deepEqual(
          routing.selectedModels.map(({ modelId }) => modelId),
          [candidate.id],
        );
        const recordedRouting = await pool.query(
          `SELECT matched_rule_refs, selected_models
           FROM insight.bn_routing_evaluations WHERE id = $1`,
          [routing.evaluationId],
        );
        assert.deepEqual(recordedRouting.rows[0].matched_rule_refs, routing.matchedRuleRefs);
        assert.equal(recordedRouting.rows[0].selected_models[0].version, candidate.version);
        const routingPin = await pool.query(
          `SELECT model_version_id FROM insight.bn_research_case_model_pins
           WHERE research_case_id = $1 AND pathway_identity = 'PHARMACOTHERAPY'`,
          [patient.patient.researchCase.id],
        );
        assert.equal(routingPin.rows[0].model_version_id, candidate.id);
        await assert.rejects(
          pool.query(
            "UPDATE insight.bn_routing_evaluations SET research_case_revision = 2 WHERE id = $1",
            [routing.evaluationId],
          ),
          /immutable/,
        );
        const originalPin = await pinBnModelForExecution(
          pool,
          patient.patient.researchCase.id,
          "PHARMACOTHERAPY",
        );
        assert.equal(originalPin.modelId, candidate.id);

        const concurrent = await Promise.all([
          importAndRegisterBnModel(
            pool,
            actor,
            input(source("0.2 0.8 0.7 0.3"), "concurrent-a.xml"),
            { artifactRoot },
          ),
          importAndRegisterBnModel(
            pool,
            actor,
            input(source("0.3 0.7 0.6 0.4"), "concurrent-b.xml"),
            { artifactRoot },
          ),
        ]);
        const newest = concurrent.toSorted((left, right) => right.version - left.version)[0];
        assert.equal(newest.version, 6);
        assert.equal(newest.lifecycle, "ACTIVE");
        assert.equal(
          (await pinBnModelForExecution(pool, patient.patient.researchCase.id, "PHARMACOTHERAPY"))
            .modelId,
          candidate.id,
        );

        const restored = await rollbackBnModel(pool, actor, valid.id, { artifactRoot });
        assert.equal(restored.lifecycle, "ACTIVE");
        const laterPatient = await createPatient(pool, psychiatrist, 942);
        assert.equal(
          (
            await Promise.all([
              pinBnModelForExecution(pool, laterPatient.patient.researchCase.id, "PHARMACOTHERAPY"),
              pinBnModelForExecution(pool, laterPatient.patient.researchCase.id, "PHARMACOTHERAPY"),
            ])
          )[0].modelId,
          valid.id,
        );
        await disableBnModel(pool, actor, valid.id, { artifactRoot });
        const disabledPatient = await createPatient(pool, psychiatrist, 943);
        await assert.rejects(
          pinBnModelForExecution(pool, disabledPatient.patient.researchCase.id, "PHARMACOTHERAPY"),
          BnModelUnavailableError,
        );
        assert.equal(
          (await pinBnModelForExecution(pool, patient.patient.researchCase.id, "PHARMACOTHERAPY"))
            .modelId,
          candidate.id,
        );
        await assert.rejects(
          pool.query(
            "UPDATE insight.bn_research_case_model_pins SET model_version = 99 WHERE research_case_id = $1",
            [patient.patient.researchCase.id],
          ),
          /immutable/,
        );
        const events = await pool.query(
          `SELECT lifecycle FROM insight.bn_model_lifecycle_events
           WHERE model_version_id = $1 ORDER BY sequence`,
          [valid.id],
        );
        assert.deepEqual(
          events.rows.map(({ lifecycle }) => lifecycle),
          ["IMPORTED", "ACTIVE", "SUPERSEDED", "ACTIVE", "DISABLED"],
        );

        const history = await getBnModelHistory(pool, actor, artifactRoot);
        assert.deepEqual(
          history.map(({ version }) => version),
          [6, 5, 4, 3, 2, 1],
        );
        await assert.rejects(
          pool.query("UPDATE insight.bn_model_versions SET version = 4 WHERE id = $1", [valid.id]),
          /immutable/,
        );
        await assert.rejects(
          getBnModelHistory(pool, { id: psychiatrist.id, role: psychiatrist.role }, artifactRoot),
          BnModelAuthorizationError,
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

async function createPatient(pool, psychiatrist, seed) {
  const synthetic = makeSyntheticPatientIdentity(seed);
  return createOrOverwritePatient(
    pool,
    { id: psychiatrist.id, role: psychiatrist.role },
    {
      officialIdentifier: {
        type: identifierConfiguration.type,
        issuingAuthority: identifierConfiguration.issuingAuthority,
        value: synthetic.officialIdentifier,
      },
      firstName: synthetic.firstName,
      lastName: "BnLifecycle",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
  );
}

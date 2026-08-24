import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseXmlBif } from "../packages/bayes/dist/index.js";
import {
  createOrOverwritePatient,
  createUser,
  getRoutedCptContracts,
  importAndRegisterBnModel,
  routeAndRecordBnModels,
  runBnInference,
  submitCptSnapshot,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
  withTransaction,
} from "../.tsbuild/server/database/index.js";
import { makeSyntheticPatientIdentity } from "./support/synthetic-data.mjs";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};
const candidates = [
  ["PHARMACOTHERAPY", "Pharmacotherapy/BN-Pharmacotherapy.xml"],
  ["TREATMENT_SETTING", "Treatment-Setting/BN-Treatment-Setting.xml"],
  [
    "CLOZAPINE_TREATMENT_RESISTANCE",
    "7 - Clozapine in Treatment-Resistant Schizophrenia/gemini-code-1783422447172.xml",
  ],
  ["CLOZAPINE_SUICIDE_RISK", "Clozapine in Suicide Risk/BN-Clozapine-in-Suicide-Risk.xml"],
];

test("synthetic Treatment Setting and clozapine pathway replay is pinned and deterministic", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-bn-pathways-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "PathwayAdministrator",
          password: "pathway-admin-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "PathwayPsychiatrist",
          password: "pathway-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        const sources = new Map();
        for (const [pathwayIdentity, artifactPath] of candidates) {
          const source = await readFile(new URL(`../BNs/${artifactPath}`, import.meta.url), "utf8");
          sources.set(pathwayIdentity, source);
          const imported = await importAndRegisterBnModel(
            pool,
            { id: administrator.id, role: administrator.role },
            {
              candidate: { pathwayIdentity, artifactPath, version: 1 },
              source,
            },
            { artifactRoot },
          );
          assert.equal(imported.lifecycle, "ACTIVE");
          assert.equal(imported.validation.softwareCompatible, true);
        }

        const synthetic = makeSyntheticPatientIdentity(981);
        const patient = await createOrOverwritePatient(
          pool,
          { id: psychiatrist.id, role: psychiatrist.role },
          {
            officialIdentifier: {
              type: identifierConfiguration.type,
              issuingAuthority: identifierConfiguration.issuingAuthority,
              value: synthetic.officialIdentifier,
            },
            firstName: synthetic.firstName,
            lastName: "PathwayReplay",
            dateOfBirth: synthetic.birthDate,
            sex: synthetic.sex,
          },
          identifierConfiguration,
          "00000000-0000-4000-8000-000000000981",
        );
        const researchCaseId = patient.patient.researchCase.id;
        const routing = await routeAndRecordBnModels(
          pool,
          { id: psychiatrist.id, role: psychiatrist.role },
          {
            researchCaseId,
            researchCaseRevision: 1,
            facts: {
              demographics: { age: 36, sex: "FEMALE" },
              presentationStatus: "KNOWN_SCHIZOPHRENIA",
              assessments: [
                { type: "DSM5TR", state: "COMPLETED", result: "SCHIZOPHRENIA_CONFIRMED" },
                { type: "PANSS", state: "COMPLETED", result: "TOTAL_82" },
                { type: "CSSRS_RECENT", state: "COMPLETED", result: "HIGH" },
              ],
              comorbidityTermIds: [],
              medicationHistory: [
                {
                  canonicalMedicationId: "RX-RISPERIDONE",
                  response: "NO_RESPONSE",
                  adequateDose: true,
                  adequateDuration: true,
                  adequateAdherence: true,
                },
                {
                  canonicalMedicationId: "RX-OLANZAPINE",
                  response: "PARTIAL_RESPONSE",
                  adequateDose: true,
                  adequateDuration: true,
                  adequateAdherence: true,
                },
              ],
              currentRegimen: [],
            },
          },
        );
        assert.deepEqual(
          routing.selectedModels.map(({ pathwayIdentity }) => pathwayIdentity),
          [
            "CLOZAPINE_SUICIDE_RISK",
            "CLOZAPINE_TREATMENT_RESISTANCE",
            "PHARMACOTHERAPY",
            "TREATMENT_SETTING",
          ],
        );
        await withTransaction(pool, async (client) => {
          await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
          await client.query(
            "UPDATE insight.research_cases SET workflow_state='GENERATING_CPTS' WHERE id=$1",
            [researchCaseId],
          );
        });
        const contracts = await getRoutedCptContracts(
          pool,
          { researchCaseId, workflowRevision: 1 },
          artifactRoot,
        );
        const treatment = contracts.find(
          ({ modelHash }) =>
            modelHash === "2208cadaf8938ab1bb82b8f985296f3f75241002b8ca0958ce27a7b89010be91",
        );
        const clozapine = contracts.find(
          ({ modelHash }) =>
            modelHash === "90f633bee7da1625ca4d44d35ace5acace5ca51ee7d597541ee7a5d0089acf3a",
        );
        const clozapineTrs = contracts.find(
          ({ modelHash }) =>
            modelHash === "faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb",
        );
        assert.deepEqual(treatment.requestedOutputNodeRefs, [
          "inpatient_care_priority",
          "inpatient_service_priority",
          "less_restrictive_care_priority",
          "management_recommendation",
        ]);
        assert.equal(treatment.evidence.calibrationStatus, "UNCALIBRATED");
        assert.equal(treatment.evidence.clinicalReviewStatus, "NOT_ESTABLISHED");
        assert.equal(
          treatment.evidence.clinicalReviewReference,
          "docs/reviews/bn-treatment-setting-and-clozapine-pathways.md",
        );
        assert.deepEqual(clozapineTrs.requestedOutputNodeRefs, [
          "TreatmentResistanceStatus",
          "ClozapineEligibility",
          "ClozapinePriority",
          "ClozapineImplementationMode",
          "ECTPriority",
          "TMSPriority",
          "ManagementRecommendation",
        ]);
        assert.equal(clozapineTrs.evidence.clinicalReviewStatus, "NOT_ESTABLISHED");
        assert.match(clozapineTrs.evidence.limitations.join(" "), /not a diagnosis/);
        assert.deepEqual(clozapine.requestedOutputNodeRefs, [
          "Clozapine_Eligibility",
          "Clinical_Action_Pattern",
        ]);
        assert.equal(clozapine.evidence.clinicalReviewStatus, "NOT_ESTABLISHED");
        assert.match(clozapine.evidence.limitations.join(" "), /warning-only/);

        const execution = {
          executionId: randomUUID(),
          jobId: randomUUID(),
          researchCaseId,
          requestedByUserId: psychiatrist.id,
          workflowRevision: 1,
          inputRevision: 1,
          dependencies: {
            canonicalResearchCaseInput: '{"synthetic":true}',
            models: contracts.map(({ modelRef, modelVersion, modelHash }) => ({
              modelRef,
              modelVersion,
              modelHash,
            })),
            promptVersion: "cpt-prompt-1",
            schemaVersion: "cpt-schema-1",
            endpointFingerprint: "e".repeat(64),
            requestedModel: "synthetic-model",
            generationSettings: { temperature: 0 },
            imputationSnapshotRef: null,
          },
        };
        for (const contract of contracts) {
          const parsed = parseXmlBif(
            sources.get(
              routing.selectedModels.find(
                ({ contentSha256 }) => contentSha256 === contract.modelHash,
              ).pathwayIdentity,
            ),
          );
          assert.equal(parsed.ok, true);
          const tables = parsed.file.networks[0].definitions.map((definition) => ({
            nodeRef: definition.for,
            probabilities: definition.table,
          }));
          const snapshot = await submitCptSnapshot(pool, execution, contract, tables);
          const first = await runBnInference(
            pool,
            execution,
            snapshot.snapshotRef,
            contract.requestedOutputNodeRefs,
            artifactRoot,
          );
          assert.deepEqual(
            await runBnInference(
              pool,
              execution,
              snapshot.snapshotRef,
              contract.requestedOutputNodeRefs,
              artifactRoot,
            ),
            first,
          );
          for (const distribution of first.distributions) {
            assert.ok(
              Math.abs(distribution.outcomes.reduce((sum, item) => sum + item.probability, 0) - 1) <
                1e-12,
            );
          }
        }
        assert.equal(
          (await pool.query("SELECT id FROM insight.bn_inference_results")).rowCount,
          contracts.length,
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

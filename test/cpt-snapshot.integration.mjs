import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  McpToolError,
  createOrOverwritePatient,
  createUser,
  ensureCptSnapshots,
  findReusableCptSnapshots,
  getRoutedCptContracts,
  importAndRegisterBnModel,
  routeAndRecordBnModels,
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
const artifact = `<BIF VERSION="0.3"><NETWORK><NAME>PatientCpt</NAME>
  <VARIABLE TYPE="nature"><NAME>Input</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="nature"><NAME>Choice</NAME><OUTCOME>first</OUTCOME><OUTCOME>second</OUTCOME></VARIABLE>
  <DEFINITION><FOR>Input</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
  <DEFINITION><FOR>Choice</FOR><GIVEN>Input</GIVEN><TABLE>0.1 0.9 0.8 0.2</TABLE></DEFINITION>
</NETWORK></BIF>`;
const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};
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

test("CPT attempts and snapshots are immutable, reusable, invalidated, and Research Case scoped", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-cpt-snapshot-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "CptAdministrator",
          password: "cpt-admin-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "CptPsychiatrist",
          password: "cpt-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        await importAndRegisterBnModel(
          pool,
          { id: administrator.id, role: administrator.role },
          {
            candidate: {
              pathwayIdentity: "PHARMACOTHERAPY",
              artifactPath: "patient-cpt.xml",
              version: 1,
            },
            source: artifact,
          },
          { artifactRoot },
        );

        const acceptedCase = await prepareCase(pool, psychiatrist, 961);
        const contracts = await getRoutedCptContracts(
          pool,
          { researchCaseId: acceptedCase, workflowRevision: 1 },
          artifactRoot,
        );
        assert.deepEqual(
          contracts[0].nodes.map((node) => ({
            nodeRef: node.nodeRef,
            outcomes: node.outcomes,
            orderedParentRefs: node.orderedParentRefs,
            requiredTableLength: node.requiredTableLength,
          })),
          [
            {
              nodeRef: "Input",
              outcomes: ["yes", "no"],
              orderedParentRefs: [],
              requiredTableLength: 2,
            },
            {
              nodeRef: "Choice",
              outcomes: ["first", "second"],
              orderedParentRefs: ["Input"],
              requiredTableLength: 4,
            },
          ],
        );
        assert.equal(JSON.stringify(contracts).includes('"table"'), false);
        const execution = makeExecution(acceptedCase, psychiatrist.id, contracts);
        const validTables = [
          { nodeRef: "Input", probabilities: [0.4, 0.6] },
          { nodeRef: "Choice", probabilities: [0.2, 0.8, 0.7, 0.3] },
        ];
        const accepted = await submitCptSnapshot(pool, execution, contracts[0], validTables);
        assert.match(accepted.snapshotRef, /^cpt-snapshot-[0-9a-f]{64}$/);
        assert.deepEqual(accepted.tables, validTables);

        let modelCalls = 0;
        const reused = await ensureCptSnapshots(pool, execution, contracts, async () => {
          modelCalls += 1;
        });
        assert.equal(reused.reused, true);
        assert.equal(modelCalls, 0);
        assert.equal(reused.snapshots[0].snapshotRef, accepted.snapshotRef);
        assert.equal(
          await findReusableCptSnapshots(
            pool,
            {
              ...execution,
              dependencies: { ...execution.dependencies, promptVersion: "cpt-prompt-2" },
            },
            contracts,
          ),
          null,
        );

        const otherCase = await prepareCase(pool, psychiatrist, 962);
        assert.equal(
          await findReusableCptSnapshots(
            pool,
            { ...execution, researchCaseId: otherCase, executionId: randomUUID() },
            contracts,
          ),
          null,
        );

        const failedCase = await prepareCase(pool, psychiatrist, 963);
        const failedContracts = await getRoutedCptContracts(
          pool,
          { researchCaseId: failedCase, workflowRevision: 1 },
          artifactRoot,
        );
        const failedExecution = makeExecution(failedCase, psychiatrist.id, failedContracts);
        const malformed = [
          { nodeRef: "Input", probabilities: [0.2, 0.2] },
          { nodeRef: "Choice", probabilities: [0.2, 0.8, 0.7, 0.3] },
        ];
        for (const expectedRetryable of [true, true, false, false]) {
          await assert.rejects(
            submitCptSnapshot(pool, failedExecution, failedContracts[0], malformed),
            (error) =>
              error instanceof McpToolError &&
              error.code === "CPT_VALIDATION_FAILED" &&
              error.retryable === expectedRetryable,
          );
        }
        const attempts = await pool.query(
          "SELECT id FROM insight.bn_cpt_attempts WHERE execution_id=$1 ORDER BY attempt_number",
          [failedExecution.executionId],
        );
        assert.equal(attempts.rowCount, 3);
        const failed = await pool.query(
          `SELECT provenance->>'code' AS code FROM insight.research_case_domain_results
           WHERE research_case_id=$1 AND result_type='CPT_SNAPSHOT' AND status='FAILED'`,
          [failedCase],
        );
        assert.equal(failed.rows[0].code, "CPT_GENERATION_FAILED");

        const snapshot = await pool.query(
          "SELECT id FROM insight.bn_cpt_snapshots WHERE snapshot_ref=$1",
          [accepted.snapshotRef],
        );
        await assert.rejects(
          pool.query("UPDATE insight.bn_cpt_attempts SET accepted=false WHERE id=$1", [
            attempts.rows[0].id,
          ]),
          /immutable/,
        );
        await assert.rejects(
          pool.query("UPDATE insight.bn_cpt_snapshots SET snapshot_hash=$2 WHERE id=$1", [
            snapshot.rows[0].id,
            "f".repeat(64),
          ]),
          /immutable/,
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

function makeExecution(researchCaseId, requestedByUserId, contracts) {
  return {
    executionId: randomUUID(),
    jobId: randomUUID(),
    researchCaseId,
    requestedByUserId,
    workflowRevision: 1,
    inputRevision: 1,
    dependencies: {
      canonicalResearchCaseInput: '{"same":"deidentified-input"}',
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
}

async function prepareCase(pool, psychiatrist, seed) {
  const synthetic = makeSyntheticPatientIdentity(seed);
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
      lastName: "CptLifecycle",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
  );
  const researchCaseId = created.patient.researchCase.id;
  await routeAndRecordBnModels(
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
          { type: "CSSRS_RECENT", state: "BYPASSED" },
        ],
        comorbidityTermIds: [],
        medicationHistory: [],
        currentRegimen: [],
      },
      artifact: pharmacotherapyOnlyRouting,
    },
  );
  await withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
    await client.query(
      "UPDATE insight.research_cases SET workflow_state='GENERATING_CPTS' WHERE id=$1",
      [researchCaseId],
    );
  });
  return researchCaseId;
}

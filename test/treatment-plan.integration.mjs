import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InternalMcpGateway,
  McpToolError,
  createOrOverwritePatient,
  createTreatmentPlanToolHandlers,
  createUser,
  getPrimaryPlanDraft,
  submitPrimaryPlan,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";
import { makeSyntheticPatientIdentity } from "./support/synthetic-data.mjs";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const ddiRef = `ddi-execution-${"d".repeat(64)}`;
const excludedDdiRef = `ddi-execution-${"e".repeat(64)}`;
const findingRef = `ddi-record-${"a".repeat(64)}-L10`;
const bnRef = "bn-inference-synthetic-1";
const imputationRef = "imputation-synthetic-1";
const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};

test("Primary Treatment Plan validates provenance and persists mutable MCP drafts", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const psychiatrist = await createUser(pool, {
        username: "PlanPsychiatrist",
        password: "plan-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      const researchCaseId = await prepareCase(pool, psychiatrist);
      await insertDdiExecution(pool, researchCaseId, psychiatrist.id, ddiRef, []);
      await insertDdiExecution(pool, researchCaseId, psychiatrist.id, excludedDdiRef, [
        "rx-risperidone",
      ]);
      const valid = JSON.parse(
        await readFile(
          new URL("fixtures/treatment-plan/valid-primary-plan.v1.json", import.meta.url),
          "utf8",
        ),
      );
      const execution = makeExecution(researchCaseId, psychiatrist.id, ddiRef);

      const first = await submitPrimaryPlan(pool, execution, valid);
      assert.equal(first.draftRevision, 1);
      assert.equal(first.aiImputationNoticeVisible, true);
      assert.deepEqual(first.sourceExecutionRefs, [bnRef, ddiRef, imputationRef]);
      assert.equal((await submitPrimaryPlan(pool, execution, valid)).draftRevision, 1);

      const revised = await submitPrimaryPlan(
        pool,
        { ...execution, executionId: randomUUID() },
        { ...valid, explanation: "Revised synthetic explanation." },
      );
      assert.equal(revised.draftRef, first.draftRef);
      assert.equal(revised.draftRevision, 2);
      assert.equal(
        (await getPrimaryPlanDraft(pool, researchCaseId)).plan.explanation,
        revised.plan.explanation,
      );

      await rejectsCode(
        submitPrimaryPlan(
          pool,
          { ...execution, executionId: randomUUID() },
          { ...valid, schemaVersion: "2.0.0" },
        ),
        "PLAN_SCHEMA_INVALID",
      );
      await rejectsCode(
        submitPrimaryPlan(
          pool,
          { ...execution, executionId: randomUUID() },
          {
            ...valid,
            regimen: [{ ...valid.regimen[0], canonicalMedicationId: "rx-not-a-candidate" }],
          },
        ),
        "MEDICATION_CANDIDATE_INVALID",
      );
      await rejectsCode(
        submitPrimaryPlan(pool, makeExecution(researchCaseId, psychiatrist.id, excludedDdiRef), {
          ...valid,
          sourceExecutionRefs: [bnRef, excludedDdiRef, imputationRef],
        }),
        "MEDICATION_CANDIDATE_INVALID",
      );
      await rejectsCode(
        submitPrimaryPlan(
          pool,
          { ...execution, executionId: randomUUID() },
          {
            ...valid,
            regimen: [
              {
                ...valid.regimen[0],
                rationale: [{ ...valid.regimen[0].rationale[0], sourceRef: "unsupported-source" }],
              },
            ],
          },
        ),
        "PROVENANCE_MISMATCH",
      );
      await rejectsCode(
        submitPrimaryPlan(
          pool,
          { ...execution, executionId: randomUUID() },
          {
            ...valid,
            sourceExecutionRefs: [ddiRef],
          },
        ),
        "PROVENANCE_MISMATCH",
      );

      const mcpExecution = { ...execution, executionId: randomUUID() };
      const gateway = new InternalMcpGateway(
        createTreatmentPlanToolHandlers(pool, async () => mcpExecution),
      );
      const result = await gateway.invoke(
        {
          executionId: mcpExecution.executionId,
          jobId: randomUUID(),
          subjectRef: "abcdefghijklmnopqrstuvwx",
          researchCaseRevision: 1,
          workflowState: "GENERATING_PRIMARY_PLAN",
          actorRole: "PSYCHIATRIST",
          allowedToolNames: ["research_case.get_context", "treatment_plan.submit_primary"],
          idempotencyKey: "synthetic-plan-round-trip",
        },
        { name: "treatment_plan.submit_primary", input: valid },
      );
      assert.equal(result.ok, true);
      assert.equal(result.data.draftRevision, 3);
      assert.equal(result.data.aiImputationNoticeVisible, true);
      assert.equal((await getPrimaryPlanDraft(pool, researchCaseId)).draftRevision, 3);
    } finally {
      await pool.end();
    }
  });
});

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof McpToolError && error.code === code);
}

function makeExecution(researchCaseId, requestedByUserId, primaryDdiExecutionRef) {
  return {
    executionId: randomUUID(),
    researchCaseId,
    requestedByUserId,
    workflowRevision: 1,
    inputRevision: 1,
    inputExecutionRefs: [bnRef, primaryDdiExecutionRef, imputationRef],
    primaryDdiExecutionRef,
    imputationSnapshotRef: imputationRef,
  };
}

async function insertDdiExecution(
  pool,
  researchCaseId,
  userId,
  executionRef,
  excludedCanonicalIds,
) {
  await pool.query(
    `INSERT INTO insight.ddi_executions
       (execution_ref,tool_execution_id,research_case_id,requested_by_user_id,purpose,
        workflow_revision,input_revision,exact_regimen,evaluated_pairs,source_versions,
        source_version,unknown_medication_entry_refs,omitted_pair_count,findings,
        excluded_canonical_ids,executed_at)
     VALUES ($1,$2,$3,$4,'PRIMARY_FILTER',1,1,$5,'[]','[]','synthetic-source-set',
             '[]',0,$6,$7,clock_timestamp())`,
    [
      executionRef,
      randomUUID(),
      researchCaseId,
      userId,
      JSON.stringify([
        {
          medicationEntryRef: "proposed-1",
          kind: "PROPOSED",
          normalizationState: "NORMALIZED",
          canonicalId: "rx-risperidone",
        },
      ]),
      JSON.stringify([
        {
          leftCanonicalId: "rx-current",
          rightCanonicalId: "rx-risperidone",
          severity: "synthetic-warning",
          sourceRecordRef: findingRef,
        },
      ]),
      JSON.stringify(excludedCanonicalIds),
    ],
  );
}

async function prepareCase(pool, psychiatrist) {
  const synthetic = makeSyntheticPatientIdentity(971);
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
      lastName: "TreatmentPlan",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    randomUUID(),
  );
  return created.patient.researchCase.id;
}

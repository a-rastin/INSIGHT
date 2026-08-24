import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InternalMcpGateway,
  McpToolError,
  bindFinalDdiExecution,
  createOrOverwritePatient,
  createTreatmentPlanToolHandlers,
  createUser,
  getClinicianReview,
  getPrimaryPlanDraft,
  regimenFingerprint,
  saveClinicianRegimen,
  saveMedicationCatalog,
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
      const administrator = await createUser(pool, {
        username: "PlanAdministrator",
        password: "plan-administrator-password",
        role: "ADMINISTRATOR",
      });
      const psychiatrist = await createUser(pool, {
        username: "PlanPsychiatrist",
        password: "plan-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      await saveMedicationCatalog(pool, administrator, {
        entries: [
          { canonicalId: "rx-risperidone", preferredName: "Risperidone", synonyms: [] },
          { canonicalId: "rx-clozapine", preferredName: "Clozapine", synonyms: [] },
          { canonicalId: "rx-olanzapine", preferredName: "Olanzapine", synonyms: [] },
        ],
      });
      const { researchCaseId, patientId } = await prepareCase(pool, psychiatrist);
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

      const actor = { id: psychiatrist.id, role: psychiatrist.role };
      const generated = clinicianMedication(valid.regimen[0]);
      const firstReview = await saveClinicianRegimen(pool, actor, patientId, [generated]);
      assert.equal(firstReview.readiness.status, "CHECKING");
      assert.deepEqual(firstReview.diff, []);
      assert.equal(await recheckCount(pool, researchCaseId), 1);

      await saveClinicianRegimen(pool, actor, patientId, [generated]);
      assert.equal(await recheckCount(pool, researchCaseId), 1, "unchanged regimen reuses check");

      const clozapine = { ...generated, canonicalMedicationId: "rx-clozapine" };
      const olanzapine = { ...generated, canonicalMedicationId: "rx-olanzapine" };
      await Promise.all([
        saveClinicianRegimen(pool, actor, patientId, [clozapine]),
        saveClinicianRegimen(pool, actor, patientId, [olanzapine]),
      ]);
      const latest = await getClinicianReview(pool, actor, patientId);
      assert.equal(latest.diff.length, 1);
      assert.equal(await recheckCount(pool, researchCaseId), 3);

      const rechecks = await pool.query(
        `SELECT job_id,regimen_fingerprint,exact_regimen FROM insight.final_ddi_rechecks
         WHERE research_case_id=$1 ORDER BY created_at,id`,
        [researchCaseId],
      );
      const currentFingerprint = latestRegimenFingerprint(latest);
      const current = rechecks.rows.find(
        ({ regimen_fingerprint }) => regimen_fingerprint === currentFingerprint,
      );
      const stale = rechecks.rows.find(
        ({ regimen_fingerprint }) => regimen_fingerprint !== currentFingerprint,
      );
      assert.ok(current && stale);
      const staleRef = `ddi-execution-${"1".repeat(64)}`;
      await insertFinalDdiExecution(
        pool,
        researchCaseId,
        psychiatrist.id,
        staleRef,
        stale.exact_regimen,
        [],
      );
      assert.equal(await bindFinalDdiExecution(pool, stale.job_id, staleRef), false);
      assert.equal((await getClinicianReview(pool, actor, patientId)).readiness.status, "CHECKING");

      const currentRef = `ddi-execution-${"2".repeat(64)}`;
      await insertFinalDdiExecution(
        pool,
        researchCaseId,
        psychiatrist.id,
        currentRef,
        current.exact_regimen,
        [
          {
            leftCanonicalId: "rx-current",
            rightCanonicalId: latest.regimen[0].canonicalMedicationId,
            severity: "contraindicated",
            sourceRecordRef: findingRef,
          },
        ],
      );
      assert.equal(await bindFinalDdiExecution(pool, current.job_id, currentRef), true);
      const ready = await getClinicianReview(pool, actor, patientId);
      assert.equal(ready.readiness.status, "READY", "successful findings are warning-only");
      assert.equal(ready.readiness.findings.length, 1);

      const changed =
        latest.regimen[0].canonicalMedicationId === "rx-clozapine" ? olanzapine : clozapine;
      const pending = await saveClinicianRegimen(pool, actor, patientId, [changed]);
      assert.equal(pending.readiness.status, "CHECKING");
      await pool.query(
        `UPDATE insight.jobs SET status='FAILED',attempt_count=max_attempts,
           error_code='ATTEMPTS_EXHAUSTED',error_message='Job attempts were exhausted.',
           completed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=(SELECT job_id FROM insight.final_ddi_rechecks
           WHERE research_case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)`,
        [researchCaseId],
      );
      assert.deepEqual((await getClinicianReview(pool, actor, patientId)).readiness, {
        status: "BLOCKED",
        reason: "FAILED",
        executionRef: null,
        findings: [],
      });
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

async function insertFinalDdiExecution(
  pool,
  researchCaseId,
  userId,
  executionRef,
  exactRegimen,
  findings,
) {
  await pool.query(
    `INSERT INTO insight.ddi_executions
       (execution_ref,tool_execution_id,research_case_id,requested_by_user_id,purpose,
        workflow_revision,input_revision,exact_regimen,evaluated_pairs,source_versions,
        source_version,unknown_medication_entry_refs,omitted_pair_count,findings,
        excluded_canonical_ids,executed_at)
     VALUES ($1,$2,$3,$4,'FINAL_RECHECK',1,1,$5,'[]','[]','synthetic-source-set',
             '[]',0,$6,'[]',clock_timestamp())`,
    [
      executionRef,
      randomUUID(),
      researchCaseId,
      userId,
      JSON.stringify(exactRegimen),
      JSON.stringify(findings),
    ],
  );
}

function clinicianMedication(medication) {
  return {
    canonicalMedicationId: medication.canonicalMedicationId,
    dose: medication.dose,
    route: medication.route,
    frequency: medication.frequency,
    ...(medication.titration ? { titration: medication.titration } : {}),
    monitoring: medication.monitoring,
  };
}

function latestRegimenFingerprint(review) {
  return regimenFingerprint(
    review.regimen.map((medication, index) => ({
      medicationEntryRef: `final-${index + 1}`,
      kind: "PROPOSED",
      normalizationState: "NORMALIZED",
      canonicalId: medication.canonicalMedicationId,
      regimenDetails: {
        dose: medication.dose,
        route: medication.route,
        frequency: medication.frequency,
        titration: medication.titration ?? null,
        monitoring: medication.monitoring,
      },
    })),
  );
}

async function recheckCount(pool, researchCaseId) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM insight.final_ddi_rechecks WHERE research_case_id=$1",
    [researchCaseId],
  );
  return result.rows[0].count;
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
  return { researchCaseId: created.patient.researchCase.id, patientId: created.patient.id };
}

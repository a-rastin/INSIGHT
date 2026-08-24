import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FinalPlanAuthorizationError,
  FinalPlanConflictError,
  FinalPlanDependencyError,
  FinalPlanSchemaError,
  WorkflowTransitionError,
  bindFinalDdiExecution,
  createOrOverwritePatient,
  createUser,
  finalizeTreatmentPlan,
  saveClinicianRegimen,
  saveMedicationCatalog,
  submitPrimaryPlan,
  transitionResearchCase,
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

test("Final Treatment Plan finalization is transactional, idempotent, and immutable", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const administrator = await createUser(pool, {
        username: "FinalPlanAdministrator",
        password: "final-plan-administrator-password",
        role: "ADMINISTRATOR",
      });
      const psychiatrist = await createUser(pool, {
        username: "FinalPlanPsychiatrist",
        password: "final-plan-psychiatrist-password",
        role: "PSYCHIATRIST",
      });
      await saveMedicationCatalog(pool, administrator, {
        entries: [{ canonicalId: "rx-risperidone", preferredName: "Risperidone", synonyms: [] }],
      });
      const actor = { id: psychiatrist.id, role: psychiatrist.role };

      const sameKeyCase = await seedReadyCase(pool, actor, 981);
      await assert.rejects(
        transitionResearchCase(
          pool,
          actor,
          sameKeyCase.patientId,
          "FINALIZE",
          11,
          randomUUID(),
        ),
        WorkflowTransitionError,
      );
      await assert.rejects(
        finalizeTreatmentPlan(
          pool,
          { id: administrator.id, role: administrator.role },
          sameKeyCase.patientId,
          "same-key",
          randomUUID(),
        ),
        FinalPlanAuthorizationError,
      );
      const sameKey = await Promise.all([
        finalizeTreatmentPlan(pool, actor, sameKeyCase.patientId, "same-key", randomUUID()),
        finalizeTreatmentPlan(pool, actor, sameKeyCase.patientId, "same-key", randomUUID()),
      ]);
      assert.equal(sameKey[0].id, sameKey[1].id);
      assert.equal(sameKey[0].status, "ACTIVE");
      assert.equal(sameKey[0].finalizedByUserId, psychiatrist.id);
      assert.equal("aiImputationNoticeVisible" in sameKey[0].plan, false);
      assert.equal(sameKey[0].provenance.finalDdi.findings.length, 1);
      assert.equal(
        sameKey[0].provenance.assessments.detail[2].calculation_result.band,
        "HIGH",
        "completed high C-SSRS is warning-only",
      );
      assert.equal(await versionCount(pool, sameKeyCase.researchCaseId), 1);
      assert.equal(await workflowState(pool, sameKeyCase.researchCaseId), "FINALIZED");

      await assert.rejects(
        pool.query("UPDATE insight.final_plan_versions SET plan_snapshot='{}' WHERE id=$1", [
          sameKey[0].id,
        ]),
        /immutable/,
      );
      await assert.rejects(
        pool.query("DELETE FROM insight.final_plan_versions WHERE id=$1", [sameKey[0].id]),
        /immutable/,
      );

      const raceCase = await seedReadyCase(pool, actor, 982);
      const race = await Promise.allSettled([
        finalizeTreatmentPlan(pool, actor, raceCase.patientId, "race-a", randomUUID()),
        finalizeTreatmentPlan(pool, actor, raceCase.patientId, "race-b", randomUUID()),
      ]);
      assert.equal(race.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(race.filter(({ status }) => status === "rejected").length, 1);
      assert.ok(
        race.find(({ status }) => status === "rejected").reason instanceof FinalPlanConflictError,
      );
      assert.equal(await versionCount(pool, raceCase.researchCaseId), 1);

      const failedCase = await seedReadyCase(pool, actor, 983, { finalDdiStatus: "FAILED" });
      await assert.rejects(
        finalizeTreatmentPlan(pool, actor, failedCase.patientId, "failed-service", randomUUID()),
        FinalPlanDependencyError,
      );
      assert.equal(await versionCount(pool, failedCase.researchCaseId), 0);
      assert.equal(await workflowState(pool, failedCase.researchCaseId), "READY_TO_FINALIZE");

      const invalidCase = await seedReadyCase(pool, actor, 984);
      await corruptDraft(pool, invalidCase.researchCaseId);
      await assert.rejects(
        finalizeTreatmentPlan(pool, actor, invalidCase.patientId, "invalid-schema", randomUUID()),
        FinalPlanSchemaError,
      );
    } finally {
      await pool.end();
    }
  });
});

async function seedReadyCase(pool, actor, sequence, options = {}) {
  const synthetic = makeSyntheticPatientIdentity(sequence);
  const created = await createOrOverwritePatient(
    pool,
    actor,
    {
      officialIdentifier: {
        type: identifierConfiguration.type,
        issuingAuthority: identifierConfiguration.issuingAuthority,
        value: synthetic.officialIdentifier,
      },
      firstName: synthetic.firstName,
      lastName: "FinalPlan",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    randomUUID(),
  );
  const patientId = created.patient.id;
  const researchCaseId = created.patient.researchCase.id;
  const primaryDdiRef = ddiRef();
  await insertDdi(
    pool,
    researchCaseId,
    actor.id,
    primaryDdiRef,
    "PRIMARY_FILTER",
    proposedRegimen(),
    [
      {
        leftCanonicalId: "rx-current",
        rightCanonicalId: "rx-risperidone",
        severity: "warning",
        sourceRecordRef: `ddi-record-${"a".repeat(64)}-L10`,
      },
    ],
  );
  const plan = JSON.parse(
    await readFile(
      new URL("fixtures/treatment-plan/valid-primary-plan.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const bnRef = "bn-inference-synthetic-1";
  const imputationRef = "imputation-synthetic-1";
  await submitPrimaryPlan(
    pool,
    {
      executionId: randomUUID(),
      researchCaseId,
      requestedByUserId: actor.id,
      workflowRevision: 1,
      inputRevision: 1,
      inputExecutionRefs: [bnRef, primaryDdiRef, imputationRef],
      primaryDdiExecutionRef: primaryDdiRef,
      imputationSnapshotRef: imputationRef,
    },
    { ...plan, sourceExecutionRefs: [bnRef, primaryDdiRef, imputationRef] },
  );
  const regimen = plan.regimen.map(
    ({ canonicalMedicationId, dose, route, frequency, titration, monitoring }) => ({
      canonicalMedicationId,
      dose,
      route,
      frequency,
      ...(titration ? { titration } : {}),
      monitoring,
    }),
  );
  await saveClinicianRegimen(pool, actor, patientId, regimen);
  const recheck = (
    await pool.query(
      `SELECT job_id,exact_regimen FROM insight.final_ddi_rechecks
       WHERE research_case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [researchCaseId],
    )
  ).rows[0];
  const finalDdiRef = ddiRef();
  await insertDdi(
    pool,
    researchCaseId,
    actor.id,
    finalDdiRef,
    "FINAL_RECHECK",
    recheck.exact_regimen,
    [
      {
        leftCanonicalId: "rx-current",
        rightCanonicalId: "rx-risperidone",
        severity: "contraindicated",
        sourceRecordRef: `ddi-record-${randomBytes(32).toString("hex")}`,
      },
    ],
  );
  await bindFinalDdiExecution(pool, recheck.job_id, finalDdiRef);
  await seedAssessmentProvenance(pool, researchCaseId, actor.id);
  await seedReadyState(
    pool,
    researchCaseId,
    actor.id,
    finalDdiRef,
    options.finalDdiStatus ?? "SUCCEEDED",
  );
  return { patientId, researchCaseId };
}

async function seedReadyState(pool, researchCaseId, userId, finalDdiRef, finalDdiStatus) {
  const types = [
    "DATA_COLLECTION_VALIDATED",
    "MEDICATION_NORMALIZATION",
    "BN_ROUTING",
    "CPT_SNAPSHOT",
    "BN_INFERENCE",
    "PRIMARY_DDI",
    "PRIMARY_PLAN",
    "FINAL_DDI",
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
    for (const type of types) {
      await client.query(
        `INSERT INTO insight.research_case_domain_results
           (research_case_id,result_type,status,workflow_revision,input_revision,
            result_reference,provenance,recorded_by_user_id)
         VALUES ($1,$2,$3,1,1,$4,$5,$6)`,
        [
          researchCaseId,
          type,
          type === "FINAL_DDI" ? finalDdiStatus : "SUCCEEDED",
          type === "FINAL_DDI" ? finalDdiRef : `${type.toLowerCase()}-${randomUUID()}`,
          { accepted: true, source: "SYNTHETIC_TEST", modelVersion: "test-1" },
          userId,
        ],
      );
    }
    await client.query(
      `UPDATE insight.research_cases SET workflow_state='READY_TO_FINALIZE',workflow_revision=11
       WHERE id=$1`,
      [researchCaseId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedAssessmentProvenance(pool, researchCaseId, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('insight.dsm5tr_write','allowed',true)");
    await client.query("SELECT set_config('insight.panss_write','allowed',true)");
    await client.query("SELECT set_config('insight.cssrs_write','allowed',true)");
    await client.query(
      `INSERT INTO insight.dsm5tr_assessments
         (research_case_id,status,instrument_id,instrument_version,schema_version,
          source_reference,review_reference,created_by_user_id,updated_by_user_id)
       VALUES ($1,'BYPASSED','DSM5TR_SCHIZOPHRENIA','DSM-5-TR-2022','1.0.0',
         'synthetic-source','synthetic-review',$2,$2)`,
      [researchCaseId, userId],
    );
    await client.query(
      `INSERT INTO insight.panss_assessments
         (research_case_id,status,instrument_id,instrument_version,schema_version,
          source_reference,review_reference,created_by_user_id,updated_by_user_id)
       VALUES ($1,'BYPASSED','PANSS_30','KAY-OPLER-FISZBEIN-1987','1.0.0',
         'synthetic-source','synthetic-review',$2,$2)`,
      [researchCaseId, userId],
    );
    await client.query(
      `INSERT INTO insight.cssrs_recent_assessments
         (research_case_id,status,answers,calculation_result,instrument_id,instrument_version,
          schema_version,calculation_version,source_reference,source_sha256,review_reference,
          research_activation_status,created_by_user_id,updated_by_user_id)
       VALUES ($1,'COMPLETED','{}','{"status":"COMPLETE","band":"HIGH"}',
         'C_SSRS_SCREEN_RECENT',
         'LOCAL-PDF-SHA256-8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2',
         '1.0.0','1.0.0','medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf',
         '8593cdd34b0a69027354db43f8551e622879e0fd04bcf0a875a4a15b676a84a2',
         'CSSRS-CLINICAL-REVIEW-2026-08-22-PENDING','INACTIVE',$2,$2)`,
      [researchCaseId, userId],
    );
    await client.query(
      `UPDATE insight.research_case_assessments SET status=CASE assessment_type
         WHEN 'CSSRS_RECENT' THEN 'COMPLETED'::insight.assessment_status
         ELSE 'BYPASSED'::insight.assessment_status END,updated_by_user_id=$2
       WHERE research_case_id=$1`,
      [researchCaseId, userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertDdi(
  pool,
  researchCaseId,
  userId,
  executionRef,
  purpose,
  exactRegimen,
  findings,
) {
  await pool.query(
    `INSERT INTO insight.ddi_executions
       (execution_ref,tool_execution_id,research_case_id,requested_by_user_id,purpose,
        workflow_revision,input_revision,exact_regimen,evaluated_pairs,source_versions,
        source_version,unknown_medication_entry_refs,omitted_pair_count,findings,
        excluded_canonical_ids,executed_at)
     VALUES ($1,$2,$3,$4,$5,1,1,$6,'[]','[]','synthetic-source-set','[]',0,$7,'[]',clock_timestamp())`,
    [
      executionRef,
      randomUUID(),
      researchCaseId,
      userId,
      purpose,
      JSON.stringify(exactRegimen),
      JSON.stringify(findings),
    ],
  );
}

const proposedRegimen = () => [
  {
    medicationEntryRef: "proposed-1",
    kind: "PROPOSED",
    normalizationState: "NORMALIZED",
    canonicalId: "rx-risperidone",
  },
];

const ddiRef = () => `ddi-execution-${randomBytes(32).toString("hex")}`;

async function versionCount(pool, researchCaseId) {
  return (
    await pool.query(
      "SELECT count(*)::integer AS count FROM insight.final_plan_versions WHERE research_case_id=$1",
      [researchCaseId],
    )
  ).rows[0].count;
}

async function workflowState(pool, researchCaseId) {
  return (
    await pool.query("SELECT workflow_state FROM insight.research_cases WHERE id=$1", [
      researchCaseId,
    ])
  ).rows[0].workflow_state;
}

async function corruptDraft(pool, researchCaseId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
    await client.query(
      "UPDATE insight.primary_treatment_plan_drafts SET plan_payload='{}' WHERE research_case_id=$1",
      [researchCaseId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

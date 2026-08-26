import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildApp,
  bindFinalDdiExecution,
  claimNextJob,
  createOrchestrationJobHandler,
  createOrOverwritePatient,
  createUser,
  finalizeTreatmentPlan,
  getDeploymentGateStatus,
  invalidateResearchCaseInputs,
  listPatientAuditEvents,
  listResearchCaseTransitionAuditEvents,
  recordDomainResult,
  releaseJobAfterFailure,
  saveClinicianRegimen,
  saveMedicationCatalog,
  settleJobFromDomainResult,
  startResearchCaseOrchestration,
  submitPrimaryPlan,
  transitionResearchCase,
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
const stageResultTypes = {
  DATA_COLLECTION: "DATA_COLLECTION_VALIDATED",
  NORMALIZING_MEDICATIONS: "MEDICATION_NORMALIZATION",
  IMPUTING_BYPASSED_ASSESSMENTS: "ASSESSMENT_IMPUTATION",
  ROUTING_BN: "BN_ROUTING",
  GENERATING_CPTS: "CPT_SNAPSHOT",
  RUNNING_BN: "BN_INFERENCE",
  CHECKING_PRIMARY_DDI: "PRIMARY_DDI",
  GENERATING_PRIMARY_PLAN: "PRIMARY_PLAN",
};
const refs = {
  imputation: "imputation-synthetic-1",
  inference: "bn-inference-synthetic-1",
  primaryDdi: `ddi-execution-${"d".repeat(64)}`,
};

test("complete governed synthetic vertical slice", async (suite) => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL must target PostgreSQL 16.");
  const governance = JSON.parse(
    await readFile(new URL("fixtures/vertical-slice/governance.v1.json", import.meta.url), "utf8"),
  );
  const primaryPlan = JSON.parse(
    await readFile(
      new URL("fixtures/treatment-plan/valid-primary-plan.v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      scope: governance.scope,
      syntheticDataOnly: governance.syntheticDataOnly,
      productionActivationPermitted: governance.productionActivationPermitted,
      externalInputsPresent: governance.externalInputsPresent,
    },
    {
      scope: "TEST_ONLY",
      syntheticDataOnly: true,
      productionActivationPermitted: false,
      externalInputsPresent: false,
    },
  );

  await withFixtureModel(async (modelBaseUrl) =>
    withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString, maxConnections: 8 });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "VerticalAdministrator",
          password: "vertical-administrator-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "VerticalPsychiatrist",
          password: "vertical-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        const actor = { id: psychiatrist.id, role: psychiatrist.role };
        const app = buildApp({
          authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
          patient: { officialIdentifier: identifierConfiguration },
        });

        try {
          const session = await login(app, psychiatrist.username, "vertical-psychiatrist-password");
          assert.equal((await getDeploymentGateStatus(pool)).identifiedMode, "DISABLED");
          const createdResponse = await app.inject({
            method: "POST",
            url: "/api/v1/patients",
            headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
            payload: patientInput(makeSyntheticPatientIdentity(901)),
          });
          assert.equal(createdResponse.statusCode, 201);

          await saveMedicationCatalog(pool, administrator, governance.medicationCatalog);
          const created = createdResponse.json();
          const patientId = created.patient.id;
          const researchCaseId = created.patient.researchCase.id;
          await saveInputs(app, session, patientId);

          await suite.test("malformed model output is rejected without advancing", async () => {
            await assert.rejects(
              requestFixtureModel(modelBaseUrl, "MALFORMED"),
              /malformed model output/,
            );
            assert.equal(await workflowState(pool, researchCaseId), "DATA_COLLECTION");
          });
          await suite.test("unavailable dependency is explicit and has no fallback", async () => {
            await assert.rejects(
              requestFixtureModel(modelBaseUrl, "UNAVAILABLE"),
              /unavailable dependency/,
            );
            assert.equal(await workflowState(pool, researchCaseId), "DATA_COLLECTION");
          });

          const endpoint = productionShapedStageExecutor({
            pool,
            actor,
            patientId,
            modelBaseUrl,
            governance,
            primaryPlan,
            failOnceAt: "GENERATING_CPTS",
          });
          const first = await startResearchCaseOrchestration(
            pool,
            actor,
            patientId,
            "slice-success",
          );
          const duplicate = await startResearchCaseOrchestration(
            pool,
            actor,
            patientId,
            "slice-success",
          );
          assert.equal(duplicate.id, first.id, "duplicate command returns original durable job");

          const beforeRestart = await claimNextJob(pool, "vertical-worker-before-restart");
          const handler = createOrchestrationJobHandler(pool, endpoint);
          await assert.rejects(
            handler.execute(beforeRestart, async () => undefined),
            /restart fixture/,
          );
          await releaseJobAfterFailure(pool, beforeRestart);
          const afterRestart = await claimNextJob(pool, "vertical-worker-after-restart");
          assert.equal(afterRestart.job.id, first.id);
          await handler.execute(afterRestart, async () => undefined);
          await settleJobFromDomainResult(pool, afterRestart, handler.resolveDomainResult);
          assert.equal(await workflowState(pool, researchCaseId), "CLINICIAN_REVIEW");
          assert.equal(endpoint.calls.filter((state) => state === "GENERATING_CPTS").length, 2);

          const generated = primaryPlan.regimen.map(toClinicianMedication);
          const edited = [{ ...generated[0], dose: { value: 3, unit: "mg" } }];
          const review = await saveClinicianRegimen(pool, actor, patientId, edited);
          assert.equal(review.diff.length, 1);
          assert.equal(review.readiness.status, "CHECKING");
          const recheck = (
            await pool.query(
              `SELECT job_id,exact_regimen FROM insight.final_ddi_rechecks
               WHERE research_case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
              [researchCaseId],
            )
          ).rows[0];
          const beforeRecheck = await workflowPosition(pool, researchCaseId);
          const rechecking = await transitionResearchCase(
            pool,
            actor,
            patientId,
            "REQUEST_FINAL_DDI_RECHECK",
            beforeRecheck.revision,
            randomUUID(),
          );
          assert.equal(rechecking.state, "RECHECKING_FINAL_DDI");
          const finalClaim = await claimNextJob(pool, "vertical-worker-final-ddi");
          assert.equal(finalClaim.job.id, recheck.job_id);
          const finalDdiRef = `ddi-execution-${randomBytes(32).toString("hex")}`;
          await insertDdi(pool, {
            executionRef: finalDdiRef,
            toolExecutionId: recheck.job_id,
            researchCaseId,
            userId: actor.id,
            purpose: "FINAL_RECHECK",
            revision: rechecking.revision,
            inputRevision: beforeRecheck.inputRevision,
            exactRegimen: recheck.exact_regimen,
            findings: [],
          });
          assert.equal(await bindFinalDdiExecution(pool, recheck.job_id, finalDdiRef), true);
          await settleJobFromDomainResult(pool, finalClaim, async () => ({
            status: "SUCCEEDED",
            resultReference: finalDdiRef,
            provenanceReference: finalDdiRef,
          }));
          await recordDomainResult(pool, actor, patientId, {
            type: "FINAL_DDI",
            status: "SUCCEEDED",
            resultReference: finalDdiRef,
            provenance: fixtureProvenance(governance.ddi.approvalRef, {
              purpose: "FINAL_RECHECK",
              executionRef: finalDdiRef,
            }),
            expectedRevision: rechecking.revision,
          });
          await transitionResearchCase(
            pool,
            actor,
            patientId,
            "COMPLETE_FINAL_DDI",
            rechecking.revision,
            randomUUID(),
          );

          const finalized = await Promise.all([
            finalizeTreatmentPlan(pool, actor, patientId, "slice-final", randomUUID()),
            finalizeTreatmentPlan(pool, actor, patientId, "slice-final", randomUUID()),
          ]);
          assert.equal(finalized[0].id, finalized[1].id);
          assert.equal(finalized[0].status, "ACTIVE");
          assert.equal(finalized[0].provenance.assessments.states.length, 3);
          const finalResults = new Map(
            finalized[0].provenance.domainResults.map((result) => [result.result_type, result]),
          );
          assert.equal(
            finalResults.get("BN_ROUTING").provenance.pathwayIdentity,
            "PHARMACOTHERAPY",
          );
          assert.deepEqual(finalResults.get("CPT_SNAPSHOT").provenance.tables, governance.bn.cpt);
          assert.deepEqual(
            finalResults.get("BN_INFERENCE").provenance.inference,
            governance.bn.inference,
          );
          assert.equal(finalResults.get("ASSESSMENT_IMPUTATION").result_reference, refs.imputation);
          assert.equal(finalized[0].provenance.sourceDraft.revision, 2);

          const transitions = await listResearchCaseTransitionAuditEvents(pool, actor, patientId);
          assert.equal(transitions.at(-1).command, "FINALIZE");
          assert.ok(transitions.every((event) => event.actorUserId === actor.id));
          assert.ok((await listPatientAuditEvents(pool, actor, patientId)).length >= 1);

          await suite.test("stale input cancels queued orchestration", async () => {
            const stale = await seedMinimalReadyCase(pool, actor, 902);
            const job = await startResearchCaseOrchestration(
              pool,
              actor,
              stale.patientId,
              "slice-stale",
            );
            await invalidateResearchCaseInputs(
              pool,
              actor,
              stale.patientId,
              1,
              "Synthetic stale-input scenario.",
              randomUUID(),
            );
            const claim = await claimNextJob(pool, "vertical-worker-stale");
            assert.equal(claim.job.id, job.id);
            await assert.rejects(
              createOrchestrationJobHandler(pool, endpoint).execute(claim, async () => undefined),
            );
            assert.equal(
              (await pool.query("SELECT status FROM insight.jobs WHERE id=$1", [job.id])).rows[0]
                .status,
              "CANCELLED",
            );
          });
        } finally {
          await app.close();
        }
      } finally {
        await pool.end();
      }
    }),
  );
});

function productionShapedStageExecutor(options) {
  const calls = [];
  let failed = false;
  const execute = async (context) => {
    calls.push(context.workflowState);
    if (context.workflowState === options.failOnceAt && !failed) {
      failed = true;
      throw new Error("restart fixture");
    }
    const model = await requestFixtureModel(options.modelBaseUrl, context.workflowState);
    let resultReference = `fixture-${context.workflowState.toLowerCase()}-${context.workflowRevision}`;
    let details = model;
    if (context.workflowState === "NORMALIZING_MEDICATIONS") {
      await withTransaction(options.pool, async (client) => {
        await client.query("SELECT set_config('insight.medical_history_write','allowed',true)");
        await client.query(
          `UPDATE insight.current_medication_entries
           SET normalization_state='NORMALIZED',canonical_medication_id='rx-metformin'
           WHERE research_case_id=$1 AND position=0`,
          [context.researchCaseId],
        );
      });
      details = { ...model, catalogApprovalRef: options.governance.medicationCatalog.approvalRef };
    } else if (context.workflowState === "IMPUTING_BYPASSED_ASSESSMENTS") {
      resultReference = refs.imputation;
      details = { ...model, assessmentType: "PANSS", sourceStatus: "BYPASSED" };
    } else if (context.workflowState === "ROUTING_BN") {
      details = {
        ...model,
        pathwayIdentity: options.governance.bn.pathwayIdentity,
        modelRef: options.governance.bn.modelRef,
        approvalRef: options.governance.bn.approvalRef,
      };
    } else if (context.workflowState === "GENERATING_CPTS") {
      details = {
        ...model,
        modelRef: options.governance.bn.modelRef,
        tables: options.governance.bn.cpt,
      };
    } else if (context.workflowState === "RUNNING_BN") {
      resultReference = refs.inference;
      details = { ...model, inference: options.governance.bn.inference };
    } else if (context.workflowState === "CHECKING_PRIMARY_DDI") {
      resultReference = refs.primaryDdi;
      const finding = {
        leftCanonicalId: "rx-metformin",
        rightCanonicalId: "rx-risperidone",
        severity: "test-only-warning",
        sourceRecordRef: options.governance.ddi.findingRef,
      };
      await insertDdi(options.pool, {
        executionRef: resultReference,
        toolExecutionId: context.runId,
        researchCaseId: context.researchCaseId,
        userId: context.requestedByUserId,
        purpose: "PRIMARY_FILTER",
        revision: context.workflowRevision,
        inputRevision: context.inputRevision,
        exactRegimen: [
          {
            medicationEntryRef: "proposed-1",
            kind: "PROPOSED",
            normalizationState: "NORMALIZED",
            canonicalId: "rx-risperidone",
          },
        ],
        findings: [finding],
      });
      details = { ...model, sourceRef: options.governance.ddi.sourceRef, findings: [finding] };
    } else if (context.workflowState === "GENERATING_PRIMARY_PLAN") {
      const primaryDdi = (
        await options.pool.query(
          "SELECT research_case_id,input_revision,purpose FROM insight.ddi_executions WHERE execution_ref=$1",
          [refs.primaryDdi],
        )
      ).rows[0];
      assert.deepEqual(primaryDdi, {
        research_case_id: context.researchCaseId,
        input_revision: String(context.inputRevision),
        purpose: "PRIMARY_FILTER",
      });
      assert.ok(options.primaryPlan.sourceExecutionRefs.includes(refs.primaryDdi));
      const planExecution = {
        executionId: context.runId,
        researchCaseId: context.researchCaseId,
        requestedByUserId: context.requestedByUserId,
        workflowRevision: context.workflowRevision,
        inputRevision: context.inputRevision,
        inputExecutionRefs: [refs.inference, refs.primaryDdi, refs.imputation],
        primaryDdiExecutionRef: refs.primaryDdi,
        imputationSnapshotRef: refs.imputation,
      };
      const plan = {
        ...options.primaryPlan,
        sourceExecutionRefs: planExecution.inputExecutionRefs,
      };
      const draft = await submitPrimaryPlan(options.pool, planExecution, plan);
      resultReference = draft.draftRef;
      details = { ...model, draftRef: draft.draftRef };
    }
    return {
      status: "SUCCEEDED",
      resultType: stageResultTypes[context.workflowState],
      resultReference,
      provenance: {
        ...fixtureProvenance("VERTICAL-SLICE-TEST-001", details),
        researchCaseRevision: context.workflowRevision,
        inputRevision: context.inputRevision,
        dependencyFingerprint: context.dependencyFingerprint,
        dependencyManifest: context.dependencyManifest,
      },
    };
  };
  execute.calls = calls;
  return execute;
}

async function saveInputs(app, session, patientId) {
  const headers = { cookie: session.cookie, "x-csrf-token": session.csrfToken };
  const dsm = await app.inject({
    method: "PUT",
    url: `/api/v1/patients/${patientId}/research-case/dsm5tr`,
    headers,
    payload: {
      schemaVersion: "1",
      mode: "COMPLETE",
      expectedRevision: 1,
      answers: {
        criterionA: {
          delusions: true,
          hallucinations: true,
          disorganizedSpeech: false,
          disorganizedOrCatatonicBehavior: false,
          negativeSymptoms: false,
        },
        criterionBFunctionalDecline: true,
        criterionCDuration: true,
        criterionDMoodDisorderExclusion: true,
        criterionESubstanceOrMedicalExclusion: true,
        criterionFDevelopmentalHistory: false,
      },
      psychiatristDecision: "SCHIZOPHRENIA_CONFIRMED",
    },
  });
  assert.equal(dsm.statusCode, 200);
  const panss = await app.inject({
    method: "PUT",
    url: `/api/v1/patients/${patientId}/research-case/panss`,
    headers,
    payload: { schemaVersion: "1", mode: "BYPASS", expectedRevision: 1 },
  });
  assert.equal(panss.statusCode, 200);
  const cssrs = await app.inject({
    method: "PUT",
    url: `/api/v1/patients/${patientId}/research-case/cssrs-recent`,
    headers,
    payload: {
      schemaVersion: "1",
      mode: "COMPLETE",
      expectedRevision: 1,
      answers: { q1WishDead: false, q2SuicidalThoughts: false, q6Behavior: false },
    },
  });
  assert.equal(cssrs.statusCode, 200);
  assert.equal(cssrs.json().assessment.activationGate.status, "INACTIVE");
  const history = await app.inject({
    method: "PUT",
    url: `/api/v1/patients/${patientId}/research-case/medical-history`,
    headers,
    payload: {
      schemaVersion: "1",
      expectedRevision: 1,
      history: {
        presentationStatus: "FIRST_PRESENTATION",
        currentMedications: [{ rawMedication: "metformin" }],
        comorbidities: [],
        supplementalNotes: "Synthetic vertical-slice history.",
      },
    },
  });
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(
    [dsm, panss, cssrs].map((response) => response.json().assessment.status),
    ["COMPLETED", "BYPASSED", "COMPLETED"],
  );
}

async function seedMinimalReadyCase(pool, actor, sequence) {
  const created = await createOrOverwritePatient(
    pool,
    actor,
    patientInput(makeSyntheticPatientIdentity(sequence)),
    identifierConfiguration,
    randomUUID(),
  );
  await withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('insight.dsm5tr_write','allowed',true)");
    await client.query("SELECT set_config('insight.panss_write','allowed',true)");
    await client.query("SELECT set_config('insight.cssrs_write','allowed',true)");
    await client.query(
      `UPDATE insight.research_case_assessments SET status='COMPLETED',updated_by_user_id=$2
       WHERE research_case_id=$1`,
      [created.patient.researchCase.id, actor.id],
    );
  });
  return { patientId: created.patient.id, researchCaseId: created.patient.researchCase.id };
}

async function insertDdi(pool, input) {
  await pool.query(
    `INSERT INTO insight.ddi_executions
       (execution_ref,tool_execution_id,research_case_id,requested_by_user_id,purpose,
        workflow_revision,input_revision,exact_regimen,evaluated_pairs,source_versions,
        source_version,unknown_medication_entry_refs,omitted_pair_count,findings,
        excluded_canonical_ids,executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9,$10,'[]',0,$11,'[]',clock_timestamp())`,
    [
      input.executionRef,
      input.toolExecutionId,
      input.researchCaseId,
      input.userId,
      input.purpose,
      input.revision,
      input.inputRevision,
      JSON.stringify(input.exactRegimen),
      JSON.stringify(["TEST_ONLY", "TEST-DDI-001"]),
      "test-ddi-fixture-v1",
      JSON.stringify(input.findings),
    ],
  );
}

function fixtureProvenance(approvalRef, details) {
  return {
    accepted: true,
    fixtureScope: "TEST_ONLY",
    syntheticDataOnly: true,
    productionActivationPermitted: false,
    approvalRef,
    ...details,
  };
}

function patientInput(synthetic) {
  return {
    schemaVersion: "1",
    officialIdentifier: {
      type: identifierConfiguration.type,
      issuingAuthority: identifierConfiguration.issuingAuthority,
      value: synthetic.officialIdentifier,
    },
    firstName: synthetic.firstName,
    lastName: "VerticalResearcher",
    dateOfBirth: synthetic.birthDate,
    sex: synthetic.sex,
  };
}

function toClinicianMedication(medication) {
  return {
    canonicalMedicationId: medication.canonicalMedicationId,
    dose: medication.dose,
    route: medication.route,
    frequency: medication.frequency,
    ...(medication.titration ? { titration: medication.titration } : {}),
    monitoring: medication.monitoring,
  };
}

async function workflowState(pool, researchCaseId) {
  return (
    await pool.query("SELECT workflow_state FROM insight.research_cases WHERE id=$1", [
      researchCaseId,
    ])
  ).rows[0].workflow_state;
}

async function workflowPosition(pool, researchCaseId) {
  const row = (
    await pool.query(
      "SELECT workflow_revision,input_revision FROM insight.research_cases WHERE id=$1",
      [researchCaseId],
    )
  ).rows[0];
  return { revision: Number(row.workflow_revision), inputRevision: Number(row.input_revision) };
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

async function withFixtureModel(operation) {
  const server = createServer(async (request, response) => {
    const body = await readRequest(request);
    if (body.state === "UNAVAILABLE") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture unavailable" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      body.state === "MALFORMED"
        ? "not-json"
        : JSON.stringify({ status: "SUCCEEDED", state: body.state, model: "local-fixture-v1" }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestFixtureModel(baseUrl, state) {
  const response = await fetch(`${baseUrl}/v1/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!response.ok) throw new Error("unavailable dependency");
  try {
    const output = await response.json();
    if (output.status !== "SUCCEEDED" || output.state !== state) throw new Error();
    return output;
  } catch {
    throw new Error("malformed model output");
  }
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

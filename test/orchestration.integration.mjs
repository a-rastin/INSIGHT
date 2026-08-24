import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  cancelOwnedJob,
  claimNextJob,
  createOrchestrationJobHandler,
  invalidateResearchCaseInputs,
  releaseJobAfterFailure,
  settleJobFromDomainResult,
  startResearchCaseOrchestration,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withTransaction,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const stages = {
  DATA_COLLECTION: "DATA_COLLECTION_VALIDATED",
  NORMALIZING_MEDICATIONS: "MEDICATION_NORMALIZATION",
  IMPUTING_BYPASSED_ASSESSMENTS: "ASSESSMENT_IMPUTATION",
  ROUTING_BN: "BN_ROUTING",
  GENERATING_CPTS: "CPT_SNAPSHOT",
  RUNNING_BN: "BN_INFERENCE",
  CHECKING_PRIMARY_DDI: "PRIMARY_DDI",
  GENERATING_PRIMARY_PLAN: "PRIMARY_PLAN",
};

test("synthetic orchestration matrix preserves ownership, restart, and idempotency", async (suite) => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL must target a PostgreSQL 16 database.");
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString, maxConnections: 8 });
    try {
      await migrateToHead(pool);
      const actor = await seedPsychiatrist(pool);

      await suite.test("success and duplicate command reach clinician review once", async () => {
        const patientId = await seedCase(pool, actor.id, false);
        const endpoint = governedFixtureEndpoint();
        const first = await startResearchCaseOrchestration(pool, actor, patientId, "success-1");
        const duplicate = await startResearchCaseOrchestration(pool, actor, patientId, "success-1");
        assert.equal(duplicate.id, first.id);
        await runClaim(pool, createOrchestrationJobHandler(pool, endpoint));

        assert.equal(await state(pool, patientId), "CLINICIAN_REVIEW");
        assert.equal(endpoint.calls.length, Object.keys(stages).length);
        assert.equal(await acceptedCount(pool, patientId), Object.keys(stages).length);
      });

      await suite.test("bypassed assessment traverses imputation", async () => {
        const patientId = await seedCase(pool, actor.id, true);
        const endpoint = governedFixtureEndpoint();
        await startResearchCaseOrchestration(pool, actor, patientId, "bypass-1");
        await runClaim(pool, createOrchestrationJobHandler(pool, endpoint));

        assert.equal(await state(pool, patientId), "CLINICIAN_REVIEW");
        assert.ok(endpoint.calls.includes("IMPUTING_BYPASSED_ASSESSMENTS"));
      });

      for (const owningState of Object.keys(stages)) {
        await suite.test(`failure remains at ${owningState}`, async () => {
          const patientId = await seedCase(
            pool,
            actor.id,
            owningState === "IMPUTING_BYPASSED_ASSESSMENTS",
          );
          const job = await startResearchCaseOrchestration(
            pool,
            actor,
            patientId,
            `failure-${owningState}`,
          );
          const claim = await claimNextJob(pool, `worker-${owningState}`);
          assert.equal(claim.job.id, job.id);
          await assert.rejects(
            createOrchestrationJobHandler(
              pool,
              governedFixtureEndpoint({ failAt: owningState }),
            ).execute(claim, async () => undefined),
            /fixture endpoint failure/,
          );
          assert.equal(await state(pool, patientId), owningState);
          assert.equal(await failedAttempts(pool, job.id), 1);
          await cancelOwnedJob(pool, job.id, actor.id);
        });
      }

      await suite.test("expired process resumes without duplicate accepted artifacts", async () => {
        const patientId = await seedCase(pool, actor.id, true);
        const endpoint = governedFixtureEndpoint({ failOnceAt: "GENERATING_CPTS" });
        const job = await startResearchCaseOrchestration(pool, actor, patientId, "restart-1");
        const firstClaim = await claimNextJob(pool, "worker-before-restart");
        const handler = createOrchestrationJobHandler(pool, endpoint);
        await assert.rejects(
          handler.execute(firstClaim, async () => undefined),
          /fixture endpoint failure/,
        );
        await releaseJobAfterFailure(pool, firstClaim);

        const resumedClaim = await claimNextJob(pool, "worker-after-restart");
        assert.equal(resumedClaim.job.id, job.id);
        await handler.execute(resumedClaim, async () => undefined);
        await settleJobFromDomainResult(pool, resumedClaim, handler.resolveDomainResult);

        assert.equal(await state(pool, patientId), "CLINICIAN_REVIEW");
        assert.equal(await acceptedCount(pool, patientId), Object.keys(stages).length);
        assert.equal(await failedAttempts(pool, job.id), 1);
      });

      await suite.test("input revision change cancels stale run", async () => {
        const patientId = await seedCase(pool, actor.id, false);
        const job = await startResearchCaseOrchestration(pool, actor, patientId, "stale-1");
        await invalidateResearchCaseInputs(
          pool,
          actor,
          patientId,
          1,
          "Synthetic input changed.",
          randomUUID(),
        );
        const claim = await claimNextJob(pool, "worker-stale");
        await assert.rejects(
          createOrchestrationJobHandler(pool, governedFixtureEndpoint()).execute(
            claim,
            async () => undefined,
          ),
          { name: "Error" },
        );
        const persisted = (
          await pool.query("SELECT status FROM insight.jobs WHERE id=$1", [job.id])
        ).rows[0];
        assert.equal(persisted.status, "CANCELLED");
        assert.equal(await cancelledAttempts(pool, job.id), 1);
      });

      await suite.test("expired lease cannot accept or transition", async () => {
        const patientId = await seedCase(pool, actor.id, false);
        const job = await startResearchCaseOrchestration(pool, actor, patientId, "lease-1");
        const claim = await claimNextJob(pool, "worker-expiring", 20);
        const endpoint = governedFixtureEndpoint();
        const slowEndpoint = async (context) => {
          await delay(40);
          return endpoint(context);
        };
        await assert.rejects(
          createOrchestrationJobHandler(pool, slowEndpoint).execute(claim, async () => undefined),
          { name: "Error" },
        );
        assert.equal(await state(pool, patientId), "DATA_COLLECTION");
        assert.equal(await acceptedCount(pool, patientId), 0);
        await cancelOwnedJob(pool, job.id, actor.id);
      });

      await suite.test("new command safely reruns terminal failure", async () => {
        const patientId = await seedCase(pool, actor.id, false);
        const failedJob = await startResearchCaseOrchestration(pool, actor, patientId, "rerun-1");
        const failing = createOrchestrationJobHandler(
          pool,
          governedFixtureEndpoint({ failAt: "DATA_COLLECTION" }),
        );
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const claim = await claimNextJob(pool, `worker-failure-${attempt}`);
          await assert.rejects(failing.execute(claim, async () => undefined));
          await releaseJobAfterFailure(pool, claim);
        }
        const rerun = await startResearchCaseOrchestration(pool, actor, patientId, "rerun-2");
        assert.notEqual(rerun.id, failedJob.id);
        await runClaim(pool, createOrchestrationJobHandler(pool, governedFixtureEndpoint()));
        assert.equal(await state(pool, patientId), "CLINICIAN_REVIEW");
        assert.equal(await failedAttempts(pool, failedJob.id), 3);
      });
    } finally {
      await pool.end();
    }
  });
});

function governedFixtureEndpoint(options = {}) {
  const calls = [];
  let failedOnce = false;
  const endpoint = async (context) => {
    calls.push(context.workflowState);
    if (
      options.failAt === context.workflowState ||
      (options.failOnceAt === context.workflowState && !failedOnce)
    ) {
      failedOnce = true;
      throw new Error("fixture endpoint failure");
    }
    return {
      status: "SUCCEEDED",
      resultType: stages[context.workflowState],
      resultReference: `fixture.${context.workflowState}.${context.workflowRevision}`,
      provenance: {
        accepted: true,
        source: "LOCAL_GOVERNED_FIXTURE",
        endpoint: "MOCKED",
        researchCaseRevision: context.workflowRevision,
        inputRevision: context.inputRevision,
        dependencyFingerprint: context.dependencyFingerprint,
        dependencyManifest: context.dependencyManifest,
      },
    };
  };
  endpoint.calls = calls;
  return endpoint;
}

async function runClaim(pool, handler) {
  const claim = await claimNextJob(pool, `worker-${randomUUID()}`);
  assert.ok(claim);
  await handler.execute(claim, async () => undefined);
  await settleJobFromDomainResult(pool, claim, handler.resolveDomainResult);
}

async function seedPsychiatrist(pool) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO insight.users
       (id,username,password_hash,password_policy_version,role,status)
     VALUES ($1,$2,'$argon2id$test',1,'PSYCHIATRIST','ENABLED')`,
    [id, `orchestrator-${id}`],
  );
  return { id, role: "PSYCHIATRIST" };
}

async function seedCase(pool, userId, bypassed) {
  const patientId = randomUUID();
  const caseId = randomUUID();
  const bytes = randomBytes(32);
  await pool.query(
    `INSERT INTO insight.patients
       (id,official_identifier_type,official_identifier_issuer,
        official_identifier_lookup_hash,official_identifier_ciphertext,official_identifier_iv,
        official_identifier_tag,first_name_ciphertext,first_name_iv,first_name_tag,
        last_name_ciphertext,last_name_iv,last_name_tag,date_of_birth_ciphertext,
        date_of_birth_iv,date_of_birth_tag,encryption_key_version,sex,
        created_by_user_id,updated_by_user_id)
     VALUES ($1,'SYNTHETIC','TEST',$2,$3,$4,$5,$3,$4,$5,$3,$4,$5,$3,$4,$5,1,
             'FEMALE',$6,$6)`,
    [patientId, bytes, Buffer.from("encrypted"), Buffer.alloc(12), Buffer.alloc(16), userId],
  );
  await pool.query(
    `INSERT INTO insight.research_cases
       (id,patient_id,started_at,created_by_user_id,updated_by_user_id)
     VALUES ($1,$2,clock_timestamp(),$3,$3)`,
    [caseId, patientId, userId],
  );
  await withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('insight.dsm5tr_write','allowed',true)");
    await client.query("SELECT set_config('insight.panss_write','allowed',true)");
    await client.query("SELECT set_config('insight.cssrs_write','allowed',true)");
    await client.query(
      `UPDATE insight.research_case_assessments
       SET status=CASE WHEN assessment_type='CSSRS_RECENT' AND $2
                       THEN 'BYPASSED'::insight.assessment_status
                       ELSE 'COMPLETED'::insight.assessment_status END,
           updated_by_user_id=$3,updated_at=clock_timestamp()
       WHERE research_case_id=$1`,
      [caseId, bypassed, userId],
    );
  });
  return patientId;
}

async function state(pool, patientId) {
  return (
    await pool.query("SELECT workflow_state FROM insight.research_cases WHERE patient_id=$1", [
      patientId,
    ])
  ).rows[0].workflow_state;
}

async function acceptedCount(pool, patientId) {
  return Number(
    (
      await pool.query(
        `SELECT count(*) FROM insight.research_case_domain_results result
         JOIN insight.research_cases research_case ON research_case.id=result.research_case_id
         WHERE research_case.patient_id=$1 AND result.status='SUCCEEDED'`,
        [patientId],
      )
    ).rows[0].count,
  );
}

async function failedAttempts(pool, jobId) {
  return Number(
    (
      await pool.query(
        `SELECT count(*) FROM insight.research_case_orchestration_attempts attempt
         JOIN insight.research_case_orchestration_runs run ON run.id=attempt.run_id
         WHERE run.job_id=$1 AND attempt.status='FAILED'`,
        [jobId],
      )
    ).rows[0].count,
  );
}

async function cancelledAttempts(pool, jobId) {
  return Number(
    (
      await pool.query(
        `SELECT count(*) FROM insight.research_case_orchestration_attempts attempt
         JOIN insight.research_case_orchestration_runs run ON run.id=attempt.run_id
         WHERE run.job_id=$1 AND attempt.status='CANCELLED'`,
        [jobId],
      )
    ).rows[0].count,
  );
}

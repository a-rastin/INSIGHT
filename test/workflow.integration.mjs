import assert from "node:assert/strict";
import test from "node:test";

import {
  RequiredDomainResultError,
  StaleResearchCaseRevisionError,
  WorkflowTransitionError,
  buildApp,
  createOrOverwritePatient,
  createUser,
  getResearchCaseWorkflow,
  invalidateResearchCaseInputs,
  recordAssessmentState,
  recordDomainResult,
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

test("Research Case workflow persistence and trust boundary", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test(
    "revisioned transitions persist across restart and retain audit provenance",
    () =>
      withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
        let pool = createPostgresPool({ connectionString });
        try {
          await migrateToHead(pool);
          const { actor, patientId } = await createCase(pool, 701);

          let workflow = await getResearchCaseWorkflow(pool, actor, patientId);
          assert.equal(workflow.state, "DATA_COLLECTION");
          assert.equal(workflow.revision, 1);
          assert.deepEqual(workflow.allowedCommands, []);

          await recordAssessmentState(pool, actor, patientId, "DSM5TR", "COMPLETED", 1);
          await recordAssessmentState(pool, actor, patientId, "PANSS", "BYPASSED", 1);
          await recordAssessmentState(pool, actor, patientId, "CSSRS_RECENT", "COMPLETED", 1);
          await recordSuccess(pool, actor, patientId, "DATA_COLLECTION_VALIDATED", 1, 1);
          workflow = await transition(pool, actor, patientId, "BEGIN_NORMALIZATION", 1);
          assert.deepEqual(workflow.modelAllowedTools, [
            "research_case.get_context",
            "medication.search_candidates",
            "medication.commit_mapping",
          ]);

          const forward = [
            ["MEDICATION_NORMALIZATION", "COMPLETE_MEDICATION_NORMALIZATION"],
            ["ASSESSMENT_IMPUTATION", "COMPLETE_ASSESSMENT_IMPUTATION"],
            ["BN_ROUTING", "COMPLETE_BN_ROUTING"],
            ["CPT_SNAPSHOT", "COMPLETE_CPT_GENERATION"],
            ["BN_INFERENCE", "COMPLETE_BN_INFERENCE"],
            ["PRIMARY_DDI", "COMPLETE_PRIMARY_DDI"],
            ["PRIMARY_PLAN", "COMPLETE_PRIMARY_PLAN"],
          ];
          for (const [resultType, command] of forward) {
            await recordSuccess(
              pool,
              actor,
              patientId,
              resultType,
              workflow.revision,
              workflow.revision,
            );
            workflow = await transition(pool, actor, patientId, command, workflow.revision);
          }
          assert.equal(workflow.state, "CLINICIAN_REVIEW");

          workflow = await transition(
            pool,
            actor,
            patientId,
            "REQUEST_FINAL_DDI_RECHECK",
            workflow.revision,
          );
          await recordDomainResult(
            pool,
            actor,
            patientId,
            {
              type: "FINAL_DDI",
              status: "FAILED",
              resultReference: "final-ddi-failed",
              provenance: { executionId: "failed-required-dependency" },
              expectedRevision: workflow.revision,
            },
            new Date("2026-08-22T10:00:10.000Z"),
          );
          assert.deepEqual(
            (await getResearchCaseWorkflow(pool, actor, patientId)).allowedCommands,
            [],
          );
          await assert.rejects(
            () =>
              transitionResearchCase(
                pool,
                actor,
                patientId,
                "COMPLETE_FINAL_DDI",
                workflow.revision,
                requestId(900),
              ),
            RequiredDomainResultError,
          );

          await recordSuccess(pool, actor, patientId, "FINAL_DDI", workflow.revision, 20);
          workflow = await transition(
            pool,
            actor,
            patientId,
            "COMPLETE_FINAL_DDI",
            workflow.revision,
          );
          assert.equal(workflow.state, "READY_TO_FINALIZE");
          workflow = await transition(pool, actor, patientId, "FINALIZE", workflow.revision);
          assert.equal(workflow.state, "FINALIZED");

          await pool.end();
          pool = createPostgresPool({ connectionString });
          workflow = await getResearchCaseWorkflow(pool, actor, patientId);
          assert.equal(workflow.state, "FINALIZED");
          assert.equal(workflow.revision, 12);
          assert.deepEqual(workflow.allowedCommands, ["CREATE_REVISION_DRAFT", "DELETE"]);

          workflow = await transition(pool, actor, patientId, "CREATE_REVISION_DRAFT", 12);
          workflow = await transition(
            pool,
            actor,
            patientId,
            "REQUEST_REVISION_DDI_RECHECK",
            workflow.revision,
          );
          await recordSuccess(pool, actor, patientId, "FINAL_DDI", workflow.revision, 30);
          workflow = await transition(
            pool,
            actor,
            patientId,
            "COMPLETE_FINAL_DDI",
            workflow.revision,
          );
          workflow = await transition(pool, actor, patientId, "FINALIZE", workflow.revision);
          workflow = await transition(pool, actor, patientId, "DELETE", workflow.revision);
          assert.equal(workflow.state, "DELETED");
          assert.deepEqual(workflow.allowedCommands, []);

          const audit = await pool.query(
            `SELECT command, from_revision::integer, to_revision::integer,
                cardinality(domain_result_ids)::integer AS result_count,
                actor_user_id, request_id, provenance
         FROM insight.research_case_transition_events
         ORDER BY to_revision`,
          );
          assert.equal(audit.rowCount, 16);
          assert.deepEqual(
            audit.rows.map(({ from_revision, to_revision }) => [from_revision, to_revision]),
            Array.from({ length: 16 }, (_, index) => [index + 1, index + 2]),
          );
          assert.ok(
            audit.rows.every(({ actor_user_id, request_id }) => actor_user_id && request_id),
          );
          assert.ok(audit.rows.some(({ result_count }) => result_count > 1));
          assert.ok(audit.rows.every(({ provenance }) => typeof provenance === "object"));
        } finally {
          await pool.end().catch(() => undefined);
        }
      }),
  );

  await suite.test("illegal skips, stale revisions, forged writes, and stale results fail", () =>
    withWorkflowDatabase(async (pool) => {
      const { actor, patientId, researchCaseId } = await createCase(pool, 702);
      await assert.rejects(
        () =>
          transitionResearchCase(
            pool,
            actor,
            patientId,
            "COMPLETE_BN_INFERENCE",
            1,
            requestId(100),
          ),
        WorkflowTransitionError,
      );
      await assert.rejects(
        () =>
          transitionResearchCase(pool, actor, patientId, "BEGIN_NORMALIZATION", 0, requestId(101)),
        StaleResearchCaseRevisionError,
      );
      await assert.rejects(
        () =>
          pool.query(
            "UPDATE insight.research_cases SET workflow_state = 'FINALIZED' WHERE id = $1",
            [researchCaseId],
          ),
        /service-owned/,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO insight.research_case_domain_results (
               research_case_id, result_type, status, workflow_revision, input_revision,
               result_reference, provenance, recorded_by_user_id
             ) VALUES ($1, 'DATA_COLLECTION_VALIDATED', 'SUCCEEDED', 1, 1,
                       'forged-success', '{}', $2)`,
            [researchCaseId, actor.id],
          ),
        /service-owned/,
      );

      await recordAssessmentState(pool, actor, patientId, "DSM5TR", "BYPASSED", 1);
      await recordAssessmentState(pool, actor, patientId, "PANSS", "COMPLETED", 1);
      await recordAssessmentState(pool, actor, patientId, "CSSRS_RECENT", "COMPLETED", 1);
      await recordSuccess(pool, actor, patientId, "DATA_COLLECTION_VALIDATED", 1, 1);
      let workflow = await transition(pool, actor, patientId, "BEGIN_NORMALIZATION", 1);
      await recordSuccess(pool, actor, patientId, "MEDICATION_NORMALIZATION", 2, 2);
      workflow = await transition(pool, actor, patientId, "COMPLETE_MEDICATION_NORMALIZATION", 2);
      assert.deepEqual(workflow.allowedCommands, []);
      await assert.rejects(
        () =>
          transitionResearchCase(
            pool,
            actor,
            patientId,
            "COMPLETE_ASSESSMENT_IMPUTATION",
            3,
            requestId(104),
          ),
        RequiredDomainResultError,
      );

      workflow = await invalidateResearchCaseInputs(
        pool,
        actor,
        patientId,
        3,
        "Assessment answer changed.",
        requestId(105),
      );
      assert.equal(workflow.state, "DATA_COLLECTION");
      assert.equal(workflow.inputRevision, 2);
      assert.equal(workflow.lastInputInvalidation.reason, "Assessment answer changed.");
      assert.deepEqual(workflow.allowedCommands, []);
      const stale = await pool.query(
        `SELECT count(*)::integer AS count
         FROM insight.research_case_domain_results
         WHERE research_case_id = $1 AND invalidated_at IS NOT NULL`,
        [researchCaseId],
      );
      assert.equal(stale.rows[0].count, 2);
    }),
  );

  await suite.test("browser can send commands but cannot assign state or forge success", () =>
    withWorkflowDatabase(async (pool) => {
      const { user, patientId } = await createCase(pool, 703);
      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        patient: { officialIdentifier: identifierConfiguration },
      });
      try {
        const session = await login(app, user.username, "research-password");
        const initial = await app.inject({
          method: "GET",
          url: `/api/v1/patients/${patientId}/research-case`,
          headers: { cookie: session.cookie },
        });
        assert.equal(initial.statusCode, 200);
        assert.equal(initial.json().researchCase.currentStep.label, "Data collection");

        for (const forged of [{ state: "FINALIZED" }, { domainSuccess: true }]) {
          const response = await app.inject({
            method: "POST",
            url: `/api/v1/patients/${patientId}/research-case/transitions`,
            headers: unsafeHeaders(session),
            payload: {
              schemaVersion: "1",
              command: "BEGIN_NORMALIZATION",
              expectedRevision: 1,
              ...forged,
            },
          });
          assert.equal(response.statusCode, 400);
          assert.equal(response.json().error.code, "INVALID_REQUEST");
        }
        const missingResult = await app.inject({
          method: "POST",
          url: `/api/v1/patients/${patientId}/research-case/transitions`,
          headers: unsafeHeaders(session),
          payload: {
            schemaVersion: "1",
            command: "BEGIN_NORMALIZATION",
            expectedRevision: 1,
          },
        });
        assert.equal(missingResult.statusCode, 409);
        assert.equal(missingResult.json().error.code, "REQUIRED_DOMAIN_RESULT_MISSING");
      } finally {
        await app.close();
      }
    }),
  );
});

async function transition(pool, actor, patientId, command, revision) {
  return transitionResearchCase(pool, actor, patientId, command, revision, requestId(revision));
}

async function recordSuccess(pool, actor, patientId, type, revision, sequence) {
  return recordDomainResult(
    pool,
    actor,
    patientId,
    {
      type,
      status: "SUCCEEDED",
      resultReference: `${type.toLowerCase()}-${sequence}`,
      provenance: { executionId: `synthetic-${sequence}`, acceptedDomainStatus: "SUCCEEDED" },
      expectedRevision: revision,
    },
    new Date(Date.UTC(2026, 7, 22, 10, 0, sequence)),
  );
}

async function createCase(pool, sequence) {
  const user = await createUser(pool, {
    username: `WorkflowResearcher${sequence}`,
    password: "research-password",
    role: "PSYCHIATRIST",
  });
  const actor = { id: user.id, role: user.role };
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
      lastName: "Workflow",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    requestId(sequence),
    new Date("2026-08-22T10:00:00.000Z"),
  );
  return {
    user,
    actor,
    patientId: created.patient.id,
    researchCaseId: created.patient.researchCase.id,
  };
}

function requestId(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  return { cookie: setCookie.split(";", 1)[0], csrfToken: response.json().csrfToken };
}

function unsafeHeaders(session) {
  return { cookie: session.cookie, "x-csrf-token": session.csrfToken };
}

async function withWorkflowDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      return await operation(pool);
    } finally {
      await pool.end();
    }
  });
}

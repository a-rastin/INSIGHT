import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PatientAuthorizationError,
  PatientNotFoundError,
  ResearchCaseNotFoundError,
  buildApp,
  createOrOverwritePatient,
  createUser,
  deletePatient,
  getPatient,
  getResearchCaseWorkflow,
  listPatientAuditEvents,
  listPatients,
  listResearchCaseTransitionAuditEvents,
  recordAssessmentState,
  recordDomainResult,
  saveDsm5trAssessment,
  transitionResearchCase,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrations,
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

const completeDsmAnswers = {
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
};

test("immediate Patient hard deletion with surviving audit", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("deletes full aggregate and non-audit files but retains readable audit", () =>
    withDeletionDatabase(async (pool, artifactRoot) => {
      const { actor, patient } = await createPatient(pool, 901);
      const patientId = patient.id;
      const researchCaseId = patient.researchCase.id;

      await saveDsm5trAssessment(pool, actor, patientId, {
        mode: "COMPLETE",
        expectedRevision: 1,
        answers: completeDsmAnswers,
        psychiatristDecision: "SCHIZOPHRENIA_CONFIRMED",
      });
      for (const assessment of ["PANSS", "CSSRS_RECENT"]) {
        await recordAssessmentState(pool, actor, patientId, assessment, "COMPLETED", 1);
      }
      const resultId = await recordDomainResult(pool, actor, patientId, {
        type: "DATA_COLLECTION_VALIDATED",
        status: "SUCCEEDED",
        resultReference: "patients/result.json",
        provenance: { executionId: "synthetic-delete-aggregate" },
        expectedRevision: 1,
      });
      await transitionResearchCase(
        pool,
        actor,
        patientId,
        "BEGIN_NORMALIZATION",
        1,
        requestId(9011),
      );

      const operationalFile = join(artifactRoot, "patients", patientId, resultId, "result.json");
      const auditFile = join(artifactRoot, "audit", patientId, "payload.json");
      await mkdir(dirname(operationalFile), { recursive: true });
      await mkdir(dirname(auditFile), { recursive: true });
      await writeFile(operationalFile, "operational");
      await writeFile(auditFile, "retained-audit");

      const deleted = await deletePatient(
        pool,
        actor,
        patientId,
        requestId(9012),
        { artifactRoot },
        new Date("2026-08-22T10:01:00.000Z"),
      );
      assert.deepEqual(deleted, { databaseStatus: "DELETED", artifactRemoval: "SUCCEEDED" });
      await assert.rejects(access(operationalFile), { code: "ENOENT" });
      assert.equal(await readFile(auditFile, "utf8"), "retained-audit");

      assert.deepEqual(await aggregateCounts(pool), {
        patients: 0,
        researchCases: 0,
        assessments: 0,
        domainResults: 0,
        patientAudits: 2,
        transitionAudits: 1,
      });
      assert.deepEqual(await listPatients(pool, actor), []);
      await assert.rejects(() => getPatient(pool, actor, patientId), PatientNotFoundError);
      await assert.rejects(
        () => getResearchCaseWorkflow(pool, actor, patientId),
        ResearchCaseNotFoundError,
      );

      const audit = await listPatientAuditEvents(pool, actor, patientId);
      assert.deepEqual(
        audit.map(({ eventType }) => eventType),
        ["PATIENT_CREATED", "PATIENT_DELETED"],
      );
      assert.deepEqual(audit[1].patientLink, { patientId, researchCaseId });
      assert.deepEqual(audit[1].before, audit[0].after);
      assert.equal(audit[1].after, null);
      assert.equal(audit[1].actorUserId, actor.id);

      const transitionAudit = await listResearchCaseTransitionAuditEvents(pool, actor, patientId);
      assert.deepEqual(transitionAudit[0].patientLink, { patientId, researchCaseId });
      assert.deepEqual(transitionAudit[0].domainResultIds, [resultId]);
      assert.equal(transitionAudit[0].provenance.command, "BEGIN_NORMALIZATION");

      const retried = await deletePatient(pool, actor, patientId, requestId(9013), {
        artifactRoot,
      });
      assert.deepEqual(retried, { databaseStatus: "DELETED", artifactRemoval: "SUCCEEDED" });
      assert.equal((await listPatientAuditEvents(pool, actor, patientId)).length, 2);
    }),
  );

  await suite.test(
    "role matrix denies Administrator and file failure still reports DB success",
    () =>
      withDeletionDatabase(async (pool, artifactRoot) => {
        const { user, patient } = await createPatient(pool, 902);
        const removalPaths = [];
        const loggedFailures = [];
        const app = buildApp({
          authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
          patient: {
            officialIdentifier: identifierConfiguration,
            artifactRoot,
            removePatientArtifacts: async (path) => {
              removalPaths.push(path);
              throw new Error("synthetic file removal failure");
            },
            logArtifactRemovalFailure: (event) => loggedFailures.push(event),
          },
        });
        try {
          const psychiatristSession = await login(app, user.username, "research-password");
          const administratorSession = await login(app, "admin", "admin");
          const administratorId = (
            await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
          ).rows[0].id;
          const url = `/api/v1/patients/${patient.id}`;

          const unauthenticated = await app.inject({ method: "DELETE", url });
          assert.equal(unauthenticated.statusCode, 401);
          const administrator = await app.inject({
            method: "DELETE",
            url,
            headers: unsafeHeaders(administratorSession),
          });
          assert.equal(administrator.statusCode, 403);
          assert.equal(
            (await getPatient(pool, { id: user.id, role: user.role }, patient.id)).id,
            patient.id,
          );
          await assert.rejects(
            () =>
              deletePatient(
                pool,
                { id: user.id, role: "ADMINISTRATOR" },
                patient.id,
                requestId(9021),
                { artifactRoot },
              ),
            PatientAuthorizationError,
          );
          await assert.rejects(
            () => getPatient(pool, { id: administratorId, role: "PSYCHIATRIST" }, patient.id),
            PatientAuthorizationError,
          );
          await assert.rejects(() =>
            listResearchCaseTransitionAuditEvents(
              pool,
              { id: user.id, role: "ADMINISTRATOR" },
              patient.id,
            ),
          );

          const psychiatrist = await app.inject({
            method: "DELETE",
            url,
            headers: unsafeHeaders(psychiatristSession),
          });
          assert.equal(psychiatrist.statusCode, 200);
          assert.deepEqual(psychiatrist.json().deletion, {
            databaseStatus: "DELETED",
            artifactRemoval: "FAILED",
          });
          assert.equal((await aggregateCounts(pool)).patients, 0);
          assert.equal(removalPaths.length, 1);
          assert.equal(loggedFailures.length, 1);

          const retry = await app.inject({
            method: "DELETE",
            url,
            headers: unsafeHeaders(psychiatristSession),
          });
          assert.equal(retry.statusCode, 200);
          assert.equal(retry.json().deletion.databaseStatus, "DELETED");
          assert.equal(removalPaths.length, 1);
          assert.equal(loggedFailures.length, 1);
          assert.equal(
            (await listPatientAuditEvents(pool, { id: user.id, role: user.role }, patient.id))
              .length,
            2,
          );
        } finally {
          await app.close();
        }
      }),
  );

  await suite.test("migration removes legacy workflow-state deletion residue", () =>
    withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool, migrations.slice(0, 8));
        const { actor, patient } = await createPatient(pool, 903);
        await withTransaction(pool, async (client) => {
          await client.query("SELECT set_config('insight.workflow_transition', 'allowed', true)");
          await client.query(
            `UPDATE insight.research_cases
             SET workflow_state = 'DELETED', workflow_revision = 2
             WHERE id = $1`,
            [patient.researchCase.id],
          );
          await client.query(
            `INSERT INTO insight.research_case_transition_events (
               research_case_id, patient_id, command, from_state, to_state,
               from_revision, to_revision, input_revision, actor_user_id, request_id,
               provenance
             ) VALUES ($1, $2, 'DELETE', 'FINALIZED', 'DELETED', 1, 2, 1, $3, $4, '{}')`,
            [patient.researchCase.id, patient.id, actor.id, requestId(9031)],
          );
        });

        await migrateToHead(pool);
        assert.equal((await aggregateCounts(pool)).patients, 0);
        const audit = await listPatientAuditEvents(pool, actor, patient.id);
        assert.deepEqual(
          audit.map(({ eventType }) => eventType),
          ["PATIENT_CREATED", "PATIENT_DELETED"],
        );
        assert.deepEqual(audit[1].before, audit[0].after);
        assert.equal(audit[1].after, null);
        assert.equal(
          (await listResearchCaseTransitionAuditEvents(pool, actor, patient.id))[0].command,
          "DELETE",
        );
      } finally {
        await pool.end();
      }
    }),
  );
});

async function createPatient(pool, sequence) {
  const user = await createUser(pool, {
    username: `DeletionResearcher${sequence}`,
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
      lastName: "Deletion",
      dateOfBirth: synthetic.birthDate,
      sex: synthetic.sex,
    },
    identifierConfiguration,
    requestId(sequence),
    new Date("2026-08-22T10:00:00.000Z"),
  );
  return { user, actor, patient: created.patient };
}

async function aggregateCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM insight.patients) AS patients,
      (SELECT count(*)::integer FROM insight.research_cases) AS "researchCases",
      (SELECT count(*)::integer FROM insight.research_case_assessments) AS assessments,
      (SELECT count(*)::integer FROM insight.research_case_domain_results) AS "domainResults",
      (SELECT count(*)::integer FROM insight.patient_audit_events) AS "patientAudits",
      (SELECT count(*)::integer FROM insight.research_case_transition_events) AS "transitionAudits"
  `);
  return result.rows[0];
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

async function withDeletionDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    const artifactRoot = await mkdtemp(join(tmpdir(), "insight-patient-deletion-"));
    try {
      await migrateToHead(pool);
      return await operation(pool, artifactRoot);
    } finally {
      await pool.end();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
}

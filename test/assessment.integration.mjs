import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrOverwritePatient,
  createUser,
  saveCssrsAssessment,
  saveDsm5trAssessment,
  savePanssAssessment,
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

test("assessment commits are last-write-wins with metadata audit and atomic bypass", async () => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );
  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      const [firstUser, secondUser] = await Promise.all([
        createUser(pool, {
          username: "AssessmentWriterOne",
          password: "password",
          role: "PSYCHIATRIST",
        }),
        createUser(pool, {
          username: "AssessmentWriterTwo",
          password: "password",
          role: "PSYCHIATRIST",
        }),
      ]);
      const synthetic = makeSyntheticPatientIdentity(883);
      const created = await createOrOverwritePatient(
        pool,
        { id: firstUser.id, role: firstUser.role },
        {
          officialIdentifier: {
            type: identifierConfiguration.type,
            issuingAuthority: identifierConfiguration.issuingAuthority,
            value: synthetic.officialIdentifier,
          },
          firstName: synthetic.firstName,
          lastName: "Assessment",
          dateOfBirth: synthetic.birthDate,
          sex: synthetic.sex,
        },
        identifierConfiguration,
        "00000000-0000-4000-8000-000000000883",
      );
      const patientId = created.patient.id;
      const actors = [firstUser, secondUser].map(({ id, role }) => ({ id, role }));

      await Promise.all([
        savePanssAssessment(pool, actors[0], patientId, {
          mode: "SAVE",
          expectedRevision: 1,
          answers: { P1: 1 },
        }),
        savePanssAssessment(pool, actors[1], patientId, {
          mode: "SAVE",
          expectedRevision: 1,
          answers: { P1: 7 },
        }),
      ]);

      const panss = await pool.query(
        `SELECT payload.answers, summary.updated_by_user_id
         FROM insight.panss_assessments payload
         JOIN insight.research_case_assessments summary
           ON summary.research_case_id = payload.research_case_id
          AND summary.assessment_type = 'PANSS'`,
      );
      const panssAudit = await pool.query(
        `SELECT actor_user_id, status
         FROM insight.assessment_save_events
         WHERE assessment_type = 'PANSS'
         ORDER BY id`,
      );
      assert.equal(panssAudit.rowCount, 2);
      assert.equal(panssAudit.rows.at(-1).status, "IN_PROGRESS");
      assert.equal(panss.rows[0].updated_by_user_id, panssAudit.rows.at(-1).actor_user_id);
      assert.equal(
        panss.rows[0].answers.P1,
        panss.rows[0].updated_by_user_id === firstUser.id ? 1 : 7,
      );

      await saveDsm5trAssessment(pool, actors[0], patientId, {
        mode: "SAVE",
        expectedRevision: 1,
        answers: { criterionA: { delusions: true } },
        psychiatristDecision: "UNDECIDED",
      });
      await saveCssrsAssessment(pool, actors[0], patientId, {
        mode: "SAVE",
        expectedRevision: 1,
        answers: { q2SuicidalThoughts: true, q4Intent: true },
      });

      await Promise.all([
        saveDsm5trAssessment(pool, actors[1], patientId, {
          mode: "BYPASS",
          expectedRevision: 1,
        }),
        savePanssAssessment(pool, actors[1], patientId, {
          mode: "BYPASS",
          expectedRevision: 1,
        }),
        saveCssrsAssessment(pool, actors[1], patientId, {
          mode: "BYPASS",
          expectedRevision: 1,
        }),
      ]);

      const payloadCounts = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM insight.dsm5tr_assessments) AS dsm5tr,
           (SELECT count(*)::integer FROM insight.panss_assessments) AS panss,
           (SELECT count(*)::integer FROM insight.cssrs_recent_assessments) AS cssrs`,
      );
      assert.deepEqual(payloadCounts.rows[0], { dsm5tr: 0, panss: 0, cssrs: 0 });
      const summaries = await pool.query(
        `SELECT assessment_type, status, updated_by_user_id, updated_at
         FROM insight.research_case_assessments
         ORDER BY assessment_type`,
      );
      assert.deepEqual(
        summaries.rows.map(({ assessment_type, status }) => [assessment_type, status]),
        [
          ["CSSRS_RECENT", "BYPASSED"],
          ["DSM5TR", "BYPASSED"],
          ["PANSS", "BYPASSED"],
        ],
      );
      assert.ok(
        summaries.rows.every(
          ({ updated_by_user_id, updated_at }) =>
            updated_by_user_id === secondUser.id && updated_at instanceof Date,
        ),
      );
      const auditColumns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'insight' AND table_name = 'assessment_save_events'
         ORDER BY ordinal_position`,
      );
      assert.deepEqual(
        auditColumns.rows.map(({ column_name }) => column_name),
        ["id", "research_case_id", "assessment_type", "status", "actor_user_id", "occurred_at"],
      );
    } finally {
      await pool.end();
    }
  });
});

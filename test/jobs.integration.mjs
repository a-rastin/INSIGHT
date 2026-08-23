import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  JobLeaseLostError,
  buildApp,
  claimNextJob,
  createSession,
  enqueueJob,
  getOwnedJob,
  releaseJobAfterFailure,
  revokeSession,
  sessionCookie,
  settleJobFromDomainResult,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const fingerprint = (character) => character.repeat(64);

async function seedCase(pool) {
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const patientId = randomUUID();
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO insight.users
       (id, username, password_hash, password_policy_version, role, status)
     VALUES ($1, $2, '$argon2id$test', 1, 'PSYCHIATRIST', 'ENABLED'),
            ($3, $4, '$argon2id$test', 1, 'PSYCHIATRIST', 'ENABLED')`,
    [ownerId, `job-owner-${ownerId}`, otherId, `job-other-${otherId}`],
  );
  await pool.query(
    `INSERT INTO insight.patients
       (id, official_identifier_type, official_identifier_issuer,
        official_identifier_lookup_hash, official_identifier_ciphertext,
        official_identifier_iv, official_identifier_tag, first_name_ciphertext,
        first_name_iv, first_name_tag, last_name_ciphertext, last_name_iv,
        last_name_tag, date_of_birth_ciphertext, date_of_birth_iv,
        date_of_birth_tag, encryption_key_version, sex,
        created_by_user_id, updated_by_user_id)
     VALUES ($1, 'SYNTHETIC', 'TEST', $2, $3, $4, $5, $3, $4, $5,
             $3, $4, $5, $3, $4, $5, 1, 'MALE', $6, $6)`,
    [
      patientId,
      Buffer.alloc(32, 1),
      Buffer.from("encrypted"),
      Buffer.alloc(12),
      Buffer.alloc(16),
      ownerId,
    ],
  );
  await pool.query(
    `INSERT INTO insight.research_cases
       (id, patient_id, started_at, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, clock_timestamp(), $3, $3)`,
    [caseId, patientId, ownerId],
  );
  const adminId = (
    await pool.query("SELECT id FROM insight.users WHERE role = 'ADMINISTRATOR' LIMIT 1")
  ).rows[0].id;
  return { ownerId, otherId, adminId, caseId };
}

function command(caseId, ownerId, key = "command-1", maxAttempts = 3) {
  return {
    jobType: "TEST_EXECUTION",
    researchCaseId: caseId,
    requestedByUserId: ownerId,
    inputFingerprint: fingerprint("a"),
    dependencyFingerprint: fingerprint("b"),
    payloadReference: "database:test-payload",
    idempotencyKey: key,
    maxAttempts,
  };
}

function parseSse(payload) {
  return payload
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const id = Number(block.match(/^id: (\d+)$/m)?.[1]);
      const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1]);
      return { id, data };
    });
}

test("durable jobs concurrency, restart, idempotency, and resumable SSE", async (suite) => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL must target a PostgreSQL 16 database.");

  await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString, maxConnections: 8 });
    try {
      await migrateToHead(pool);
      const identities = await seedCase(pool);

      await suite.test(
        "duplicate command and concurrent claim have one durable identity",
        async () => {
          const first = await enqueueJob(pool, command(identities.caseId, identities.ownerId));
          const duplicate = await enqueueJob(pool, command(identities.caseId, identities.ownerId));
          assert.equal(duplicate.id, first.id);

          const now = new Date("2030-01-01T00:00:00.000Z");
          const [left, right] = await Promise.all([
            claimNextJob(pool, "worker-left", 30_000, now),
            claimNextJob(pool, "worker-right", 30_000, now),
          ]);
          const claims = [left, right].filter(Boolean);
          assert.equal(claims.length, 1);
          assert.equal(claims[0].job.id, first.id);

          const completed = await settleJobFromDomainResult(
            pool,
            claims[0],
            async () => ({
              status: "SUCCEEDED",
              resultReference: "domain-result:1",
              provenanceReference: "provenance:1",
            }),
            new Date("2030-01-01T00:00:01.000Z"),
          );
          assert.equal(completed.status, "SUCCEEDED");
          const afterCompletion = await enqueueJob(
            pool,
            command(identities.caseId, identities.ownerId),
          );
          assert.equal(afterCompletion.id, first.id);
          assert.equal(afterCompletion.resultReference, "domain-result:1");
        },
      );

      await suite.test("expired lease recovers and attempts remain bounded", async () => {
        const job = await enqueueJob(
          pool,
          command(identities.caseId, identities.ownerId, "restart", 2),
        );
        const start = new Date("2030-02-01T00:00:00.000Z");
        const abandoned = await claimNextJob(pool, "worker-before-restart", 100, start);
        assert.equal(abandoned.job.id, job.id);
        const recovered = await claimNextJob(
          pool,
          "worker-after-restart",
          100,
          new Date(start.getTime() + 101),
        );
        assert.equal(recovered.job.id, job.id);
        assert.equal(recovered.attempt, 2);
        await assert.rejects(
          () =>
            settleJobFromDomainResult(
              pool,
              abandoned,
              async () => ({
                status: "SUCCEEDED",
                resultReference: "stale",
                provenanceReference: "stale",
              }),
              new Date(start.getTime() + 102),
            ),
          JobLeaseLostError,
        );
        assert.equal(
          await claimNextJob(pool, "third-worker", 100, new Date(start.getTime() + 202)),
          null,
        );
        assert.equal((await getOwnedJob(pool, job.id, identities.ownerId)).status, "FAILED");
      });

      await suite.test("worker return cannot substitute for accepted domain result", async () => {
        const job = await enqueueJob(
          pool,
          command(identities.caseId, identities.ownerId, "missing-domain-result", 1),
        );
        const now = new Date("2030-03-01T00:00:00.000Z");
        const claim = await claimNextJob(pool, "worker-domain-check", 30_000, now);
        assert.equal(claim.job.id, job.id);
        const settled = await settleJobFromDomainResult(
          pool,
          claim,
          async () => ({ status: "MISSING" }),
          new Date(now.getTime() + 1),
        );
        assert.equal(settled.status, "FAILED");
        assert.deepEqual(settled.error, {
          code: "DOMAIN_RESULT_MISSING",
          message: "No accepted domain result was recorded.",
        });
      });

      await suite.test("SSE order resumes exactly and every connection reauthorizes", async () => {
        const job = await enqueueJob(
          pool,
          command(identities.caseId, identities.ownerId, "sse", 1),
        );
        const now = new Date();
        const claim = await claimNextJob(pool, "worker-sse", 30_000, now);
        assert.equal(claim.job.id, job.id);
        await releaseJobAfterFailure(
          pool,
          claim,
          "EXECUTION_FAILED",
          0,
          new Date(now.getTime() + 1),
        );

        const ownerSession = await createSession(pool, identities.ownerId);
        const otherSession = await createSession(pool, identities.otherId);
        const adminSession = await createSession(pool, identities.adminId);
        const app = buildApp({ authentication: { pool, allowInsecureLoopbackCookie: true } });
        await app.ready();
        try {
          const ownerCookie = sessionCookie(ownerSession.token, false);
          const all = await app.inject({
            method: "GET",
            url: `/api/v1/jobs/${job.id}/events`,
            headers: { cookie: ownerCookie },
          });
          assert.equal(all.statusCode, 200);
          const allEvents = parseSse(all.payload);
          assert.deepEqual(
            allEvents.map(({ id, data }) => [id, data.type]),
            [
              [1, "QUEUED"],
              [2, "RUNNING"],
              [3, "FAILED"],
            ],
          );

          const resumed = await app.inject({
            method: "GET",
            url: `/api/v1/jobs/${job.id}/events`,
            headers: { cookie: ownerCookie, "last-event-id": "2" },
          });
          assert.deepEqual(
            parseSse(resumed.payload).map(({ id, data }) => [id, data.type]),
            [[3, "FAILED"]],
          );

          const other = await app.inject({
            method: "GET",
            url: `/api/v1/jobs/${job.id}`,
            headers: { cookie: sessionCookie(otherSession.token, false) },
          });
          assert.equal(other.statusCode, 404);
          const administrator = await app.inject({
            method: "GET",
            url: `/api/v1/jobs/${job.id}`,
            headers: { cookie: sessionCookie(adminSession.token, false) },
          });
          assert.equal(administrator.statusCode, 403);

          await revokeSession(pool, ownerSession.token);
          const reconnect = await app.inject({
            method: "GET",
            url: `/api/v1/jobs/${job.id}/events`,
            headers: { cookie: ownerCookie, "last-event-id": "2" },
          });
          assert.equal(reconnect.statusCode, 401);
        } finally {
          await app.close();
        }
      });
    } finally {
      await pool.end();
    }
  });
});

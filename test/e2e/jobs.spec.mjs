import { randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  appendJobProgress,
  claimNextJob,
  createSession,
  enqueueJob,
  getOwnedJob,
  settleJobFromDomainResult,
} from "../../.tsbuild/server/index.js";
import { createPostgresPool } from "../../.tsbuild/server/database/index.js";

const fingerprint = (character) => character.repeat(64);

async function seedRunningJob(pool) {
  const userId = randomUUID();
  const patientId = randomUUID();
  const researchCaseId = randomUUID();
  await pool.query(
    `INSERT INTO insight.users
       (id, username, password_hash, password_policy_version, role, status)
     VALUES ($1, $2, '$argon2id$test', 1, 'PSYCHIATRIST', 'ENABLED')`,
    [userId, `job-e2e-${userId}`],
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
     VALUES ($1, 'SYNTHETIC', 'E2E', $2, $3, $4, $5, $3, $4, $5,
             $3, $4, $5, $3, $4, $5, 1, 'FEMALE', $6, $6)`,
    [
      patientId,
      randomBytes(32),
      Buffer.from("encrypted"),
      Buffer.alloc(12),
      Buffer.alloc(16),
      userId,
    ],
  );
  await pool.query(
    `INSERT INTO insight.research_cases
       (id, patient_id, started_at, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, clock_timestamp(), $3, $3)`,
    [researchCaseId, patientId, userId],
  );
  const job = await enqueueJob(pool, {
    jobType: "BROWSER_REFRESH_TEST",
    researchCaseId,
    requestedByUserId: userId,
    inputFingerprint: fingerprint("c"),
    dependencyFingerprint: fingerprint("d"),
    payloadReference: "database:e2e-payload",
    idempotencyKey: randomUUID(),
    maxAttempts: 2,
  });
  const claim = await claimNextJob(pool, `e2e-worker-${randomUUID()}`, 60_000);
  await appendJobProgress(pool, claim, { code: "FIRST_STAGE", completedUnits: 1, totalUnits: 2 });
  return { userId, job, claim };
}

async function readTerminalEvents(page, jobId, lastEventId) {
  return page.evaluate(
    async ({ id, resume }) => {
      const response = await fetch(`/api/v1/jobs/${id}/events`, {
        headers: resume ? { "Last-Event-ID": resume } : {},
      });
      if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);
      const text = await response.text();
      return text
        .split("\n\n")
        .filter(Boolean)
        .map((block) => ({
          id: block.match(/^id: (\d+)$/m)?.[1],
          event: JSON.parse(block.match(/^data: (.+)$/m)?.[1]),
        }));
    },
    { id: jobId, resume: lastEventId },
  );
}

test("browser refresh disconnects display without cancelling work and resumes exactly", async ({
  context,
  page,
}) => {
  const connectionString = process.env.DATABASE_URL;
  expect(connectionString).toBeTruthy();
  const pool = createPostgresPool({ connectionString });
  try {
    const { userId, job, claim } = await seedRunningJob(pool);
    const session = await createSession(pool, userId);
    await context.addCookies([
      {
        name: "insight_session",
        value: session.token,
        url: "http://127.0.0.1:4173",
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.goto("/");

    const firstConnection = page.evaluate(async (jobId) => {
      const controller = new globalThis.AbortController();
      const response = await fetch(`/api/v1/jobs/${jobId}/events`, {
        signal: controller.signal,
      });
      const reader = response.body.getReader();
      const decoder = new globalThis.TextDecoder();
      let text = "";
      while (!text.includes("id: 3\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      controller.abort();
      return text;
    }, job.id);
    expect(await firstConnection).toContain("id: 3\n");

    await page.reload();
    expect((await getOwnedJob(pool, job.id, userId)).status).toBe("RUNNING");

    await appendJobProgress(pool, claim, {
      code: "SECOND_STAGE",
      completedUnits: 2,
      totalUnits: 2,
    });
    await settleJobFromDomainResult(pool, claim, async () => ({
      status: "SUCCEEDED",
      resultReference: "domain-result:e2e",
      provenanceReference: "provenance:e2e",
    }));

    const resumed = await readTerminalEvents(page, job.id, "3");
    expect(resumed.map(({ id, event }) => [id, event.type])).toEqual([
      ["4", "PROGRESS"],
      ["5", "SUCCEEDED"],
    ]);
  } finally {
    await pool.end();
  }
});

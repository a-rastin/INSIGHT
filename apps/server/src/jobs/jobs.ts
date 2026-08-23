import { createHash } from "node:crypto";

import type { JobEvent, JobRecord, JobStatus } from "@insight/contracts";
import type { Pool, PoolClient, QueryResult } from "pg";

import { withTransaction } from "../database/transaction.js";

const SAFE_FAILURES = {
  ATTEMPTS_EXHAUSTED: "Job attempts were exhausted.",
  CANCELLED: "Job was cancelled.",
  DEPENDENCY_UNAVAILABLE: "A required dependency was unavailable.",
  DOMAIN_RESULT_FAILED: "The domain operation failed.",
  DOMAIN_RESULT_MISSING: "No accepted domain result was recorded.",
  EXECUTION_FAILED: "Job execution failed.",
  LEASE_LOST: "Job lease was lost.",
} as const;

export type JobFailureCode = keyof typeof SAFE_FAILURES;

interface Queryable {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  job_type: string;
  research_case_id: string;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  result_reference: string | null;
  provenance_reference: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  requested_by_user_id: string;
  payload_reference: string;
  command_fingerprint: string;
  lease_owner: string | null;
}

interface EventRow extends Record<string, unknown> {
  sequence: string;
  job_id: string;
  event_type: JobEvent["type"];
  progress_code: string | null;
  completed_units: number | null;
  total_units: number | null;
  occurred_at: Date;
}

export interface EnqueueJobCommand {
  readonly jobType: string;
  readonly researchCaseId: string;
  readonly requestedByUserId: string;
  readonly inputFingerprint: string;
  readonly dependencyFingerprint: string;
  readonly payloadReference: string;
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
}

export interface JobClaim {
  readonly job: JobRecord;
  readonly payloadReference: string;
  readonly leaseOwner: string;
  readonly attempt: number;
}

export interface JobProgress {
  readonly code: string;
  readonly completedUnits?: number;
  readonly totalUnits?: number;
}

export type DomainJobResult =
  | {
      readonly status: "SUCCEEDED";
      readonly resultReference: string;
      readonly provenanceReference: string;
    }
  | { readonly status: "FAILED"; readonly code?: "DOMAIN_RESULT_FAILED" }
  | { readonly status: "MISSING" };

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different command.");
    this.name = "IdempotencyConflictError";
  }
}

export class JobLeaseLostError extends Error {
  constructor() {
    super(SAFE_FAILURES.LEASE_LOST);
    this.name = "JobLeaseLostError";
  }
}

const iso = (value: Date): string => value.toISOString();

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    jobType: row.job_type,
    researchCaseId: row.research_case_id,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    resultReference: row.result_reference,
    provenanceReference: row.provenance_reference,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    createdAt: iso(row.created_at),
    startedAt: row.started_at ? iso(row.started_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    updatedAt: iso(row.updated_at),
  };
}

function toEvent(row: EventRow): JobEvent {
  return {
    id: row.sequence,
    jobId: row.job_id,
    type: row.event_type,
    progress:
      row.event_type === "PROGRESS"
        ? {
            code: row.progress_code!,
            completedUnits: row.completed_units,
            totalUnits: row.total_units,
          }
        : null,
    occurredAt: iso(row.occurred_at),
  };
}

function commandFingerprint(command: EnqueueJobCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        command.jobType,
        command.researchCaseId,
        command.requestedByUserId,
        command.inputFingerprint,
        command.dependencyFingerprint,
        command.payloadReference,
        command.maxAttempts ?? 3,
      ]),
    )
    .digest("hex");
}

async function appendEvent(
  client: Queryable,
  jobId: string,
  type: JobEvent["type"],
  progress?: JobProgress,
): Promise<void> {
  await client.query(
    `INSERT INTO insight.job_events
       (job_id, sequence, event_type, progress_code, completed_units, total_units)
     SELECT $1, coalesce(max(sequence), 0) + 1, $2, $3, $4, $5
     FROM insight.job_events WHERE job_id = $1`,
    [
      jobId,
      type,
      progress?.code ?? null,
      progress?.completedUnits ?? null,
      progress?.totalUnits ?? null,
    ],
  );
}

export async function enqueueJob(pool: Pool, command: EnqueueJobCommand): Promise<JobRecord> {
  const maxAttempts = command.maxAttempts ?? 3;
  const fingerprint = commandFingerprint(command);
  return withTransaction(pool, async (client) => {
    const workflow = await client.query<{ workflow_state: string }>(
      `SELECT workflow_state FROM insight.research_cases WHERE id = $1`,
      [command.researchCaseId],
    );
    if (!workflow.rows[0]) throw new Error("Research Case was not found.");

    const inserted = await client.query<JobRow>(
      `INSERT INTO insight.jobs
         (job_type, research_case_id, requested_by_user_id, requested_workflow_state,
          input_fingerprint, dependency_fingerprint, command_fingerprint, payload_reference,
          idempotency_key, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (requested_by_user_id, research_case_id, job_type, idempotency_key)
       DO NOTHING
       RETURNING *`,
      [
        command.jobType,
        command.researchCaseId,
        command.requestedByUserId,
        workflow.rows[0].workflow_state,
        command.inputFingerprint,
        command.dependencyFingerprint,
        fingerprint,
        command.payloadReference,
        command.idempotencyKey,
        maxAttempts,
      ],
    );
    let row = inserted.rows[0];
    if (row) {
      await appendEvent(client, row.id, "QUEUED");
      return toJob(row);
    }

    const existing = await client.query<JobRow>(
      `SELECT * FROM insight.jobs
       WHERE requested_by_user_id = $1 AND research_case_id = $2
         AND job_type = $3 AND idempotency_key = $4`,
      [command.requestedByUserId, command.researchCaseId, command.jobType, command.idempotencyKey],
    );
    row = existing.rows[0]!;
    if (row.command_fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return toJob(row);
  });
}

export async function getOwnedJob(
  database: Queryable,
  jobId: string,
  userId: string,
): Promise<JobRecord | null> {
  const result = await database.query<JobRow>(
    `SELECT * FROM insight.jobs WHERE id = $1 AND requested_by_user_id = $2`,
    [jobId, userId],
  );
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function listOwnedJobEvents(
  database: Queryable,
  jobId: string,
  userId: string,
  afterSequence: string | number = 0,
): Promise<readonly JobEvent[] | null> {
  const owned = await database.query<{ status: JobStatus }>(
    `SELECT status FROM insight.jobs WHERE id = $1 AND requested_by_user_id = $2`,
    [jobId, userId],
  );
  if (!owned.rows[0]) return null;
  const events = await database.query<EventRow>(
    `SELECT * FROM insight.job_events
     WHERE job_id = $1 AND sequence > $2 ORDER BY sequence`,
    [jobId, afterSequence],
  );
  return events.rows.map(toEvent);
}

async function failExpiredExhausted(client: PoolClient, now: Date): Promise<void> {
  const exhausted = await client.query<{ id: string }>(
    `UPDATE insight.jobs
     SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
         error_code = 'ATTEMPTS_EXHAUSTED', error_message = $2,
         completed_at = $1, updated_at = $1
     WHERE status = 'RUNNING' AND lease_expires_at <= $1 AND attempt_count >= max_attempts
     RETURNING id`,
    [now, SAFE_FAILURES.ATTEMPTS_EXHAUSTED],
  );
  for (const { id } of exhausted.rows) await appendEvent(client, id, "FAILED");
}

export async function claimNextJob(
  pool: Pool,
  leaseOwner: string,
  leaseMilliseconds = 30_000,
  now = new Date(),
): Promise<JobClaim | null> {
  return withTransaction(pool, async (client) => {
    await failExpiredExhausted(client, now);
    const result = await client.query<JobRow>(
      `WITH candidate AS (
         SELECT id FROM insight.jobs
         WHERE attempt_count < max_attempts
           AND retry_eligible_at <= $1
           AND (status = 'QUEUED' OR (status = 'RUNNING' AND lease_expires_at <= $1))
         ORDER BY retry_eligible_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE insight.jobs job
       SET status = 'RUNNING', attempt_count = attempt_count + 1,
           lease_owner = $2, lease_expires_at = $3,
           started_at = coalesce(started_at, $1), updated_at = $1,
           error_code = NULL, error_message = NULL
       FROM candidate WHERE job.id = candidate.id
       RETURNING job.*`,
      [now, leaseOwner, new Date(now.getTime() + leaseMilliseconds)],
    );
    const row = result.rows[0];
    if (!row) return null;
    await appendEvent(client, row.id, "RUNNING");
    return {
      job: toJob(row),
      payloadReference: row.payload_reference,
      leaseOwner,
      attempt: row.attempt_count,
    };
  });
}

export async function renewJobLease(
  pool: Pool,
  claim: JobClaim,
  leaseMilliseconds = 30_000,
  now = new Date(),
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE insight.jobs SET lease_expires_at = $4, updated_at = $3
     WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
       AND attempt_count = $5 AND lease_expires_at > $3`,
    [
      claim.job.id,
      claim.leaseOwner,
      now,
      new Date(now.getTime() + leaseMilliseconds),
      claim.attempt,
    ],
  );
  return result.rowCount === 1;
}

export async function appendJobProgress(
  pool: Pool,
  claim: JobClaim,
  progress: JobProgress,
  now = new Date(),
): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(progress.code)) throw new TypeError("Invalid progress code.");
  await withTransaction(pool, async (client) => {
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM insight.jobs
       WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
         AND attempt_count = $3 AND lease_expires_at > $4
       FOR UPDATE`,
      [claim.job.id, claim.leaseOwner, claim.attempt, now],
    );
    if (!locked.rows[0]) throw new JobLeaseLostError();
    await appendEvent(client, claim.job.id, "PROGRESS", progress);
  });
}

export async function settleJobFromDomainResult(
  pool: Pool,
  claim: JobClaim,
  resolveDomainResult: (client: PoolClient, claim: JobClaim) => Promise<DomainJobResult>,
  now = new Date(),
): Promise<JobRecord> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<JobRow>(
      `SELECT * FROM insight.jobs
       WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
         AND attempt_count = $3 AND lease_expires_at > $4
       FOR UPDATE`,
      [claim.job.id, claim.leaseOwner, claim.attempt, now],
    );
    if (!locked.rows[0]) throw new JobLeaseLostError();
    const domain = await resolveDomainResult(client, claim);
    const success = domain.status === "SUCCEEDED";
    const failureCode: JobFailureCode =
      domain.status === "MISSING" ? "DOMAIN_RESULT_MISSING" : "DOMAIN_RESULT_FAILED";
    const result = await client.query<JobRow>(
      `UPDATE insight.jobs
       SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
           result_reference = $3, provenance_reference = $4,
           error_code = $5, error_message = $6, completed_at = $7, updated_at = $7
       WHERE id = $1 RETURNING *`,
      [
        claim.job.id,
        success ? "SUCCEEDED" : "FAILED",
        success ? domain.resultReference : null,
        success ? domain.provenanceReference : null,
        success ? null : failureCode,
        success ? null : SAFE_FAILURES[failureCode],
        now,
      ],
    );
    await appendEvent(client, claim.job.id, success ? "SUCCEEDED" : "FAILED");
    return toJob(result.rows[0]!);
  });
}

export async function releaseJobAfterFailure(
  pool: Pool,
  claim: JobClaim,
  code: "DEPENDENCY_UNAVAILABLE" | "EXECUTION_FAILED" = "EXECUTION_FAILED",
  retryDelayMilliseconds = 0,
  now = new Date(),
): Promise<JobRecord> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<JobRow>(
      `SELECT * FROM insight.jobs
       WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2 AND attempt_count = $3
       FOR UPDATE`,
      [claim.job.id, claim.leaseOwner, claim.attempt],
    );
    const row = locked.rows[0];
    if (!row) throw new JobLeaseLostError();
    const retry = row.attempt_count < row.max_attempts;
    const result = await client.query<JobRow>(
      `UPDATE insight.jobs
       SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
           retry_eligible_at = $3, error_code = $4, error_message = $5,
           completed_at = $6, updated_at = $7
       WHERE id = $1 RETURNING *`,
      [
        row.id,
        retry ? "QUEUED" : "FAILED",
        new Date(now.getTime() + retryDelayMilliseconds),
        retry ? null : code,
        retry ? null : SAFE_FAILURES[code],
        retry ? null : now,
        now,
      ],
    );
    await appendEvent(client, row.id, retry ? "RETRY_QUEUED" : "FAILED");
    return toJob(result.rows[0]!);
  });
}

export async function cancelOwnedJob(
  pool: Pool,
  jobId: string,
  userId: string,
  now = new Date(),
): Promise<JobRecord | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<JobRow>(
      `UPDATE insight.jobs
       SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL,
           error_code = 'CANCELLED', error_message = $3,
           completed_at = $4, updated_at = $4
       WHERE id = $1 AND requested_by_user_id = $2 AND status IN ('QUEUED', 'RUNNING')
       RETURNING *`,
      [jobId, userId, SAFE_FAILURES.CANCELLED, now],
    );
    if (!result.rows[0]) return null;
    await appendEvent(client, jobId, "CANCELLED");
    return toJob(result.rows[0]);
  });
}

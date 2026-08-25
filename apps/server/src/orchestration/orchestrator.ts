import { createHash, randomUUID } from "node:crypto";

import type { JobRecord, Role } from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import { getResearchCaseJob, type DomainJobResult, type JobClaim } from "../jobs/jobs.js";
import type { JobHandler } from "../jobs/runner.js";
import {
  type DomainResultType,
  type WorkflowCommand,
  type WorkflowState,
} from "../patient/workflow.js";

export const RESEARCH_CASE_ORCHESTRATION_JOB = "RESEARCH_CASE_ORCHESTRATION";

const STAGES: Readonly<
  Partial<
    Record<
      WorkflowState,
      { resultType: DomainResultType; command: WorkflowCommand; to: WorkflowState }
    >
  >
> = Object.freeze({
  DATA_COLLECTION: {
    resultType: "DATA_COLLECTION_VALIDATED",
    command: "BEGIN_NORMALIZATION",
    to: "NORMALIZING_MEDICATIONS",
  },
  NORMALIZING_MEDICATIONS: {
    resultType: "MEDICATION_NORMALIZATION",
    command: "COMPLETE_MEDICATION_NORMALIZATION",
    to: "IMPUTING_BYPASSED_ASSESSMENTS",
  },
  IMPUTING_BYPASSED_ASSESSMENTS: {
    resultType: "ASSESSMENT_IMPUTATION",
    command: "COMPLETE_ASSESSMENT_IMPUTATION",
    to: "ROUTING_BN",
  },
  ROUTING_BN: {
    resultType: "BN_ROUTING",
    command: "COMPLETE_BN_ROUTING",
    to: "GENERATING_CPTS",
  },
  GENERATING_CPTS: {
    resultType: "CPT_SNAPSHOT",
    command: "COMPLETE_CPT_GENERATION",
    to: "RUNNING_BN",
  },
  RUNNING_BN: {
    resultType: "BN_INFERENCE",
    command: "COMPLETE_BN_INFERENCE",
    to: "CHECKING_PRIMARY_DDI",
  },
  CHECKING_PRIMARY_DDI: {
    resultType: "PRIMARY_DDI",
    command: "COMPLETE_PRIMARY_DDI",
    to: "GENERATING_PRIMARY_PLAN",
  },
  GENERATING_PRIMARY_PLAN: {
    resultType: "PRIMARY_PLAN",
    command: "COMPLETE_PRIMARY_PLAN",
    to: "CLINICIAN_REVIEW",
  },
});

interface CaseRow extends QueryResultRow {
  id: string;
  patient_id: string;
  workflow_state: WorkflowState;
  workflow_revision: string;
  input_revision: string;
}

interface RunRow extends QueryResultRow {
  id: string;
  job_id: string;
  research_case_id: string;
  requested_by_user_id: string;
  input_revision: string;
  dependency_fingerprint: string;
  dependency_manifest: Readonly<Record<string, unknown>>;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  current_state: WorkflowState;
}

export interface OrchestrationStageContext {
  readonly runId: string;
  readonly jobId: string;
  readonly researchCaseId: string;
  readonly requestedByUserId: string;
  readonly workflowState: WorkflowState;
  readonly workflowRevision: number;
  readonly inputRevision: number;
  readonly dependencyFingerprint: string;
  readonly dependencyManifest: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface AcceptedOrchestrationResult {
  readonly status: "SUCCEEDED";
  readonly resultType: DomainResultType;
  readonly resultReference: string;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export type OrchestrationStageExecutor = (
  context: OrchestrationStageContext,
) => Promise<AcceptedOrchestrationResult>;

export class OrchestrationUnavailableError extends Error {}
export class OrchestrationStaleError extends Error {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function startResearchCaseOrchestration(
  pool: Pool,
  actor: { readonly id: string; readonly role: Role },
  patientId: string,
  idempotencyKey: string,
): Promise<JobRecord> {
  if (actor.role !== "PSYCHIATRIST" || !idempotencyKey || idempotencyKey.length > 200) {
    throw new OrchestrationUnavailableError();
  }
  return withTransaction(pool, async (client) => {
    const currentActor = await client.query(
      `SELECT 1 FROM insight.users
       WHERE id=$1 AND role='PSYCHIATRIST' AND status <> 'DISABLED'`,
      [actor.id],
    );
    if (currentActor.rowCount !== 1) throw new OrchestrationUnavailableError();
    const found = await client.query<CaseRow>(
      `SELECT id,workflow_state,workflow_revision,input_revision
       FROM insight.research_cases WHERE patient_id=$1 FOR UPDATE`,
      [patientId],
    );
    const researchCase = found.rows[0];
    if (!researchCase || !STAGES[researchCase.workflow_state]) {
      throw new OrchestrationUnavailableError();
    }
    const existing = await client.query<{ job_id: string }>(
      `SELECT job_id FROM insight.research_case_orchestration_runs
       WHERE requested_by_user_id=$1 AND research_case_id=$2 AND idempotency_key=$3`,
      [actor.id, researchCase.id, idempotencyKey],
    );
    if (existing.rows[0]) {
      return (await getResearchCaseJob(client, existing.rows[0].job_id, researchCase.id))!;
    }
    await client.query(
      `UPDATE insight.research_case_orchestration_runs run
       SET status=job.status,failure_code=coalesce(job.error_code,'JOB_TERMINATED'),
           completed_at=coalesce(job.completed_at,clock_timestamp()),updated_at=clock_timestamp()
       FROM insight.jobs job
       WHERE run.job_id=job.id AND run.research_case_id=$1 AND run.status='RUNNING'
         AND job.status IN ('FAILED','CANCELLED')`,
      [researchCase.id],
    );
    const active = await client.query<{ job_id: string }>(
      `SELECT job_id FROM insight.research_case_orchestration_runs
       WHERE research_case_id=$1 AND status='RUNNING'`,
      [researchCase.id],
    );
    if (active.rows[0]) {
      return (await getResearchCaseJob(client, active.rows[0].job_id, researchCase.id))!;
    }

    const runId = randomUUID();
    const jobId = randomUUID();
    const inputRevision = Number(researchCase.input_revision);
    const dependencyManifest = await loadDependencyManifest(client, researchCase);
    const dependencyFingerprint = sha256(JSON.stringify(dependencyManifest));
    const payloadReference = `orchestration:${runId}`;
    const commandFingerprint = sha256(
      JSON.stringify([
        RESEARCH_CASE_ORCHESTRATION_JOB,
        researchCase.id,
        actor.id,
        inputRevision,
        dependencyFingerprint,
        payloadReference,
      ]),
    );
    await client.query(
      `INSERT INTO insight.jobs
         (id,job_type,research_case_id,requested_by_user_id,requested_workflow_state,
          input_fingerprint,dependency_fingerprint,command_fingerprint,payload_reference,
          idempotency_key,max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,3)`,
      [
        jobId,
        RESEARCH_CASE_ORCHESTRATION_JOB,
        researchCase.id,
        actor.id,
        researchCase.workflow_state,
        sha256(`${researchCase.id}:${researchCase.workflow_revision}:${inputRevision}`),
        dependencyFingerprint,
        commandFingerprint,
        payloadReference,
        idempotencyKey,
      ],
    );
    await client.query(
      "INSERT INTO insight.job_events (job_id,sequence,event_type) VALUES ($1,1,'QUEUED')",
      [jobId],
    );
    await client.query(
      `INSERT INTO insight.research_case_orchestration_runs
         (id,job_id,research_case_id,requested_by_user_id,idempotency_key,input_revision,
           dependency_fingerprint,dependency_manifest,current_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        jobId,
        researchCase.id,
        actor.id,
        idempotencyKey,
        inputRevision,
        dependencyFingerprint,
        dependencyManifest,
        researchCase.workflow_state,
      ],
    );
    return (await getResearchCaseJob(client, jobId, researchCase.id))!;
  });
}

export function createOrchestrationJobHandler(
  pool: Pool,
  executeStage: OrchestrationStageExecutor,
): JobHandler {
  return {
    execute: async (claim, progress) => {
      const run = await loadRun(pool, claim);
      await pool.query(
        `UPDATE insight.research_case_orchestration_runs
         SET status='RUNNING',failure_code=NULL,updated_at=clock_timestamp()
         WHERE id=$1 AND status IN ('RUNNING','FAILED')`,
        [run.id],
      );
      for (;;) {
        const researchCase = await loadCase(pool, run.research_case_id);
        if (Number(researchCase.input_revision) !== Number(run.input_revision)) {
          await cancelStaleRun(pool, run, claim, researchCase);
          throw new OrchestrationStaleError();
        }
        if (researchCase.workflow_state === "CLINICIAN_REVIEW") {
          await finishRun(pool, run.id, claim);
          return;
        }
        const stage = STAGES[researchCase.workflow_state];
        if (!stage) throw new OrchestrationUnavailableError();
        await progress({ code: researchCase.workflow_state });

        const accepted = await acceptedResult(
          pool,
          researchCase,
          stage.resultType,
          run.dependency_fingerprint,
        );
        if (!accepted) {
          const attemptNumber = await nextAttempt(pool, run.id, researchCase);
          try {
            const result = await executeStage({
              runId: run.id,
              jobId: run.job_id,
              researchCaseId: run.research_case_id,
              requestedByUserId: run.requested_by_user_id,
              workflowState: researchCase.workflow_state,
              workflowRevision: Number(researchCase.workflow_revision),
              inputRevision: Number(researchCase.input_revision),
              dependencyFingerprint: run.dependency_fingerprint,
              dependencyManifest: run.dependency_manifest,
              idempotencyKey: `${run.id}:${researchCase.workflow_state}`,
            });
            validateAcceptedResult(result, stage.resultType, researchCase, run);
            await commitStage(pool, run, claim, researchCase, stage, attemptNumber, result);
          } catch (error) {
            if (error instanceof OrchestrationStaleError) throw error;
            await recordFailedAttempt(pool, run, claim, researchCase, attemptNumber, error);
            throw error;
          }
        } else {
          await commitStage(pool, run, claim, researchCase, stage, null, null);
        }
      }
    },
    resolveDomainResult: async (client, claim) => resolveRun(client, claim),
  };
}

async function loadDependencyManifest(
  client: PoolClient,
  researchCase: CaseRow,
): Promise<Readonly<Record<string, unknown>>> {
  const endpoint = (
    await client.query<{ version: number; model: string; configuration_fingerprint: string }>(
      `SELECT configuration.version,configuration.model,configuration.configuration_fingerprint
       FROM insight.model_endpoint_state state
       JOIN insight.model_endpoint_configurations configuration
         ON configuration.id=state.current_configuration_id
       WHERE state.singleton=true AND state.status='COMPATIBLE'`,
    )
  ).rows[0];
  const catalog = (
    await client.query<{ id: string; version: number }>(
      `SELECT version.id,version.version FROM insight.medication_catalog_state state
       JOIN insight.medication_catalog_versions version ON version.id=state.active_version_id
       WHERE state.singleton=true`,
    )
  ).rows[0];
  const ddiSources = (
    await client.query<{ id: string; version: number; content_hash: string }>(
      `SELECT source.id,source.version,source.content_hash
       FROM insight.ddi_active_sources active
       JOIN insight.ddi_source_versions source ON source.id=active.source_version_id
       ORDER BY active.drug_identity`,
    )
  ).rows;
  const bnModels = (
    await client.query<{
      id: string;
      pathway_identity: string;
      version: number;
      content_sha256: string;
    }>(
      `SELECT model.id,model.pathway_identity,model.version,artifact.content_sha256
       FROM insight.bn_active_models active
       JOIN insight.bn_model_versions model ON model.id=active.model_version_id
       JOIN insight.bn_model_artifacts artifact ON artifact.id=model.artifact_id
       ORDER BY active.pathway_identity`,
    )
  ).rows;
  return {
    orchestratorVersion: "1.0.0",
    researchCaseRevision: Number(researchCase.workflow_revision),
    inputRevision: Number(researchCase.input_revision),
    endpoint: endpoint
      ? {
          version: endpoint.version,
          model: endpoint.model,
          fingerprint: endpoint.configuration_fingerprint,
        }
      : null,
    medicationCatalog: catalog ?? null,
    ddiSources,
    bnModels,
  };
}

async function loadRun(pool: Pool, claim: JobClaim): Promise<RunRow> {
  const id = claim.payloadReference.match(/^orchestration:([0-9a-f-]{36})$/)?.[1];
  if (!id) throw new OrchestrationUnavailableError();
  const result = await pool.query<RunRow>(
    "SELECT * FROM insight.research_case_orchestration_runs WHERE id=$1 AND job_id=$2",
    [id, claim.job.id],
  );
  if (!result.rows[0]) throw new OrchestrationUnavailableError();
  return result.rows[0];
}

async function loadCase(pool: Pool, researchCaseId: string): Promise<CaseRow> {
  const result = await pool.query<CaseRow>(
    `SELECT id,patient_id,workflow_state,workflow_revision,input_revision
     FROM insight.research_cases WHERE id=$1`,
    [researchCaseId],
  );
  if (!result.rows[0]) throw new OrchestrationUnavailableError();
  return result.rows[0];
}

async function acceptedResult(
  pool: Pool,
  researchCase: CaseRow,
  type: DomainResultType,
  dependencyFingerprint: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM insight.research_case_domain_results
     WHERE research_case_id=$1 AND result_type=$2 AND status='SUCCEEDED'
       AND workflow_revision=$3 AND input_revision=$4 AND invalidated_at IS NULL
       AND provenance->>'dependencyFingerprint'=$5 LIMIT 1`,
    [
      researchCase.id,
      type,
      researchCase.workflow_revision,
      researchCase.input_revision,
      dependencyFingerprint,
    ],
  );
  return result.rowCount === 1;
}

function validateAcceptedResult(
  result: AcceptedOrchestrationResult,
  expectedType: DomainResultType,
  researchCase: CaseRow,
  run: RunRow,
): void {
  if (
    result.status !== "SUCCEEDED" ||
    result.resultType !== expectedType ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(result.resultReference) ||
    result.provenance.accepted !== true ||
    result.provenance.researchCaseRevision !== Number(researchCase.workflow_revision) ||
    result.provenance.inputRevision !== Number(researchCase.input_revision) ||
    result.provenance.dependencyFingerprint !== run.dependency_fingerprint ||
    JSON.stringify(result.provenance.dependencyManifest) !== JSON.stringify(run.dependency_manifest)
  ) {
    throw new OrchestrationUnavailableError();
  }
}

async function nextAttempt(pool: Pool, runId: string, researchCase: CaseRow): Promise<number> {
  const result = await pool.query<{ attempt: number }>(
    `SELECT coalesce(max(attempt_number),0)::integer+1 AS attempt
     FROM insight.research_case_orchestration_attempts
     WHERE run_id=$1 AND workflow_state=$2 AND workflow_revision=$3`,
    [runId, researchCase.workflow_state, researchCase.workflow_revision],
  );
  return result.rows[0]!.attempt;
}

async function commitStage(
  pool: Pool,
  run: RunRow,
  claim: JobClaim,
  researchCase: CaseRow,
  stage: { resultType: DomainResultType; command: WorkflowCommand; to: WorkflowState },
  attempt: number | null,
  result: AcceptedOrchestrationResult | null,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockClaim(client, claim);
    const locked = await client.query<CaseRow>(
      `SELECT id,patient_id,workflow_state,workflow_revision,input_revision
       FROM insight.research_cases WHERE id=$1 FOR UPDATE`,
      [run.research_case_id],
    );
    const current = locked.rows[0];
    if (
      !current ||
      current.workflow_state !== researchCase.workflow_state ||
      Number(current.workflow_revision) !== Number(researchCase.workflow_revision) ||
      Number(current.input_revision) !== Number(run.input_revision)
    ) {
      throw new OrchestrationStaleError();
    }

    let domainResultId: string;
    if (result && attempt !== null) {
      await client.query(
        `INSERT INTO insight.research_case_orchestration_attempts
           (run_id,workflow_state,workflow_revision,input_revision,attempt_number,status,
            result_type,result_reference,dependency_fingerprint,provenance)
         VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9)`,
        [
          run.id,
          current.workflow_state,
          current.workflow_revision,
          current.input_revision,
          attempt,
          result.resultType,
          result.resultReference,
          run.dependency_fingerprint,
          result.provenance,
        ],
      );
      await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
      domainResultId = (
        await client.query<{ id: string }>(
          `INSERT INTO insight.research_case_domain_results
             (research_case_id,result_type,status,workflow_revision,input_revision,
              result_reference,provenance,recorded_by_user_id)
           VALUES ($1,$2,'SUCCEEDED',$3,$4,$5,$6,$7) RETURNING id`,
          [
            run.research_case_id,
            result.resultType,
            current.workflow_revision,
            current.input_revision,
            result.resultReference,
            result.provenance,
            run.requested_by_user_id,
          ],
        )
      ).rows[0]!.id;
    } else {
      const accepted = await client.query<{ id: string }>(
        `SELECT id FROM insight.research_case_domain_results
         WHERE research_case_id=$1 AND result_type=$2 AND status='SUCCEEDED'
           AND workflow_revision=$3 AND input_revision=$4 AND invalidated_at IS NULL
           AND provenance->>'dependencyFingerprint'=$5
         ORDER BY recorded_at DESC,id DESC LIMIT 1`,
        [
          run.research_case_id,
          stage.resultType,
          current.workflow_revision,
          current.input_revision,
          run.dependency_fingerprint,
        ],
      );
      if (!accepted.rows[0]) throw new OrchestrationStaleError();
      domainResultId = accepted.rows[0].id;
      await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
    }
    if (current.workflow_state === "DATA_COLLECTION") {
      const ready = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM insight.research_case_assessments
         WHERE research_case_id=$1 AND status IN ('COMPLETED','BYPASSED')`,
        [current.id],
      );
      if (ready.rows[0]?.count !== 3) throw new OrchestrationUnavailableError();
    }
    await client.query(
      `UPDATE insight.research_cases
       SET workflow_state=$2,workflow_revision=workflow_revision+1,
           updated_by_user_id=$3,updated_at=clock_timestamp()
       WHERE id=$1`,
      [current.id, stage.to, run.requested_by_user_id],
    );
    await client.query(
      `INSERT INTO insight.research_case_transition_events
         (research_case_id,patient_id,command,from_state,to_state,from_revision,to_revision,
          input_revision,actor_user_id,request_id,domain_result_ids,provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$6::bigint+1,$7,$8,$9,$10,$11)`,
      [
        current.id,
        current.patient_id,
        stage.command,
        current.workflow_state,
        stage.to,
        current.workflow_revision,
        current.input_revision,
        run.requested_by_user_id,
        run.id,
        [domainResultId],
        { command: stage.command, domainResultIds: [domainResultId] },
      ],
    );
    await client.query(
      `UPDATE insight.research_case_orchestration_runs
       SET current_state=$2::insight.research_case_workflow_state,
           status=CASE WHEN $2::text='CLINICIAN_REVIEW' THEN 'SUCCEEDED' ELSE status END,
           completed_at=CASE WHEN $2::text='CLINICIAN_REVIEW' THEN clock_timestamp() ELSE completed_at END,
           updated_at=clock_timestamp() WHERE id=$1`,
      [run.id, stage.to],
    );
  });
}

async function recordFailedAttempt(
  pool: Pool,
  run: RunRow,
  claim: JobClaim,
  researchCase: CaseRow,
  attempt: number,
  error: unknown,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockClaim(client, claim);
    await client.query(
      `INSERT INTO insight.research_case_orchestration_attempts
       (run_id,workflow_state,workflow_revision,input_revision,attempt_number,status,
        result_type,dependency_fingerprint,provenance,error_code)
     VALUES ($1,$2,$3,$4,$5,'FAILED',$6,$7,$8,'DOMAIN_STAGE_FAILED')`,
      [
        run.id,
        researchCase.workflow_state,
        researchCase.workflow_revision,
        researchCase.input_revision,
        attempt,
        STAGES[researchCase.workflow_state]!.resultType,
        run.dependency_fingerprint,
        { errorName: error instanceof Error ? error.name : "Error" },
      ],
    );
    await client.query(
      `UPDATE insight.research_case_orchestration_runs
       SET status=CASE WHEN $2 >= $3 THEN 'FAILED' ELSE status END,
           failure_code=CASE WHEN $2 >= $3 THEN 'DOMAIN_STAGE_FAILED' ELSE failure_code END,
           updated_at=clock_timestamp() WHERE id=$1`,
      [run.id, claim.attempt, claim.job.maxAttempts],
    );
  });
}

async function lockClaim(client: PoolClient, claim: JobClaim): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM insight.jobs
     WHERE id=$1 AND status='RUNNING' AND lease_owner=$2 AND attempt_count=$3
       AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [claim.job.id, claim.leaseOwner, claim.attempt],
  );
  if (result.rowCount !== 1) throw new OrchestrationStaleError();
}

async function finishRun(pool: Pool, runId: string, claim: JobClaim): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockClaim(client, claim);
    await client.query(
      `UPDATE insight.research_case_orchestration_runs
       SET status='SUCCEEDED',current_state='CLINICIAN_REVIEW',completed_at=clock_timestamp(),
           updated_at=clock_timestamp() WHERE id=$1`,
      [runId],
    );
  });
}

async function cancelStaleRun(
  pool: Pool,
  run: RunRow,
  claim: JobClaim,
  observed: CaseRow,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockClaim(client, claim);
    await client.query(
      `INSERT INTO insight.research_case_orchestration_attempts
         (run_id,workflow_state,workflow_revision,input_revision,attempt_number,status,
          result_type,dependency_fingerprint,provenance,error_code)
       SELECT $1,$2,$3,$4,coalesce(max(attempt_number),0)+1,'CANCELLED',$5,$6,$7,
              'STALE_RESEARCH_CASE_REVISION'
       FROM insight.research_case_orchestration_attempts WHERE run_id=$1`,
      [
        run.id,
        run.current_state,
        observed.workflow_revision,
        run.input_revision,
        STAGES[run.current_state]?.resultType ?? null,
        run.dependency_fingerprint,
        {
          expectedInputRevision: Number(run.input_revision),
          observedInputRevision: Number(observed.input_revision),
        },
      ],
    );
    await client.query(
      `UPDATE insight.research_case_orchestration_runs
       SET status='CANCELLED',failure_code='STALE_RESEARCH_CASE_REVISION',
           completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [run.id],
    );
    await client.query(
      `UPDATE insight.jobs SET status='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,
         error_code='CANCELLED',error_message='Job was cancelled.',
         completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=$1 AND status='RUNNING' AND lease_owner=$2 AND attempt_count=$3`,
      [claim.job.id, claim.leaseOwner, claim.attempt],
    );
    await client.query(
      `INSERT INTO insight.job_events (job_id,sequence,event_type)
       SELECT $1,coalesce(max(sequence),0)+1,'CANCELLED'
       FROM insight.job_events WHERE job_id=$1`,
      [claim.job.id],
    );
    await client.query(
      `UPDATE insight.model_agent_executions SET status='CANCELLED',
         failure_code='STALE_RESEARCH_CASE_REVISION',completed_at=clock_timestamp(),
         updated_at=clock_timestamp()
       WHERE job_id=$1 AND status IN ('PENDING','RUNNING')`,
      [claim.job.id],
    );
  });
}

async function resolveRun(client: PoolClient, claim: JobClaim): Promise<DomainJobResult> {
  const result = await client.query<RunRow>(
    "SELECT * FROM insight.research_case_orchestration_runs WHERE job_id=$1",
    [claim.job.id],
  );
  const run = result.rows[0];
  if (!run) return { status: "MISSING" };
  if (run.status !== "SUCCEEDED") return { status: "FAILED" };
  return {
    status: "SUCCEEDED",
    resultReference: `orchestration-run:${run.id}`,
    provenanceReference: `orchestration-attempts:${run.id}`,
  };
}

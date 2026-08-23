import { createHash, randomUUID } from "node:crypto";

import { type JobRecord, type JsonValue } from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { DeidentificationGateway, type TrustedToolContext } from "../deidentification/gateway.js";
import {
  MODEL_VISIBLE_PROJECTION_SCHEMA,
  type ModelVisibleProjection,
} from "../deidentification/projections.js";
import { withTransaction } from "../database/transaction.js";
import {
  getOwnedJob,
  getResearchCaseJob,
  type DomainJobResult,
  type JobClaim,
} from "../jobs/jobs.js";
import type { JobHandler } from "../jobs/runner.js";
import { InternalMcpGateway } from "../mcp/gateway.js";
import {
  DEFAULT_MODEL_AGENT_SETTINGS,
  MODEL_AGENT_PROMPT_VERSION,
  pinModelAgent,
  runDurableModelAgent,
} from "../mcp/runtime.js";
import {
  getActiveModelEndpointForExecution,
  getPinnedModelEndpointForExecution,
} from "../model-endpoint/configuration.js";
import type { PatientActor } from "../patient/patients.js";
import { MODEL_TOOLS_BY_STATE } from "../patient/workflow.js";
import {
  commitMedicationMapping,
  createMedicationToolHandlers,
  searchMedicationCandidates,
} from "./catalog.js";

export const MEDICATION_NORMALIZATION_JOB = "MEDICATION_NORMALIZATION";
const PROMPT = `Normalize every PENDING medication in the supplied bounded projection.
For each entry, call medication.search_candidates with its exact entry reference and medication text.
Then call medication.commit_mapping with one returned canonical ID, or null when no usable unambiguous match exists.
Do not ask for confirmation. Do not leave any entry pending. Return {"completed":true} only after every entry is committed.`;
const OUTPUT_SCHEMA = Type.Object(
  { completed: Type.Literal(true) },
  { $id: "insight.medication-normalization-output.v1", additionalProperties: false },
);

interface CaseRow extends QueryResultRow {
  id: string;
  workflow_state: string;
  workflow_revision: string;
  input_revision: string;
  history_revision: string;
  medication_count: string;
}

interface RunRow extends QueryResultRow {
  id: string;
  job_id: string;
  research_case_id: string;
  requested_by_user_id: string;
  workflow_revision: string;
  input_revision: string;
  medical_history_revision: string;
  execution_id: string;
  endpoint_configuration_id: string | null;
  endpoint_configuration_version: number | null;
  endpoint_fingerprint: string | null;
  catalog_version_id: string | null;
  catalog_version: number | null;
  projection: ModelVisibleProjection;
}

export class MedicationNormalizationUnavailableError extends Error {}

export async function startMedicationNormalization(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<JobRecord> {
  requirePsychiatrist(actor);
  return withTransaction(pool, async (client) => {
    const researchCase = await loadCase(client, patientId, true);
    if (!researchCase || researchCase.workflow_state !== "NORMALIZING_MEDICATIONS") {
      throw new MedicationNormalizationUnavailableError();
    }
    const active = await activeCurrentJob(client, researchCase);
    if (active) {
      return (await getResearchCaseJob(client, active.job_id, researchCase.id))!;
    }

    const jobId = randomUUID();
    const executionId = randomUUID();
    const deidentification = new DeidentificationGateway(pool);
    const context = await deidentification.issueSubject({ patientId, executionId, jobId }, actor);
    const projected = await deidentification.getContext(context, {});
    deidentification.revokeSubject(context.subjectRef);
    if (!projected.ok || projected.data.projectionType !== "MEDICATION_NORMALIZATION") {
      throw new MedicationNormalizationUnavailableError();
    }
    const projection = projected.data;
    const empty = Number(researchCase.medication_count) === 0;
    const endpoint = empty ? null : await getActiveModelEndpointForExecution(client);
    const catalog = empty
      ? null
      : (
          await client.query<{ id: string; version: number }>(
            `SELECT version.id,version.version FROM insight.medication_catalog_state state
             JOIN insight.medication_catalog_versions version ON version.id=state.active_version_id
             WHERE state.singleton=true`,
          )
        ).rows[0];
    if (!empty && !catalog) throw new MedicationNormalizationUnavailableError();
    const dependencyFingerprint = sha256(
      empty
        ? "empty-medication-set"
        : `${endpoint!.configurationFingerprint}:medication-catalog-${catalog!.version}`,
    );
    const run = await client.query<{ id: string }>(
      `INSERT INTO insight.medication_normalization_runs
         (research_case_id,requested_by_user_id,workflow_revision,input_revision,
          medical_history_revision,execution_id,endpoint_configuration_id,
          endpoint_configuration_version,endpoint_fingerprint,catalog_version_id,catalog_version,
          projection,input_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        researchCase.id,
        actor.id,
        Number(researchCase.workflow_revision),
        Number(researchCase.input_revision),
        Number(researchCase.history_revision),
        executionId,
        endpoint?.configurationId ?? null,
        endpoint?.configurationVersion ?? null,
        endpoint?.configurationFingerprint ?? null,
        catalog?.id ?? null,
        catalog?.version ?? null,
        projection,
        projection.inputFingerprint,
      ],
    );
    const runId = run.rows[0]!.id;
    const commandFingerprint = sha256(
      JSON.stringify([
        MEDICATION_NORMALIZATION_JOB,
        researchCase.id,
        actor.id,
        projection.inputFingerprint,
        dependencyFingerprint,
        `medication-normalization:${runId}`,
        3,
      ]),
    );
    await client.query(
      `INSERT INTO insight.jobs
         (id,job_type,research_case_id,requested_by_user_id,requested_workflow_state,
          input_fingerprint,dependency_fingerprint,command_fingerprint,payload_reference,
          idempotency_key,max_attempts,status,result_reference,provenance_reference,completed_at)
       VALUES ($1,$2,$3,$4,'NORMALIZING_MEDICATIONS',$5,$6,$7,$8,$9,3,$10,$11,$12,$13)`,
      [
        jobId,
        MEDICATION_NORMALIZATION_JOB,
        researchCase.id,
        actor.id,
        projection.inputFingerprint,
        dependencyFingerprint,
        commandFingerprint,
        `medication-normalization:${runId}`,
        runId,
        empty ? "SUCCEEDED" : "QUEUED",
        empty ? `medication-normalization:${runId}` : null,
        empty ? "deterministic:empty-medication-set" : null,
        empty ? new Date() : null,
      ],
    );
    await client.query(
      "INSERT INTO insight.job_events (job_id,sequence,event_type) VALUES ($1,1,'QUEUED')",
      [jobId],
    );
    if (empty) {
      await client.query(
        "INSERT INTO insight.job_events (job_id,sequence,event_type) VALUES ($1,2,'SUCCEEDED')",
        [jobId],
      );
      await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
      await client.query(
        `INSERT INTO insight.research_case_domain_results
           (research_case_id,result_type,status,workflow_revision,input_revision,result_reference,
            provenance,recorded_by_user_id)
         VALUES ($1,'MEDICATION_NORMALIZATION','SUCCEEDED',$2,$3,$4,$5,$6)`,
        [
          researchCase.id,
          researchCase.workflow_revision,
          researchCase.input_revision,
          `medication-normalization:${runId}`,
          { deterministic: true, reason: "EMPTY_MEDICATION_SET" },
          actor.id,
        ],
      );
    }
    await client.query("UPDATE insight.medication_normalization_runs SET job_id=$2 WHERE id=$1", [
      runId,
      jobId,
    ]);
    return (await getOwnedJob(client, jobId, actor.id))!;
  });
}

export async function getMedicationNormalizationJob(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<JobRecord | null> {
  requirePsychiatrist(actor);
  const researchCase = await loadCase(pool, patientId);
  return researchCase ? latestCurrentJob(pool, researchCase) : null;
}

export function createMedicationNormalizationJobHandler(
  pool: Pool,
  request: typeof fetch = fetch,
): JobHandler {
  return {
    async execute(claim, progress) {
      const run = await loadRun(pool, claim);
      await progress({ code: "PREPARING_PROJECTION", completedUnits: 0, totalUnits: 2 });
      if (
        !run.endpoint_configuration_id ||
        !run.endpoint_configuration_version ||
        !run.endpoint_fingerprint ||
        !run.catalog_version
      ) {
        throw new MedicationNormalizationUnavailableError();
      }
      const endpoint = await getPinnedModelEndpointForExecution(
        pool,
        run.endpoint_configuration_id,
        run.endpoint_configuration_version,
        run.endpoint_fingerprint,
      );
      await commitUnmappedAsUnknown(
        pool,
        run,
        endpoint.model,
        claim,
        projectedEntryRefs(run.projection),
      );
      const context = trustedContext(run, claim);
      const handlers = createMedicationToolHandlers(pool);
      const gateway = new InternalMcpGateway({
        ...handlers,
        "research_case.get_context": async () => ({ data: run.projection as unknown as JsonValue }),
      });
      const pin = pinModelAgent({
        executionId: run.execution_id,
        jobId: claim.job.id,
        researchCaseId: run.research_case_id,
        researchCaseRevision: Number(run.workflow_revision),
        inputRevision: Number(run.input_revision),
        workflowState: "NORMALIZING_MEDICATIONS",
        endpoint,
        promptVersion: MODEL_AGENT_PROMPT_VERSION,
        prompt: PROMPT,
        inputSchema: MODEL_VISIBLE_PROJECTION_SCHEMA,
        outputSchema: OUTPUT_SCHEMA,
        input: run.projection as unknown as JsonValue,
        gateway,
        settings: DEFAULT_MODEL_AGENT_SETTINGS,
        context,
      });
      await progress({ code: "NORMALIZING_MEDICATIONS", completedUnits: 1, totalUnits: 2 });
      await runDurableModelAgent(pool, pin, gateway, request, {
        leaseOwner: claim.leaseOwner,
        attempt: claim.attempt,
      });
      await progress({ code: "COMMITTING_MAPPINGS", completedUnits: 2, totalUnits: 2 });
    },
    resolveDomainResult: (client, claim) => resolveNormalizationResult(client, claim),
  };
}

async function resolveNormalizationResult(
  client: PoolClient,
  claim: JobClaim,
): Promise<DomainJobResult> {
  const run = await loadRun(client, claim);
  const current = await client.query(
    `SELECT 1 FROM insight.research_cases
     WHERE id=$1 AND workflow_state='NORMALIZING_MEDICATIONS'
       AND workflow_revision=$2 AND input_revision=$3
     FOR UPDATE`,
    [run.research_case_id, run.workflow_revision, run.input_revision],
  );
  if (current.rowCount !== 1) return { status: "MISSING" };
  const pending = await client.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM insight.current_medication_entries
        WHERE research_case_id=$1 AND normalization_state IS NULL) +
       (SELECT count(*) FROM insight.prior_antipsychotic_trials
        WHERE research_case_id=$1 AND normalization_state IS NULL)
     )::integer AS count`,
    [run.research_case_id],
  );
  if (pending.rows[0]!.count !== 0) return { status: "MISSING" };
  await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO insight.research_case_domain_results
       (research_case_id,result_type,status,workflow_revision,input_revision,result_reference,
        provenance,recorded_by_user_id)
     VALUES ($1,'MEDICATION_NORMALIZATION','SUCCEEDED',$2,$3,$4,$5,$6) RETURNING id`,
    [
      run.research_case_id,
      run.workflow_revision,
      run.input_revision,
      `medication-normalization:${run.id}`,
      { jobId: claim.job.id, executionId: run.execution_id },
      run.requested_by_user_id,
    ],
  );
  return {
    status: "SUCCEEDED",
    resultReference: `domain-result:${inserted.rows[0]!.id}`,
    provenanceReference: `model-execution:${run.execution_id}`,
  };
}

async function loadCase(
  database: Pool | PoolClient,
  patientId: string,
  lock = false,
): Promise<CaseRow | undefined> {
  const result = await database.query<CaseRow>(
    `SELECT research_case.id,research_case.workflow_state,research_case.workflow_revision,
             research_case.input_revision,history.revision AS history_revision,
             ((SELECT count(*) FROM insight.current_medication_entries current_entry
                WHERE current_entry.research_case_id=research_case.id) +
              (SELECT count(*) FROM insight.prior_antipsychotic_trials prior_entry
                WHERE prior_entry.research_case_id=research_case.id))::text AS medication_count
     FROM insight.research_cases research_case
     JOIN insight.medical_histories history ON history.research_case_id=research_case.id
     WHERE research_case.patient_id=$1${lock ? " FOR UPDATE OF research_case" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

async function latestCurrentJob(
  database: Pool | PoolClient,
  researchCase: CaseRow,
): Promise<JobRecord | null> {
  const result = await database.query<{ job_id: string }>(
    `SELECT run.job_id FROM insight.medication_normalization_runs run
     JOIN insight.jobs job ON job.id=run.job_id
     WHERE run.research_case_id=$1 AND run.workflow_revision=$2
       AND run.input_revision=$3 AND run.medical_history_revision=$4
     ORDER BY run.created_at DESC,run.id DESC LIMIT 1`,
    [
      researchCase.id,
      researchCase.workflow_revision,
      researchCase.input_revision,
      researchCase.history_revision,
    ],
  );
  return result.rows[0]
    ? getResearchCaseJob(database, result.rows[0].job_id, researchCase.id)
    : null;
}

async function activeCurrentJob(
  database: Pool | PoolClient,
  researchCase: CaseRow,
): Promise<{ job_id: string } | undefined> {
  const result = await database.query<{ job_id: string }>(
    `SELECT run.job_id
     FROM insight.medication_normalization_runs run
     JOIN insight.jobs job ON job.id=run.job_id
     WHERE run.research_case_id=$1 AND run.workflow_revision=$2
       AND run.input_revision=$3 AND run.medical_history_revision=$4
       AND job.status IN ('QUEUED','RUNNING','SUCCEEDED')
     ORDER BY run.created_at DESC,run.id DESC LIMIT 1`,
    [
      researchCase.id,
      researchCase.workflow_revision,
      researchCase.input_revision,
      researchCase.history_revision,
    ],
  );
  return result.rows[0];
}

async function loadRun(database: Pool | PoolClient, claim: JobClaim): Promise<RunRow> {
  const match = /^medication-normalization:([0-9a-f-]{36})$/.exec(claim.payloadReference);
  if (!match) throw new MedicationNormalizationUnavailableError();
  const result = await database.query<RunRow>(
    "SELECT * FROM insight.medication_normalization_runs WHERE id=$1 AND job_id=$2",
    [match[1], claim.job.id],
  );
  if (!result.rows[0]) throw new MedicationNormalizationUnavailableError();
  return result.rows[0];
}

function trustedContext(run: RunRow, claim: JobClaim): TrustedToolContext {
  return {
    executionId: run.execution_id,
    jobId: claim.job.id,
    subjectRef: run.projection.subjectRef,
    researchCaseRevision: Number(run.workflow_revision),
    workflowState: "NORMALIZING_MEDICATIONS",
    actorRole: "PSYCHIATRIST",
    allowedToolNames: MODEL_TOOLS_BY_STATE.NORMALIZING_MEDICATIONS,
    idempotencyKey: run.id,
    leaseOwner: claim.leaseOwner,
    attempt: claim.attempt,
  };
}

function projectedEntryRefs(projection: ModelVisibleProjection): string[] {
  if (!("medications" in projection.data)) return [];
  return projection.data.medications.map(({ medicationEntryRef }) => medicationEntryRef);
}

async function commitUnmappedAsUnknown(
  pool: Pool,
  run: RunRow,
  model: string,
  claim: JobClaim,
  includedRefs?: readonly string[],
): Promise<void> {
  const included = new Set(includedRefs);
  const execution = {
    executionId: run.execution_id,
    researchCaseId: run.research_case_id,
    model,
    promptVersion: MODEL_AGENT_PROMPT_VERSION,
    schemaVersion: "medication-tools-1.0.0",
    catalogVersion: run.catalog_version!,
    researchCaseRevision: Number(run.workflow_revision),
    inputRevision: Number(run.input_revision),
    leaseOwner: claim.leaseOwner,
    attempt: claim.attempt,
    jobId: claim.job.id,
  };
  for (const target of [
    { table: "current_medication_entries", column: "raw_medication", prefix: "current" },
    { table: "prior_antipsychotic_trials", column: "medication", prefix: "prior" },
  ] as const) {
    const entries = await pool.query<{ position: number; raw_text: string }>(
      `SELECT position,${target.column} AS raw_text FROM insight.${target.table}
       WHERE research_case_id=$1 AND normalization_state IS NULL ORDER BY position`,
      [run.research_case_id],
    );
    for (const entry of entries.rows) {
      const ref = `${target.prefix}-${entry.position + 1}`;
      if (includedRefs && included.has(ref)) continue;
      const searched = await searchMedicationCandidates(pool, execution, ref, entry.raw_text);
      await commitMedicationMapping(pool, execution, ref, searched.catalogVersion, null);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST") throw new MedicationNormalizationUnavailableError();
}

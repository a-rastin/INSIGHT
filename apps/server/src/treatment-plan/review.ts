import { createHash, randomUUID } from "node:crypto";

import {
  ClinicianRegimenInputSchema,
  stableSerialize,
  type ClinicianRegimenMedication,
  type JsonValue,
  type PrimaryTreatmentPlanInput,
  type Role,
} from "@insight/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import {
  evaluateDdiRegimen,
  type DdiExecution,
  type DdiRegimenMedication,
} from "../ddi/evaluation.js";
import type { DomainJobResult } from "../jobs/jobs.js";
import type { JobHandler } from "../jobs/runner.js";

export const FINAL_DDI_RECHECK_JOB = "FINAL_DDI_RECHECK";

export interface TreatmentPlanActor {
  readonly id: string;
  readonly role: Role;
}

export interface RegimenDiff {
  readonly field: string;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
}

export interface FinalDdiReadiness {
  readonly status: "CHECKING" | "BLOCKED" | "READY";
  readonly reason: "PENDING" | "FAILED" | "UNPROVEN" | null;
  readonly executionRef: string | null;
  readonly findings: DdiExecution["findings"];
}

export interface ClinicianReview {
  readonly draftRef: string;
  readonly draftRevision: number;
  readonly aiImputationNoticeVisible: boolean;
  readonly generatedPlan: PrimaryTreatmentPlanInput;
  readonly regimen: readonly ClinicianRegimenMedication[];
  readonly diff: readonly RegimenDiff[];
  readonly readiness: FinalDdiReadiness;
  readonly catalog: readonly { canonicalMedicationId: string; preferredName: string }[];
  readonly primaryDdiExecutionRef: string;
  readonly updatedAt: string;
}

interface DraftRow extends QueryResultRow {
  research_case_id: string;
  draft_ref: string;
  revision: string;
  plan_payload: PrimaryTreatmentPlanInput;
  clinician_regimen: ClinicianRegimenMedication[] | null;
  regimen_fingerprint: string | null;
  final_ddi_execution_ref: string | null;
  primary_ddi_execution_ref: string;
  ai_imputation_notice_visible: boolean;
  workflow_revision: string;
  input_revision: string;
  updated_at: Date;
  workflow_state: string;
}

interface RecheckRow extends QueryResultRow {
  job_id: string;
  research_case_id: string;
  draft_ref: string;
  draft_revision: string;
  regimen_fingerprint: string;
  exact_regimen: DdiRegimenMedication[];
  workflow_revision: string;
  input_revision: string;
  requested_by_user_id: string;
  execution_ref: string | null;
}

const sha256 = (value: JsonValue): string =>
  createHash("sha256").update(stableSerialize(value)).digest("hex");

const generatedRegimen = (plan: PrimaryTreatmentPlanInput): ClinicianRegimenMedication[] =>
  plan.regimen.map(({ canonicalMedicationId, dose, route, frequency, titration, monitoring }) => ({
    canonicalMedicationId,
    dose,
    route,
    frequency,
    ...(titration ? { titration } : {}),
    monitoring,
  }));

export function regimenFingerprint(regimen: readonly DdiRegimenMedication[]): string {
  return sha256(
    [...regimen]
      .map(({ kind, normalizationState, canonicalId, regimenDetails }) => ({
        kind,
        normalizationState,
        canonicalId: canonicalId ?? null,
        regimenDetails: regimenDetails ?? null,
      }))
      .sort((left, right) =>
        stableSerialize(left as unknown as JsonValue).localeCompare(
          stableSerialize(right as unknown as JsonValue),
        ),
      ) as unknown as JsonValue,
  );
}

export async function saveClinicianRegimen(
  pool: Pool,
  actor: TreatmentPlanActor,
  patientId: string,
  regimen: readonly ClinicianRegimenMedication[],
  now = new Date(),
): Promise<ClinicianReview> {
  requirePsychiatrist(actor);
  if (!Value.Check(ClinicianRegimenInputSchema, { schemaVersion: "1", regimen })) {
    throw new ClinicianRegimenInputError();
  }

  await withTransaction(pool, async (client) => {
    const row = await loadDraft(client, patientId, true);
    if (!row) throw new TreatmentPlanNotFoundError();
    if (row.workflow_state === "FINALIZED" || row.workflow_state === "DELETED") {
      throw new ClinicianRegimenInputError();
    }
    await validateCanonicalMedications(client, regimen);
    const exactRegimen = await exactDdiRegimen(client, row.research_case_id, regimen);
    const fingerprint = regimenFingerprint(exactRegimen);
    const current = row.clinician_regimen ?? generatedRegimen(row.plan_payload);
    const unchanged =
      stableSerialize(current as unknown as JsonValue) ===
      stableSerialize(regimen as unknown as JsonValue);

    let revision = Number(row.revision);
    if (!unchanged) {
      revision += 1;
      await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
      await client.query(
        `UPDATE insight.primary_treatment_plan_drafts
         SET revision=$2,clinician_regimen=$3,regimen_fingerprint=$4,
             final_ddi_execution_ref=CASE WHEN regimen_fingerprint=$4
               THEN final_ddi_execution_ref ELSE NULL END,
             updated_by_user_id=$5,updated_at=$6
         WHERE research_case_id=$1`,
        [row.research_case_id, revision, JSON.stringify(regimen), fingerprint, actor.id, now],
      );
    } else if (!row.regimen_fingerprint) {
      await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
      await client.query(
        `UPDATE insight.primary_treatment_plan_drafts
         SET regimen_fingerprint=$2,updated_by_user_id=$3,updated_at=$4
         WHERE research_case_id=$1`,
        [row.research_case_id, fingerprint, actor.id, now],
      );
    }

    const changedMedication =
      row.regimen_fingerprint !== null && row.regimen_fingerprint !== fingerprint;
    const eligible = await hasEligibleRecheck(client, row.research_case_id, revision, fingerprint);
    if (changedMedication || !eligible) {
      await enqueueFinalRecheck(client, row, revision, fingerprint, exactRegimen, actor.id, now);
    }
  });
  return (await getClinicianReview(pool, actor, patientId))!;
}

export async function getClinicianReview(
  pool: Pool,
  actor: TreatmentPlanActor,
  patientId: string,
): Promise<ClinicianReview | null> {
  requirePsychiatrist(actor);
  const row = await loadDraft(pool, patientId, false);
  if (!row) return null;
  const regimen = row.clinician_regimen ?? generatedRegimen(row.plan_payload);
  return {
    draftRef: row.draft_ref,
    draftRevision: Number(row.revision),
    aiImputationNoticeVisible: row.ai_imputation_notice_visible,
    generatedPlan: row.plan_payload,
    regimen,
    diff: explicitDiff(generatedRegimen(row.plan_payload), regimen),
    readiness: await evaluateReadiness(pool, row),
    catalog: await loadCatalog(pool),
    primaryDdiExecutionRef: row.primary_ddi_execution_ref,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createFinalDdiRecheckJobHandler(pool: Pool): JobHandler {
  return {
    execute: async (claim, progress) => {
      const recheck = await loadRecheck(pool, claim.job.id);
      await progress({ code: "EVALUATING_FINAL_REGIMEN" });
      const output = await evaluateDdiRegimen(
        pool,
        {
          toolExecutionId: claim.job.id,
          researchCaseId: recheck.research_case_id,
          requestedByUserId: recheck.requested_by_user_id,
          workflowRevision: Number(recheck.workflow_revision),
          inputRevision: Number(recheck.input_revision),
        },
        "FINAL_RECHECK",
        recheck.exact_regimen.map(({ medicationEntryRef }) => medicationEntryRef),
        recheck.exact_regimen,
      );
      await bindFinalDdiExecution(pool, claim.job.id, output.executionRef);
    },
    resolveDomainResult: async (client, claim): Promise<DomainJobResult> => {
      const result = await client.query<{ execution_ref: string | null }>(
        "SELECT execution_ref FROM insight.final_ddi_rechecks WHERE job_id=$1",
        [claim.job.id],
      );
      return result.rows[0]?.execution_ref
        ? {
            status: "SUCCEEDED",
            resultReference: result.rows[0].execution_ref,
            provenanceReference: result.rows[0].execution_ref,
          }
        : { status: "MISSING" };
    },
  };
}

export async function bindFinalDdiExecution(
  pool: Pool,
  jobId: string,
  executionRef: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const recheckResult = await client.query<RecheckRow>(
      "SELECT * FROM insight.final_ddi_rechecks WHERE job_id=$1 FOR UPDATE",
      [jobId],
    );
    const recheck = recheckResult.rows[0];
    if (!recheck) throw new Error("Final DDI recheck was not found.");
    const execution = await client.query<{
      research_case_id: string;
      purpose: string;
      exact_regimen: DdiRegimenMedication[];
    }>(
      `SELECT research_case_id,purpose,exact_regimen FROM insight.ddi_executions
       WHERE execution_ref=$1`,
      [executionRef],
    );
    const checked = execution.rows[0];
    if (
      !checked ||
      checked.research_case_id !== recheck.research_case_id ||
      checked.purpose !== "FINAL_RECHECK" ||
      regimenFingerprint(checked.exact_regimen) !== recheck.regimen_fingerprint
    ) {
      throw new Error("Final DDI execution does not prove the pinned regimen.");
    }
    await client.query(
      `UPDATE insight.final_ddi_rechecks
       SET execution_ref=$2,completed_at=clock_timestamp() WHERE job_id=$1`,
      [jobId, executionRef],
    );
    await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
    const bound = await client.query(
      `UPDATE insight.primary_treatment_plan_drafts
       SET final_ddi_execution_ref=$2
       WHERE research_case_id=$1 AND regimen_fingerprint=$3`,
      [recheck.research_case_id, executionRef, recheck.regimen_fingerprint],
    );
    return bound.rowCount === 1;
  });
}

async function loadDraft(
  database: Pool | PoolClient,
  patientId: string,
  lock: boolean,
): Promise<DraftRow | undefined> {
  const result = await database.query<DraftRow>(
    `SELECT draft.*,research_case.workflow_state
     FROM insight.primary_treatment_plan_drafts draft
     JOIN insight.research_cases research_case ON research_case.id=draft.research_case_id
     WHERE research_case.patient_id=$1${lock ? " FOR UPDATE OF draft" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

async function validateCanonicalMedications(
  client: PoolClient,
  regimen: readonly ClinicianRegimenMedication[],
): Promise<void> {
  const ids = regimen.map(({ canonicalMedicationId }) => canonicalMedicationId);
  if (new Set(ids.map((id) => id.toLocaleLowerCase("en-US"))).size !== ids.length) {
    throw new ClinicianRegimenInputError();
  }
  const found = await client.query<{ canonical_id: string }>(
    `SELECT entry.canonical_id FROM insight.medication_catalog_state state
     JOIN insight.medication_catalog_entries entry ON entry.catalog_version_id=state.active_version_id
     WHERE entry.canonical_id=ANY($1::text[])`,
    [ids],
  );
  if (found.rowCount !== ids.length) throw new ClinicianRegimenInputError();
}

async function exactDdiRegimen(
  client: PoolClient,
  researchCaseId: string,
  regimen: readonly ClinicianRegimenMedication[],
): Promise<DdiRegimenMedication[]> {
  const current = await client.query<{
    position: number;
    normalization_state: "NORMALIZED" | "UNKNOWN" | null;
    canonical_medication_id: string | null;
  }>(
    `SELECT position,normalization_state,canonical_medication_id
     FROM insight.current_medication_entries WHERE research_case_id=$1
       AND normalization_state IS NOT NULL ORDER BY position`,
    [researchCaseId],
  );
  return [
    ...current.rows.map(({ position, normalization_state, canonical_medication_id }) => ({
      medicationEntryRef: `current-${position + 1}`,
      kind: "CURRENT" as const,
      normalizationState: normalization_state!,
      ...(canonical_medication_id ? { canonicalId: canonical_medication_id } : {}),
    })),
    ...regimen.map((medication, index) => ({
      medicationEntryRef: `final-${index + 1}`,
      kind: "PROPOSED" as const,
      normalizationState: "NORMALIZED" as const,
      canonicalId: medication.canonicalMedicationId,
      regimenDetails: {
        dose: medication.dose,
        route: medication.route,
        frequency: medication.frequency,
        titration: medication.titration ?? null,
        monitoring: medication.monitoring,
      },
    })),
  ];
}

async function hasEligibleRecheck(
  client: PoolClient,
  researchCaseId: string,
  draftRevision: number,
  fingerprint: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM insight.final_ddi_rechecks recheck
     JOIN insight.jobs job ON job.id=recheck.job_id
     WHERE recheck.research_case_id=$1 AND recheck.draft_revision=$2
       AND recheck.regimen_fingerprint=$3
       AND job.status IN ('QUEUED','RUNNING','SUCCEEDED') LIMIT 1`,
    [researchCaseId, draftRevision, fingerprint],
  );
  return Boolean(result.rows[0]);
}

async function enqueueFinalRecheck(
  client: PoolClient,
  row: DraftRow,
  revision: number,
  fingerprint: string,
  exactRegimen: readonly DdiRegimenMedication[],
  userId: string,
  now: Date,
): Promise<void> {
  const jobId = randomUUID();
  const payloadReference = `final-ddi:${row.draft_ref}:${revision}:${fingerprint}`;
  const commandFingerprint = sha256([
    FINAL_DDI_RECHECK_JOB,
    row.research_case_id,
    userId,
    fingerprint,
    payloadReference,
  ] as JsonValue);
  await client.query(
    `INSERT INTO insight.jobs
       (id,job_type,research_case_id,requested_by_user_id,requested_workflow_state,
        input_fingerprint,dependency_fingerprint,command_fingerprint,payload_reference,
        idempotency_key,max_attempts)
     SELECT $1,$2,$3,$4,research_case.workflow_state,$5,$5,$6,$7,$8,3
     FROM insight.research_cases research_case WHERE research_case.id=$3`,
    [
      jobId,
      FINAL_DDI_RECHECK_JOB,
      row.research_case_id,
      userId,
      fingerprint,
      commandFingerprint,
      payloadReference,
      jobId,
    ],
  );
  await client.query(
    "INSERT INTO insight.job_events (job_id,sequence,event_type) VALUES ($1,1,'QUEUED')",
    [jobId],
  );
  await client.query(
    `INSERT INTO insight.final_ddi_rechecks
       (job_id,research_case_id,draft_ref,draft_revision,regimen_fingerprint,exact_regimen,
        workflow_revision,input_revision,requested_by_user_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      jobId,
      row.research_case_id,
      row.draft_ref,
      revision,
      fingerprint,
      JSON.stringify(exactRegimen),
      row.workflow_revision,
      row.input_revision,
      userId,
      now,
    ],
  );
}

async function loadRecheck(pool: Pool, jobId: string): Promise<RecheckRow> {
  const result = await pool.query<RecheckRow>(
    "SELECT * FROM insight.final_ddi_rechecks WHERE job_id=$1",
    [jobId],
  );
  if (!result.rows[0]) throw new Error("Final DDI recheck was not found.");
  return result.rows[0];
}

async function evaluateReadiness(pool: Pool, row: DraftRow): Promise<FinalDdiReadiness> {
  if (row.final_ddi_execution_ref && row.regimen_fingerprint) {
    const execution = await pool.query<{
      findings: DdiExecution["findings"];
      exact_regimen: DdiRegimenMedication[];
    }>(
      `SELECT findings,exact_regimen FROM insight.ddi_executions
       WHERE execution_ref=$1 AND purpose='FINAL_RECHECK'`,
      [row.final_ddi_execution_ref],
    );
    if (
      execution.rows[0] &&
      regimenFingerprint(execution.rows[0].exact_regimen) === row.regimen_fingerprint
    ) {
      return {
        status: "READY",
        reason: null,
        executionRef: row.final_ddi_execution_ref,
        findings: execution.rows[0].findings,
      };
    }
  }
  if (!row.regimen_fingerprint) {
    return { status: "BLOCKED", reason: "UNPROVEN", executionRef: null, findings: [] };
  }
  const latest = await pool.query<{ status: string }>(
    `SELECT job.status FROM insight.final_ddi_rechecks recheck
     JOIN insight.jobs job ON job.id=recheck.job_id
     WHERE recheck.research_case_id=$1 AND recheck.regimen_fingerprint=$2
     ORDER BY recheck.created_at DESC,recheck.id DESC LIMIT 1`,
    [row.research_case_id, row.regimen_fingerprint],
  );
  const status = latest.rows[0]?.status;
  if (status === "QUEUED" || status === "RUNNING") {
    return { status: "CHECKING", reason: "PENDING", executionRef: null, findings: [] };
  }
  return {
    status: "BLOCKED",
    reason: status === "FAILED" || status === "CANCELLED" ? "FAILED" : "UNPROVEN",
    executionRef: null,
    findings: [],
  };
}

function explicitDiff(
  generated: readonly ClinicianRegimenMedication[],
  current: readonly ClinicianRegimenMedication[],
): RegimenDiff[] {
  const fields: RegimenDiff[] = [];
  const count = Math.max(generated.length, current.length);
  for (let index = 0; index < count; index += 1) {
    const before = generated[index] ?? null;
    const after = current[index] ?? null;
    if (stableSerialize(before as JsonValue) !== stableSerialize(after as JsonValue)) {
      fields.push({
        field: `regimen[${index}]`,
        before: before as unknown as JsonValue | null,
        after: after as unknown as JsonValue | null,
      });
    }
  }
  return fields;
}

async function loadCatalog(
  pool: Pool,
): Promise<{ canonicalMedicationId: string; preferredName: string }[]> {
  const result = await pool.query<{ canonical_id: string; preferred_name: string }>(
    `SELECT entry.canonical_id,entry.preferred_name
     FROM insight.medication_catalog_state state
     JOIN insight.medication_catalog_entries entry ON entry.catalog_version_id=state.active_version_id
     ORDER BY entry.preferred_name,entry.canonical_id`,
  );
  return result.rows.map(({ canonical_id, preferred_name }) => ({
    canonicalMedicationId: canonical_id,
    preferredName: preferred_name,
  }));
}

function requirePsychiatrist(actor: TreatmentPlanActor): void {
  if (actor.role !== "PSYCHIATRIST") throw new TreatmentPlanAuthorizationError();
}

export class ClinicianRegimenInputError extends Error {}
export class TreatmentPlanNotFoundError extends Error {}
export class TreatmentPlanAuthorizationError extends Error {}

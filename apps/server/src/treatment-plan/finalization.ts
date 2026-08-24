import { createHash } from "node:crypto";

import {
  ClinicianRegimenInputSchema,
  CURRENT_SCHEMA_VERSION,
  PrimaryTreatmentPlanInputSchema,
  TREATMENT_PLAN_SCHEMA_VERSION,
  stableSerialize,
  type ClinicianRegimenMedication,
  type JsonValue,
  type PrimaryTreatmentPlanInput,
} from "@insight/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { DdiRegimenMedication } from "../ddi/evaluation.js";
import { regimenFingerprint, type TreatmentPlanActor } from "./review.js";

interface CaseRow extends QueryResultRow {
  id: string;
  patient_id: string;
  workflow_state: string;
  workflow_revision: string;
  input_revision: string;
}

interface DraftRow extends QueryResultRow {
  draft_ref: string;
  revision: string;
  schema_version: string;
  plan_payload: PrimaryTreatmentPlanInput;
  clinician_regimen: ClinicianRegimenMedication[] | null;
  regimen_fingerprint: string | null;
  final_ddi_execution_ref: string | null;
}

interface DomainResultRow extends QueryResultRow {
  id: string;
  result_type: string;
  status: "SUCCEEDED" | "FAILED";
  result_reference: string;
  provenance: Readonly<Record<string, unknown>>;
  recorded_at: Date;
}

interface DdiRow extends QueryResultRow {
  exact_regimen: DdiRegimenMedication[];
}

interface FinalRow extends QueryResultRow {
  id: string;
  research_case_id: string;
  sequence: string;
  status: "ACTIVE" | "SUPERSEDED";
  predecessor_id: string | null;
  schema_version: string;
  plan_snapshot: Readonly<Record<string, unknown>>;
  plan_hash: string;
  source_draft_ref: string;
  source_draft_revision: string;
  final_ddi_execution_ref: string;
  provenance: Readonly<Record<string, unknown>>;
  finalized_by_user_id: string;
  finalized_at: Date;
  idempotency_key: string;
}

const REQUIRED_RESULTS = [
  "DATA_COLLECTION_VALIDATED",
  "MEDICATION_NORMALIZATION",
  "BN_ROUTING",
  "CPT_SNAPSHOT",
  "BN_INFERENCE",
  "PRIMARY_DDI",
  "PRIMARY_PLAN",
  "FINAL_DDI",
] as const;

export interface FinalPlanVersion {
  readonly id: string;
  readonly researchCaseId: string;
  readonly sequence: number;
  readonly status: "ACTIVE" | "SUPERSEDED";
  readonly predecessorId: string | null;
  readonly schemaVersion: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly planHash: string;
  readonly sourceDraftRef: string;
  readonly sourceDraftRevision: number;
  readonly finalDdiExecutionRef: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly finalizedByUserId: string;
  readonly finalizedAt: string;
  readonly idempotencyKey: string;
}

export interface FinalPlanRevisionDraft {
  readonly researchCaseId: string;
  readonly predecessorId: string;
  readonly draftRef: string;
  readonly draftRevision: number;
  readonly workflowState: "REVISION_DRAFT";
}

export async function listFinalPlanVersions(
  pool: Pool,
  actor: TreatmentPlanActor,
  patientId: string,
): Promise<FinalPlanVersion[]> {
  if (actor.role !== "PSYCHIATRIST") throw new FinalPlanAuthorizationError();
  const result = await pool.query<FinalRow>(
    `SELECT version.* FROM insight.final_plan_versions version
     JOIN insight.research_cases research_case ON research_case.id=version.research_case_id
     WHERE research_case.patient_id=$1 ORDER BY version.sequence DESC`,
    [patientId],
  );
  if (result.rowCount === 0) {
    const researchCase = await pool.query(
      "SELECT 1 FROM insight.research_cases WHERE patient_id=$1",
      [patientId],
    );
    if (!researchCase.rows[0]) throw new FinalPlanNotFoundError();
  }
  return result.rows.map(materialize);
}

export async function createFinalPlanRevisionDraft(
  pool: Pool,
  actor: TreatmentPlanActor,
  patientId: string,
  requestId: string,
  now = new Date(),
): Promise<FinalPlanRevisionDraft> {
  if (actor.role !== "PSYCHIATRIST") throw new FinalPlanAuthorizationError();

  return withTransaction(pool, async (client) => {
    const researchCase = (
      await client.query<CaseRow>(
        `SELECT id,patient_id,workflow_state,workflow_revision,input_revision
         FROM insight.research_cases WHERE patient_id=$1 FOR UPDATE`,
        [patientId],
      )
    ).rows[0];
    if (!researchCase) throw new FinalPlanNotFoundError();

    const active = (
      await client.query<FinalRow>(
        `SELECT * FROM insight.final_plan_versions
         WHERE research_case_id=$1 AND status='ACTIVE' FOR UPDATE`,
        [researchCase.id],
      )
    ).rows[0];
    if (!active) throw new FinalPlanConflictError();

    const draft = (
      await client.query<DraftRow>(
        `SELECT draft_ref,revision,schema_version,plan_payload,clinician_regimen,
                regimen_fingerprint,final_ddi_execution_ref
         FROM insight.primary_treatment_plan_drafts WHERE research_case_id=$1 FOR UPDATE`,
        [researchCase.id],
      )
    ).rows[0];
    if (!draft) throw new FinalPlanDependencyError();
    if (researchCase.workflow_state === "REVISION_DRAFT") {
      return materializeRevision(researchCase.id, active.id, draft);
    }
    if (researchCase.workflow_state !== "FINALIZED") throw new FinalPlanConflictError();

    const generatedPlan = active.plan_snapshot.generatedPlan;
    const finalRegimen = active.plan_snapshot.finalRegimen;
    if (
      !Value.Check(PrimaryTreatmentPlanInputSchema, generatedPlan) ||
      !Value.Check(ClinicianRegimenInputSchema, {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        regimen: finalRegimen,
      })
    ) {
      throw new FinalPlanSchemaError();
    }

    await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
    const seeded = (
      await client.query<DraftRow>(
        `UPDATE insight.primary_treatment_plan_drafts
         SET revision=revision+1,plan_payload=$2,plan_hash=$3,clinician_regimen=$4,
             regimen_fingerprint=NULL,final_ddi_execution_ref=NULL,
             workflow_revision=$5,updated_by_user_id=$6,updated_at=$7
         WHERE research_case_id=$1 RETURNING *`,
        [
          researchCase.id,
          JSON.stringify(generatedPlan),
          hash(generatedPlan),
          JSON.stringify(finalRegimen),
          Number(researchCase.workflow_revision) + 1,
          actor.id,
          now,
        ],
      )
    ).rows[0]!;

    await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
    await client.query(
      `UPDATE insight.research_cases SET workflow_state='REVISION_DRAFT',
         workflow_revision=workflow_revision+1,updated_by_user_id=$2,updated_at=$3 WHERE id=$1`,
      [researchCase.id, actor.id, now],
    );
    await client.query(
      `INSERT INTO insight.research_case_transition_events
         (research_case_id,patient_id,command,from_state,to_state,from_revision,to_revision,
          input_revision,actor_user_id,request_id,domain_result_ids,provenance,occurred_at)
       VALUES ($1,$2,'CREATE_REVISION_DRAFT','FINALIZED','REVISION_DRAFT',$3::bigint,
               $3::bigint+1,$4,$5,$6,'{}',$7,$8)`,
      [
        researchCase.id,
        researchCase.patient_id,
        Number(researchCase.workflow_revision),
        Number(researchCase.input_revision),
        actor.id,
        requestId,
        { predecessorId: active.id, sourceDraftRevision: Number(active.source_draft_revision) },
        now,
      ],
    );
    return materializeRevision(researchCase.id, active.id, seeded);
  });
}

export async function finalizeTreatmentPlan(
  pool: Pool,
  actor: TreatmentPlanActor,
  patientId: string,
  idempotencyKey: string,
  requestId: string,
  now = new Date(),
): Promise<FinalPlanVersion> {
  if (actor.role !== "PSYCHIATRIST") throw new FinalPlanAuthorizationError();
  if (
    idempotencyKey.trim() !== idempotencyKey ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 200
  ) {
    throw new FinalPlanInputError();
  }

  return withTransaction(pool, async (client) => {
    const researchCase = (
      await client.query<CaseRow>(
        `SELECT id,patient_id,workflow_state,workflow_revision,input_revision
         FROM insight.research_cases WHERE patient_id=$1 FOR UPDATE`,
        [patientId],
      )
    ).rows[0];
    if (!researchCase) throw new FinalPlanNotFoundError();

    const replay = await loadByKey(client, researchCase.id, idempotencyKey);
    if (replay) return materialize(replay);
    if (researchCase.workflow_state !== "READY_TO_FINALIZE") throw new FinalPlanConflictError();

    const draft = (
      await client.query<DraftRow>(
        `SELECT draft_ref,revision,schema_version,plan_payload,clinician_regimen,
                regimen_fingerprint,final_ddi_execution_ref
         FROM insight.primary_treatment_plan_drafts WHERE research_case_id=$1`,
        [researchCase.id],
      )
    ).rows[0];
    if (!draft) throw new FinalPlanDependencyError();
    if (
      draft.schema_version !== TREATMENT_PLAN_SCHEMA_VERSION ||
      !Value.Check(PrimaryTreatmentPlanInputSchema, draft.plan_payload)
    ) {
      throw new FinalPlanSchemaError();
    }
    const regimen = draft.clinician_regimen ?? generatedRegimen(draft.plan_payload);
    if (
      !Value.Check(ClinicianRegimenInputSchema, { schemaVersion: CURRENT_SCHEMA_VERSION, regimen })
    ) {
      throw new FinalPlanSchemaError();
    }

    const ddi = draft.final_ddi_execution_ref
      ? (
          await client.query<DdiRow>(
            `SELECT * FROM insight.ddi_executions
             WHERE execution_ref=$1 AND research_case_id=$2 AND purpose='FINAL_RECHECK'`,
            [draft.final_ddi_execution_ref, researchCase.id],
          )
        ).rows[0]
      : undefined;
    if (
      !ddi ||
      !draft.regimen_fingerprint ||
      regimenFingerprint(ddi.exact_regimen) !== draft.regimen_fingerprint
    ) {
      throw new FinalPlanDependencyError();
    }

    const domainResults = (
      await client.query<DomainResultRow>(
        `SELECT DISTINCT ON (result_type) id,result_type,status,result_reference,provenance,recorded_at
         FROM insight.research_case_domain_results
         WHERE research_case_id=$1 AND input_revision=$2 AND invalidated_at IS NULL
         ORDER BY result_type,recorded_at DESC,id DESC`,
        [researchCase.id, researchCase.input_revision],
      )
    ).rows;
    const latest = new Map(domainResults.map((result) => [result.result_type, result]));
    if (
      domainResults.some(
        ({ status, provenance }) => status !== "SUCCEEDED" || failed(provenance),
      ) ||
      REQUIRED_RESULTS.some((type) => latest.get(type)?.status !== "SUCCEEDED") ||
      latest.get("FINAL_DDI")?.result_reference !== draft.final_ddi_execution_ref
    ) {
      throw new FinalPlanDependencyError();
    }

    const plan = {
      schemaVersion: TREATMENT_PLAN_SCHEMA_VERSION,
      generatedPlan: draft.plan_payload,
      finalRegimen: regimen,
    };
    const provenance = {
      sourceDraft: { ref: draft.draft_ref, revision: Number(draft.revision) },
      finalDdi: ddi,
      domainResults,
      assessments: await loadAssessments(client, researchCase.id),
      bnRouting: await rows(client, "bn_routing_evaluations", researchCase.id),
      bnModels: await rows(client, "bn_research_case_model_pins", researchCase.id),
      cptSnapshots: await rows(client, "bn_cpt_snapshots", researchCase.id),
    };
    const active = (
      await client.query<FinalRow>(
        `SELECT * FROM insight.final_plan_versions
         WHERE research_case_id=$1 AND status='ACTIVE' FOR UPDATE`,
        [researchCase.id],
      )
    ).rows[0];
    const sequence = active ? Number(active.sequence) + 1 : 1;

    await client.query("SELECT set_config('insight.final_plan_write','allowed',true)");
    if (active) {
      await client.query("UPDATE insight.final_plan_versions SET status='SUPERSEDED' WHERE id=$1", [
        active.id,
      ]);
    }
    const saved = (
      await client.query<FinalRow>(
        `INSERT INTO insight.final_plan_versions
           (research_case_id,sequence,status,predecessor_id,schema_version,plan_snapshot,
            plan_hash,source_draft_ref,source_draft_revision,final_ddi_execution_ref,
            provenance,finalized_by_user_id,finalized_at,idempotency_key)
         VALUES ($1,$2,'ACTIVE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          researchCase.id,
          sequence,
          active?.id ?? null,
          TREATMENT_PLAN_SCHEMA_VERSION,
          plan,
          hash(plan),
          draft.draft_ref,
          Number(draft.revision),
          draft.final_ddi_execution_ref,
          provenance,
          actor.id,
          now,
          idempotencyKey,
        ],
      )
    ).rows[0]!;

    await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
    await client.query(
      `UPDATE insight.research_cases SET workflow_state='FINALIZED',
         workflow_revision=workflow_revision+1,updated_by_user_id=$2,updated_at=$3 WHERE id=$1`,
      [researchCase.id, actor.id, now],
    );
    await client.query(
      `INSERT INTO insight.research_case_transition_events
         (research_case_id,patient_id,command,from_state,to_state,from_revision,to_revision,
          input_revision,actor_user_id,request_id,domain_result_ids,provenance,occurred_at)
       VALUES ($1,$2,'FINALIZE','READY_TO_FINALIZE','FINALIZED',$3::bigint,
               $3::bigint+1,$4,$5,$6,$7,$8,$9)`,
      [
        researchCase.id,
        researchCase.patient_id,
        Number(researchCase.workflow_revision),
        Number(researchCase.input_revision),
        actor.id,
        requestId,
        REQUIRED_RESULTS.map((type) => latest.get(type)!.id),
        { finalPlanVersionId: saved.id, idempotencyKey },
        now,
      ],
    );
    return materialize(saved);
  });
}

const generatedRegimen = (plan: PrimaryTreatmentPlanInput): ClinicianRegimenMedication[] =>
  plan.regimen.map(({ canonicalMedicationId, dose, route, frequency, titration, monitoring }) => ({
    canonicalMedicationId,
    dose,
    route,
    frequency,
    ...(titration ? { titration } : {}),
    monitoring,
  }));

const failed = (provenance: Readonly<Record<string, unknown>>): boolean =>
  provenance.accepted === false || provenance.status === "FAILED" || provenance.valid === false;

const hash = (value: unknown): string =>
  createHash("sha256")
    .update(stableSerialize(value as JsonValue))
    .digest("hex");

async function rows(client: PoolClient, table: string, researchCaseId: string) {
  const result = await client.query(
    `SELECT to_jsonb(source) AS value FROM insight.${table} source
     WHERE research_case_id=$1 ORDER BY to_jsonb(source)::text`,
    [researchCaseId],
  );
  return result.rows.map(({ value }) => value);
}

async function loadAssessments(client: PoolClient, researchCaseId: string) {
  const summary = await client.query(
    `SELECT assessment_type,status,updated_by_user_id,updated_at
     FROM insight.research_case_assessments WHERE research_case_id=$1 ORDER BY assessment_type`,
    [researchCaseId],
  );
  const detail = await Promise.all(
    ["dsm5tr_assessments", "panss_assessments", "cssrs_recent_assessments"].map(
      async (table) =>
        (
          await client.query(
            `SELECT to_jsonb(source) - 'research_case_id' AS value
           FROM insight.${table} source WHERE research_case_id=$1`,
            [researchCaseId],
          )
        ).rows[0]?.value ?? null,
    ),
  );
  return { states: summary.rows, detail };
}

async function loadByKey(client: PoolClient, researchCaseId: string, key: string) {
  return (
    await client.query<FinalRow>(
      "SELECT * FROM insight.final_plan_versions WHERE research_case_id=$1 AND idempotency_key=$2",
      [researchCaseId, key],
    )
  ).rows[0];
}

function materialize(row: FinalRow): FinalPlanVersion {
  return {
    id: row.id,
    researchCaseId: row.research_case_id,
    sequence: Number(row.sequence),
    status: row.status,
    predecessorId: row.predecessor_id,
    schemaVersion: row.schema_version,
    plan: row.plan_snapshot,
    planHash: row.plan_hash,
    sourceDraftRef: row.source_draft_ref,
    sourceDraftRevision: Number(row.source_draft_revision),
    finalDdiExecutionRef: row.final_ddi_execution_ref,
    provenance: row.provenance,
    finalizedByUserId: row.finalized_by_user_id,
    finalizedAt: row.finalized_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  };
}

function materializeRevision(
  researchCaseId: string,
  predecessorId: string,
  draft: DraftRow,
): FinalPlanRevisionDraft {
  return {
    researchCaseId,
    predecessorId,
    draftRef: draft.draft_ref,
    draftRevision: Number(draft.revision),
    workflowState: "REVISION_DRAFT",
  };
}

export class FinalPlanAuthorizationError extends Error {}
export class FinalPlanInputError extends Error {}
export class FinalPlanNotFoundError extends Error {}
export class FinalPlanConflictError extends Error {}
export class FinalPlanDependencyError extends Error {}
export class FinalPlanSchemaError extends Error {}

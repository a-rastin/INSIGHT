import {
  PANSS_INSTRUMENT_PIN,
  calculatePanss,
  type PanssAnswers,
  type PanssCalculation,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { PatientActor } from "../patient/patients.js";

export type PanssAssessmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";

export type PanssSaveInput =
  | {
      readonly mode: "SAVE" | "COMPLETE";
      readonly expectedRevision: number;
      readonly answers: PanssAnswers;
    }
  | { readonly mode: "BYPASS"; readonly expectedRevision: number };

export interface PanssAssessmentRecord {
  readonly researchCaseId: string;
  readonly status: PanssAssessmentStatus;
  readonly answers: PanssAnswers | null;
  readonly calculation: PanssCalculation | null;
  readonly instrumentPin: typeof PANSS_INSTRUMENT_PIN;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

interface CaseRow extends QueryResultRow {
  id: string;
  workflow_state: string;
  workflow_revision: string;
  summary_status: PanssAssessmentStatus;
}

interface AssessmentRow extends QueryResultRow {
  research_case_id: string;
  status: Exclude<PanssAssessmentStatus, "NOT_STARTED">;
  answers: PanssAnswers | null;
  calculation_result: PanssCalculation | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export class PanssAssessmentNotFoundError extends Error {
  constructor() {
    super("PANSS assessment was not found.");
    this.name = "PanssAssessmentNotFoundError";
  }
}

export class PanssAssessmentConflictError extends Error {
  constructor(message = "PANSS assessment conflicts with current Research Case state.") {
    super(message);
    this.name = "PanssAssessmentConflictError";
  }
}

export async function getPanssAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<PanssAssessmentRecord> {
  requirePsychiatrist(actor);
  const researchCase = await caseByPatient(pool, patientId);
  if (!researchCase) throw new PanssAssessmentNotFoundError();
  const result = await pool.query<AssessmentRow>(assessmentQuery, [researchCase.id]);
  return materialize(researchCase.id, researchCase.summary_status, result.rows[0]);
}

export async function savePanssAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  input: PanssSaveInput,
  now = new Date(),
): Promise<PanssAssessmentRecord> {
  requirePsychiatrist(actor);
  return withTransaction(pool, async (client) => {
    const researchCase = await caseByPatient(client, patientId, true);
    if (!researchCase) throw new PanssAssessmentNotFoundError();
    if (Number(researchCase.workflow_revision) !== input.expectedRevision) {
      throw new PanssAssessmentConflictError("Research Case revision is stale.");
    }
    if (researchCase.workflow_state !== "DATA_COLLECTION") {
      throw new PanssAssessmentConflictError();
    }

    const bypassed = input.mode === "BYPASS";
    const calculation = bypassed ? null : calculatePanss(input.answers);
    if (input.mode === "COMPLETE" && calculation?.status !== "COMPLETE") {
      throw new PanssAssessmentConflictError("All 30 PANSS item scores are required.");
    }
    const status = bypassed ? "BYPASSED" : input.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS";
    const answers = bypassed ? null : input.answers;

    await client.query("SELECT set_config('insight.panss_write', 'allowed', true)");
    const saved = await client.query<AssessmentRow>(
      `INSERT INTO insight.panss_assessments (
         research_case_id, status, answers, calculation_result,
         instrument_id, instrument_version, schema_version, calculation_version,
         source_reference, review_reference, created_by_user_id, updated_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $12)
       ON CONFLICT (research_case_id) DO UPDATE SET
         status = EXCLUDED.status,
         answers = EXCLUDED.answers,
         calculation_result = EXCLUDED.calculation_result,
         instrument_id = EXCLUDED.instrument_id,
         instrument_version = EXCLUDED.instrument_version,
         schema_version = EXCLUDED.schema_version,
         calculation_version = EXCLUDED.calculation_version,
         source_reference = EXCLUDED.source_reference,
         review_reference = EXCLUDED.review_reference,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING research_case_id, status, answers, calculation_result,
                 created_by_user_id, updated_by_user_id, created_at, updated_at`,
      [
        researchCase.id,
        status,
        answers,
        calculation,
        PANSS_INSTRUMENT_PIN.instrumentId,
        PANSS_INSTRUMENT_PIN.instrumentVersion,
        PANSS_INSTRUMENT_PIN.schemaVersion,
        bypassed ? null : PANSS_INSTRUMENT_PIN.calculationVersion,
        PANSS_INSTRUMENT_PIN.sourceReference,
        PANSS_INSTRUMENT_PIN.reviewReference,
        actor.id,
        now,
      ],
    );
    await client.query(
      `UPDATE insight.research_case_assessments
       SET status = $2, updated_by_user_id = $3, updated_at = $4
       WHERE research_case_id = $1 AND assessment_type = 'PANSS'`,
      [researchCase.id, status, actor.id, now],
    );
    return materialize(researchCase.id, status, saved.rows[0]);
  });
}

const assessmentQuery = `
  SELECT research_case_id, status, answers, calculation_result,
         created_by_user_id, updated_by_user_id, created_at, updated_at
  FROM insight.panss_assessments
  WHERE research_case_id = $1`;

function materialize(
  researchCaseId: string,
  status: PanssAssessmentStatus,
  row: AssessmentRow | undefined,
): PanssAssessmentRecord {
  return {
    researchCaseId,
    status,
    answers: row?.answers ?? null,
    calculation: row?.calculation_result ?? null,
    instrumentPin: PANSS_INSTRUMENT_PIN,
    createdByUserId: row?.created_by_user_id ?? null,
    updatedByUserId: row?.updated_by_user_id ?? null,
    createdAt: row?.created_at.toISOString() ?? null,
    updatedAt: row?.updated_at.toISOString() ?? null,
  };
}

async function caseByPatient(
  database: Pool | PoolClient,
  patientId: string,
  lock = false,
): Promise<CaseRow | undefined> {
  const result = await database.query<CaseRow>(
    `SELECT research_case.id, research_case.workflow_state,
            research_case.workflow_revision, assessment.status AS summary_status
     FROM insight.research_cases research_case
     JOIN insight.research_case_assessments assessment
       ON assessment.research_case_id = research_case.id
      AND assessment.assessment_type = 'PANSS'
     WHERE research_case.patient_id = $1${lock ? " FOR UPDATE OF research_case" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST")
    throw new PanssAssessmentConflictError("Psychiatrist required.");
}

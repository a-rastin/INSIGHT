import {
  CSSRS_ACTIVATION_GATE,
  CSSRS_INSTRUMENT_PIN,
  calculateCssrs,
  type CssrsAnswers,
  type CssrsCalculation,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { PatientActor } from "../patient/patients.js";
import { recordAssessmentCommit } from "./shared.js";

export type CssrsAssessmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";

export type CssrsSaveInput =
  | {
      readonly mode: "SAVE" | "COMPLETE";
      readonly expectedRevision: number;
      readonly answers: CssrsAnswers;
    }
  | { readonly mode: "BYPASS"; readonly expectedRevision: number };

export interface CssrsAssessmentRecord {
  readonly researchCaseId: string;
  readonly assessmentType: "CSSRS_RECENT";
  readonly status: CssrsAssessmentStatus;
  readonly answers: CssrsAnswers | null;
  readonly calculation: CssrsCalculation | null;
  readonly instrumentPin: typeof CSSRS_INSTRUMENT_PIN;
  readonly activationGate: typeof CSSRS_ACTIVATION_GATE;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

interface CaseRow extends QueryResultRow {
  id: string;
  workflow_state: string;
  workflow_revision: string;
  summary_status: CssrsAssessmentStatus;
  summary_updated_by_user_id: string;
  summary_updated_at: Date;
}

interface AssessmentRow extends QueryResultRow {
  research_case_id: string;
  status: Exclude<CssrsAssessmentStatus, "NOT_STARTED">;
  answers: CssrsAnswers | null;
  calculation_result: CssrsCalculation | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export class CssrsAssessmentNotFoundError extends Error {
  constructor() {
    super("C-SSRS assessment was not found.");
    this.name = "CssrsAssessmentNotFoundError";
  }
}

export class CssrsAssessmentConflictError extends Error {
  constructor(message = "C-SSRS assessment conflicts with current Research Case state.") {
    super(message);
    this.name = "CssrsAssessmentConflictError";
  }
}

export async function getCssrsAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<CssrsAssessmentRecord> {
  requirePsychiatrist(actor);
  const researchCase = await caseByPatient(pool, patientId);
  if (!researchCase) throw new CssrsAssessmentNotFoundError();
  const result = await pool.query<AssessmentRow>(assessmentQuery, [researchCase.id]);
  return materialize(researchCase, result.rows[0]);
}

export async function saveCssrsAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  input: CssrsSaveInput,
  now = new Date(),
): Promise<CssrsAssessmentRecord> {
  requirePsychiatrist(actor);
  return withTransaction(pool, async (client) => {
    const researchCase = await caseByPatient(client, patientId, true);
    if (!researchCase) throw new CssrsAssessmentNotFoundError();
    if (Number(researchCase.workflow_revision) !== input.expectedRevision) {
      throw new CssrsAssessmentConflictError("Research Case revision is stale.");
    }
    if (researchCase.workflow_state !== "DATA_COLLECTION") {
      throw new CssrsAssessmentConflictError();
    }

    const bypassed = input.mode === "BYPASS";
    let calculation: CssrsCalculation | null = null;
    if (!bypassed) {
      try {
        calculation = calculateCssrs(input.answers);
      } catch (error) {
        throw new CssrsAssessmentConflictError(
          error instanceof Error ? error.message : "Invalid C-SSRS answers.",
        );
      }
    }
    if (input.mode === "COMPLETE" && calculation?.status !== "COMPLETE") {
      throw new CssrsAssessmentConflictError("Every question on the traversed branch is required.");
    }
    const status = bypassed ? "BYPASSED" : input.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS";
    const answers = bypassed ? null : input.answers;

    await client.query("SELECT set_config('insight.cssrs_write', 'allowed', true)");
    if (bypassed) {
      await client.query(
        `DELETE FROM insight.cssrs_recent_assessments WHERE research_case_id = $1`,
        [researchCase.id],
      );
      await recordAssessmentCommit(client, researchCase.id, "CSSRS_RECENT", status, actor, now);
      return materialize(
        {
          ...researchCase,
          summary_status: status,
          summary_updated_by_user_id: actor.id,
          summary_updated_at: now,
        },
        undefined,
      );
    }
    const saved = await client.query<AssessmentRow>(
      `INSERT INTO insight.cssrs_recent_assessments (
         research_case_id, status, answers, calculation_result,
         instrument_id, instrument_version, schema_version, calculation_version,
         source_reference, source_sha256, review_reference, research_activation_status,
         created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $14)
       ON CONFLICT (research_case_id) DO UPDATE SET
         status = EXCLUDED.status,
         answers = EXCLUDED.answers,
         calculation_result = EXCLUDED.calculation_result,
         instrument_id = EXCLUDED.instrument_id,
         instrument_version = EXCLUDED.instrument_version,
         schema_version = EXCLUDED.schema_version,
         calculation_version = EXCLUDED.calculation_version,
         source_reference = EXCLUDED.source_reference,
         source_sha256 = EXCLUDED.source_sha256,
         review_reference = EXCLUDED.review_reference,
         research_activation_status = EXCLUDED.research_activation_status,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING research_case_id, status, answers, calculation_result,
                 created_by_user_id, updated_by_user_id, created_at, updated_at`,
      [
        researchCase.id,
        status,
        answers,
        calculation,
        CSSRS_INSTRUMENT_PIN.instrumentId,
        CSSRS_INSTRUMENT_PIN.instrumentVersion,
        CSSRS_INSTRUMENT_PIN.schemaVersion,
        bypassed ? null : CSSRS_INSTRUMENT_PIN.calculationVersion,
        CSSRS_INSTRUMENT_PIN.sourceReference,
        CSSRS_INSTRUMENT_PIN.sourceSha256,
        CSSRS_INSTRUMENT_PIN.reviewReference,
        CSSRS_ACTIVATION_GATE.status,
        actor.id,
        now,
      ],
    );
    await recordAssessmentCommit(client, researchCase.id, "CSSRS_RECENT", status, actor, now);
    return materialize(
      {
        ...researchCase,
        summary_status: status,
        summary_updated_by_user_id: actor.id,
        summary_updated_at: now,
      },
      saved.rows[0],
    );
  });
}

const assessmentQuery = `
  SELECT research_case_id, status, answers, calculation_result,
         created_by_user_id, updated_by_user_id, created_at, updated_at
  FROM insight.cssrs_recent_assessments
  WHERE research_case_id = $1`;

function materialize(researchCase: CaseRow, row: AssessmentRow | undefined): CssrsAssessmentRecord {
  return {
    researchCaseId: researchCase.id,
    assessmentType: "CSSRS_RECENT",
    status: researchCase.summary_status,
    answers: row?.answers ?? null,
    calculation: row?.calculation_result ?? null,
    instrumentPin: CSSRS_INSTRUMENT_PIN,
    activationGate: CSSRS_ACTIVATION_GATE,
    createdByUserId: row?.created_by_user_id ?? null,
    updatedByUserId: researchCase.summary_updated_by_user_id,
    createdAt: row?.created_at.toISOString() ?? null,
    updatedAt: researchCase.summary_updated_at.toISOString(),
  };
}

async function caseByPatient(
  database: Pool | PoolClient,
  patientId: string,
  lock = false,
): Promise<CaseRow | undefined> {
  const result = await database.query<CaseRow>(
    `SELECT research_case.id, research_case.workflow_state,
             research_case.workflow_revision, assessment.status AS summary_status,
             assessment.updated_by_user_id AS summary_updated_by_user_id,
             assessment.updated_at AS summary_updated_at
     FROM insight.research_cases research_case
     JOIN insight.research_case_assessments assessment
       ON assessment.research_case_id = research_case.id
      AND assessment.assessment_type = 'CSSRS_RECENT'
     WHERE research_case.patient_id = $1${lock ? " FOR UPDATE OF research_case" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST") {
    throw new CssrsAssessmentConflictError("Psychiatrist required.");
  }
}

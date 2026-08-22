import {
  DSM5TR_INSTRUMENT_PIN,
  calculateDsm5tr,
  type Dsm5trAnswers,
  type Dsm5trCalculation,
  type Dsm5trPsychiatristDecision,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { PatientActor } from "../patient/patients.js";
import { recordAssessmentCommit } from "./shared.js";

export type Dsm5trAssessmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";

export type Dsm5trSaveInput =
  | {
      readonly mode: "SAVE" | "COMPLETE";
      readonly expectedRevision: number;
      readonly answers: Dsm5trAnswers;
      readonly psychiatristDecision: Dsm5trPsychiatristDecision;
    }
  | { readonly mode: "BYPASS"; readonly expectedRevision: number };

export interface Dsm5trAssessmentRecord {
  readonly researchCaseId: string;
  readonly assessmentType: "DSM5TR";
  readonly status: Dsm5trAssessmentStatus;
  readonly answers: Dsm5trAnswers | null;
  readonly calculation: Dsm5trCalculation | null;
  readonly psychiatristDecision: Dsm5trPsychiatristDecision | null;
  readonly instrumentPin: typeof DSM5TR_INSTRUMENT_PIN;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

interface CaseRow extends QueryResultRow {
  id: string;
  workflow_state: string;
  workflow_revision: string;
  summary_status: Dsm5trAssessmentStatus;
  summary_updated_by_user_id: string;
  summary_updated_at: Date;
}

interface AssessmentRow extends QueryResultRow {
  research_case_id: string;
  status: Exclude<Dsm5trAssessmentStatus, "NOT_STARTED">;
  answers: Dsm5trAnswers | null;
  calculation_result: Dsm5trCalculation | null;
  psychiatrist_decision: Dsm5trPsychiatristDecision | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export class Dsm5trAssessmentNotFoundError extends Error {
  constructor() {
    super("DSM-5-TR assessment was not found.");
    this.name = "Dsm5trAssessmentNotFoundError";
  }
}

export class Dsm5trAssessmentConflictError extends Error {
  constructor(message = "DSM-5-TR assessment conflicts with current Research Case state.") {
    super(message);
    this.name = "Dsm5trAssessmentConflictError";
  }
}

export async function getDsm5trAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<Dsm5trAssessmentRecord> {
  requirePsychiatrist(actor);
  const researchCase = await caseByPatient(pool, patientId);
  if (!researchCase) throw new Dsm5trAssessmentNotFoundError();
  const result = await pool.query<AssessmentRow>(assessmentQuery, [researchCase.id]);
  return materialize(researchCase, result.rows[0]);
}

export async function saveDsm5trAssessment(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  input: Dsm5trSaveInput,
  now = new Date(),
): Promise<Dsm5trAssessmentRecord> {
  requirePsychiatrist(actor);
  return withTransaction(pool, async (client) => {
    const researchCase = await caseByPatient(client, patientId, true);
    if (!researchCase) throw new Dsm5trAssessmentNotFoundError();
    if (Number(researchCase.workflow_revision) !== input.expectedRevision) {
      throw new Dsm5trAssessmentConflictError("Research Case revision is stale.");
    }
    if (researchCase.workflow_state !== "DATA_COLLECTION") {
      throw new Dsm5trAssessmentConflictError();
    }

    const bypassed = input.mode === "BYPASS";
    const calculation = bypassed ? null : calculateDsm5tr(input.answers);
    if (input.mode === "COMPLETE") {
      if (!calculation || calculation.disposition === "INCOMPLETE") {
        throw new Dsm5trAssessmentConflictError("Every criterion response is required.");
      }
      if (input.psychiatristDecision === "UNDECIDED") {
        throw new Dsm5trAssessmentConflictError("Psychiatrist decision is required.");
      }
    }
    const status = bypassed ? "BYPASSED" : input.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS";
    const answers = bypassed ? null : input.answers;
    const decision = bypassed ? null : input.psychiatristDecision;

    await client.query("SELECT set_config('insight.dsm5tr_write', 'allowed', true)");
    if (bypassed) {
      await client.query(`DELETE FROM insight.dsm5tr_assessments WHERE research_case_id = $1`, [
        researchCase.id,
      ]);
      await recordAssessmentCommit(client, researchCase.id, "DSM5TR", status, actor, now);
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
      `INSERT INTO insight.dsm5tr_assessments (
         research_case_id, status, answers, calculation_result, psychiatrist_decision,
         instrument_id, instrument_version, schema_version, calculation_version,
         source_reference, review_reference, created_by_user_id, updated_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $13)
       ON CONFLICT (research_case_id) DO UPDATE SET
         status = EXCLUDED.status,
         answers = EXCLUDED.answers,
         calculation_result = EXCLUDED.calculation_result,
         psychiatrist_decision = EXCLUDED.psychiatrist_decision,
         instrument_id = EXCLUDED.instrument_id,
         instrument_version = EXCLUDED.instrument_version,
         schema_version = EXCLUDED.schema_version,
         calculation_version = EXCLUDED.calculation_version,
         source_reference = EXCLUDED.source_reference,
         review_reference = EXCLUDED.review_reference,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING research_case_id, status, answers, calculation_result,
                 psychiatrist_decision, created_by_user_id, updated_by_user_id,
                 created_at, updated_at`,
      [
        researchCase.id,
        status,
        answers,
        calculation,
        decision,
        DSM5TR_INSTRUMENT_PIN.instrumentId,
        DSM5TR_INSTRUMENT_PIN.instrumentVersion,
        DSM5TR_INSTRUMENT_PIN.schemaVersion,
        bypassed ? null : DSM5TR_INSTRUMENT_PIN.calculationVersion,
        DSM5TR_INSTRUMENT_PIN.sourceReference,
        DSM5TR_INSTRUMENT_PIN.reviewReference,
        actor.id,
        now,
      ],
    );
    await recordAssessmentCommit(client, researchCase.id, "DSM5TR", status, actor, now);
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
         psychiatrist_decision, created_by_user_id, updated_by_user_id,
         created_at, updated_at
  FROM insight.dsm5tr_assessments
  WHERE research_case_id = $1`;

function materialize(
  researchCase: CaseRow,
  row: AssessmentRow | undefined,
): Dsm5trAssessmentRecord {
  return {
    researchCaseId: researchCase.id,
    assessmentType: "DSM5TR",
    status: researchCase.summary_status,
    answers: row?.answers ?? null,
    calculation: row?.calculation_result ?? null,
    psychiatristDecision: row?.psychiatrist_decision ?? null,
    instrumentPin: DSM5TR_INSTRUMENT_PIN,
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
      AND assessment.assessment_type = 'DSM5TR'
     WHERE research_case.patient_id = $1${lock ? " FOR UPDATE OF research_case" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST")
    throw new Dsm5trAssessmentConflictError("Psychiatrist required.");
}

import type { AssessmentStatus, AssessmentType } from "@insight/contracts";
import type { PoolClient } from "pg";

import type { PatientActor } from "../patient/patients.js";

export async function recordAssessmentCommit(
  client: PoolClient,
  researchCaseId: string,
  assessmentType: AssessmentType,
  status: AssessmentStatus,
  actor: PatientActor,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE insight.research_case_assessments
     SET status = $3, updated_by_user_id = $4, updated_at = $5
     WHERE research_case_id = $1 AND assessment_type = $2`,
    [researchCaseId, assessmentType, status, actor.id, now],
  );
  await client.query(
    `INSERT INTO insight.assessment_save_events (
       research_case_id, assessment_type, status, actor_user_id, occurred_at
     ) VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [researchCaseId, assessmentType, status, actor.id],
  );
}

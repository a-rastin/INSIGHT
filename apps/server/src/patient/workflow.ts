import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { PatientActor } from "./patients.js";

export const WORKFLOW_STATES = [
  "DATA_COLLECTION",
  "NORMALIZING_MEDICATIONS",
  "IMPUTING_BYPASSED_ASSESSMENTS",
  "ROUTING_BN",
  "GENERATING_CPTS",
  "RUNNING_BN",
  "CHECKING_PRIMARY_DDI",
  "GENERATING_PRIMARY_PLAN",
  "CLINICIAN_REVIEW",
  "RECHECKING_FINAL_DDI",
  "READY_TO_FINALIZE",
  "FINALIZED",
  "REVISION_DRAFT",
  "DELETED",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_COMMANDS = [
  "BEGIN_NORMALIZATION",
  "COMPLETE_MEDICATION_NORMALIZATION",
  "COMPLETE_ASSESSMENT_IMPUTATION",
  "COMPLETE_BN_ROUTING",
  "COMPLETE_CPT_GENERATION",
  "COMPLETE_BN_INFERENCE",
  "COMPLETE_PRIMARY_DDI",
  "COMPLETE_PRIMARY_PLAN",
  "REQUEST_FINAL_DDI_RECHECK",
  "CONFIRM_UNCHANGED_REGIMEN",
  "COMPLETE_FINAL_DDI",
  "FINALIZE",
  "CREATE_REVISION_DRAFT",
  "REQUEST_REVISION_DDI_RECHECK",
] as const;

export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];
export type AssessmentType = "DSM5TR" | "PANSS" | "CSSRS_RECENT";
export type AssessmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "BYPASSED";
export type DomainResultStatus = "SUCCEEDED" | "FAILED";
export type DomainResultType =
  | "DATA_COLLECTION_VALIDATED"
  | "MEDICATION_NORMALIZATION"
  | "ASSESSMENT_IMPUTATION"
  | "BN_ROUTING"
  | "CPT_SNAPSHOT"
  | "BN_INFERENCE"
  | "PRIMARY_DDI"
  | "PRIMARY_PLAN"
  | "REGIMEN_UNCHANGED"
  | "FINAL_DDI";

interface TransitionDefinition {
  readonly command: WorkflowCommand;
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly resultType?: DomainResultType;
}

export const WORKFLOW_TRANSITIONS: readonly TransitionDefinition[] = Object.freeze([
  {
    command: "BEGIN_NORMALIZATION",
    from: "DATA_COLLECTION",
    to: "NORMALIZING_MEDICATIONS",
    resultType: "DATA_COLLECTION_VALIDATED",
  },
  {
    command: "COMPLETE_MEDICATION_NORMALIZATION",
    from: "NORMALIZING_MEDICATIONS",
    to: "IMPUTING_BYPASSED_ASSESSMENTS",
    resultType: "MEDICATION_NORMALIZATION",
  },
  {
    command: "COMPLETE_ASSESSMENT_IMPUTATION",
    from: "IMPUTING_BYPASSED_ASSESSMENTS",
    to: "ROUTING_BN",
    resultType: "ASSESSMENT_IMPUTATION",
  },
  {
    command: "COMPLETE_BN_ROUTING",
    from: "ROUTING_BN",
    to: "GENERATING_CPTS",
    resultType: "BN_ROUTING",
  },
  {
    command: "COMPLETE_CPT_GENERATION",
    from: "GENERATING_CPTS",
    to: "RUNNING_BN",
    resultType: "CPT_SNAPSHOT",
  },
  {
    command: "COMPLETE_BN_INFERENCE",
    from: "RUNNING_BN",
    to: "CHECKING_PRIMARY_DDI",
    resultType: "BN_INFERENCE",
  },
  {
    command: "COMPLETE_PRIMARY_DDI",
    from: "CHECKING_PRIMARY_DDI",
    to: "GENERATING_PRIMARY_PLAN",
    resultType: "PRIMARY_DDI",
  },
  {
    command: "COMPLETE_PRIMARY_PLAN",
    from: "GENERATING_PRIMARY_PLAN",
    to: "CLINICIAN_REVIEW",
    resultType: "PRIMARY_PLAN",
  },
  {
    command: "REQUEST_FINAL_DDI_RECHECK",
    from: "CLINICIAN_REVIEW",
    to: "RECHECKING_FINAL_DDI",
  },
  {
    command: "CONFIRM_UNCHANGED_REGIMEN",
    from: "CLINICIAN_REVIEW",
    to: "READY_TO_FINALIZE",
    resultType: "REGIMEN_UNCHANGED",
  },
  {
    command: "COMPLETE_FINAL_DDI",
    from: "RECHECKING_FINAL_DDI",
    to: "READY_TO_FINALIZE",
    resultType: "FINAL_DDI",
  },
  { command: "FINALIZE", from: "READY_TO_FINALIZE", to: "FINALIZED" },
  { command: "CREATE_REVISION_DRAFT", from: "FINALIZED", to: "REVISION_DRAFT" },
  {
    command: "REQUEST_REVISION_DDI_RECHECK",
    from: "REVISION_DRAFT",
    to: "RECHECKING_FINAL_DDI",
  },
]);

const MODEL_TOOLS: Readonly<Record<WorkflowState, readonly string[]>> = Object.freeze({
  DATA_COLLECTION: [],
  NORMALIZING_MEDICATIONS: [
    "research_case.get_context",
    "medication.search_candidates",
    "medication.commit_mapping",
  ],
  IMPUTING_BYPASSED_ASSESSMENTS: ["research_case.get_context", "assessment.submit_imputation"],
  ROUTING_BN: [],
  GENERATING_CPTS: [
    "research_case.get_context",
    "bn.get_routed_contracts",
    "bn.submit_cpt_snapshot",
  ],
  RUNNING_BN: ["bn.run_inference"],
  CHECKING_PRIMARY_DDI: ["ddi.evaluate_regimen"],
  GENERATING_PRIMARY_PLAN: ["research_case.get_context", "treatment_plan.submit_primary"],
  CLINICIAN_REVIEW: [],
  RECHECKING_FINAL_DDI: ["ddi.evaluate_regimen"],
  READY_TO_FINALIZE: [],
  FINALIZED: [],
  REVISION_DRAFT: [],
  DELETED: [],
});

const STEP: Readonly<Record<WorkflowState, { readonly ordinal: number; readonly label: string }>> =
  Object.freeze({
    DATA_COLLECTION: { ordinal: 1, label: "Data collection" },
    NORMALIZING_MEDICATIONS: { ordinal: 2, label: "Medication normalization" },
    IMPUTING_BYPASSED_ASSESSMENTS: { ordinal: 3, label: "Assessment imputation" },
    ROUTING_BN: { ordinal: 4, label: "Bayesian routing" },
    GENERATING_CPTS: { ordinal: 5, label: "CPT generation" },
    RUNNING_BN: { ordinal: 6, label: "Bayesian inference" },
    CHECKING_PRIMARY_DDI: { ordinal: 7, label: "Primary DDI check" },
    GENERATING_PRIMARY_PLAN: { ordinal: 8, label: "Primary plan generation" },
    CLINICIAN_REVIEW: { ordinal: 9, label: "Clinician review" },
    RECHECKING_FINAL_DDI: { ordinal: 9, label: "Final DDI recheck" },
    READY_TO_FINALIZE: { ordinal: 10, label: "Ready to finalize" },
    FINALIZED: { ordinal: 10, label: "Finalized" },
    REVISION_DRAFT: { ordinal: 9, label: "Revision draft" },
    DELETED: { ordinal: 10, label: "Deleted" },
  });

const RESULT_STATE: Readonly<Record<DomainResultType, WorkflowState>> = Object.freeze({
  DATA_COLLECTION_VALIDATED: "DATA_COLLECTION",
  MEDICATION_NORMALIZATION: "NORMALIZING_MEDICATIONS",
  ASSESSMENT_IMPUTATION: "IMPUTING_BYPASSED_ASSESSMENTS",
  BN_ROUTING: "ROUTING_BN",
  CPT_SNAPSHOT: "GENERATING_CPTS",
  BN_INFERENCE: "RUNNING_BN",
  PRIMARY_DDI: "CHECKING_PRIMARY_DDI",
  PRIMARY_PLAN: "GENERATING_PRIMARY_PLAN",
  REGIMEN_UNCHANGED: "CLINICIAN_REVIEW",
  FINAL_DDI: "RECHECKING_FINAL_DDI",
});

const UPSTREAM_REQUIRED: readonly DomainResultType[] = [
  "DATA_COLLECTION_VALIDATED",
  "MEDICATION_NORMALIZATION",
  "BN_ROUTING",
  "CPT_SNAPSHOT",
  "BN_INFERENCE",
  "PRIMARY_DDI",
  "PRIMARY_PLAN",
];

interface CaseRow extends QueryResultRow {
  id: string;
  patient_id: string;
  workflow_state: WorkflowState;
  workflow_revision: string;
  input_revision: string;
  last_input_invalidation_at: Date | null;
  last_input_invalidation_reason: string | null;
}

interface ResultRow extends QueryResultRow {
  id: string;
  result_type: DomainResultType;
  status: DomainResultStatus;
  workflow_revision: string;
}

interface TransitionAuditRow extends QueryResultRow {
  patient_id: string;
  research_case_id: string;
  command: WorkflowCommand;
  from_state: WorkflowState;
  to_state: WorkflowState;
  from_revision: string;
  to_revision: string;
  input_revision: string;
  actor_user_id: string | null;
  request_id: string;
  domain_result_ids: string[];
  provenance: Readonly<Record<string, unknown>>;
  occurred_at: Date;
}

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface ResearchCaseWorkflow {
  readonly id: string;
  readonly state: WorkflowState;
  readonly revision: number;
  readonly inputRevision: number;
  readonly currentStep: { readonly ordinal: number; readonly label: string };
  readonly allowedCommands: readonly WorkflowCommand[];
  readonly modelAllowedTools: readonly string[];
  readonly lastInputInvalidation: {
    readonly at: string;
    readonly reason: string;
  } | null;
}

export interface ResearchCaseTransitionAuditEvent {
  readonly patientLink: { readonly patientId: string; readonly researchCaseId: string };
  readonly command: WorkflowCommand;
  readonly fromState: WorkflowState;
  readonly toState: WorkflowState;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly inputRevision: number;
  readonly actorUserId: string | null;
  readonly requestId: string;
  readonly domainResultIds: readonly string[];
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export class ResearchCaseNotFoundError extends Error {
  constructor() {
    super("Research Case was not found.");
    this.name = "ResearchCaseNotFoundError";
  }
}

export class StaleResearchCaseRevisionError extends Error {
  constructor() {
    super("Research Case revision is stale.");
    this.name = "StaleResearchCaseRevisionError";
  }
}

export class WorkflowTransitionError extends Error {
  constructor(message = "Workflow command is not allowed in the current state.") {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

export class RequiredDomainResultError extends Error {
  constructor() {
    super("Required successful domain result is missing, failed, or stale.");
    this.name = "RequiredDomainResultError";
  }
}

export async function getResearchCaseWorkflow(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<ResearchCaseWorkflow> {
  requirePsychiatrist(actor);
  const row = await caseByPatient(pool, patientId);
  if (!row) throw new ResearchCaseNotFoundError();
  return materializeWorkflow(pool, row);
}

export async function listResearchCaseTransitionAuditEvents(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<readonly ResearchCaseTransitionAuditEvent[]> {
  requirePsychiatrist(actor);
  const authorization = await pool.query(
    `SELECT 1 FROM insight.users
     WHERE id = $1 AND role = 'PSYCHIATRIST' AND status <> 'DISABLED'`,
    [actor.id],
  );
  if (authorization.rowCount !== 1) throw new WorkflowTransitionError("Psychiatrist required.");
  const result = await pool.query<TransitionAuditRow>(
    `SELECT patient_id, research_case_id, command, from_state, to_state,
            from_revision, to_revision, input_revision, actor_user_id, request_id,
            domain_result_ids, provenance, occurred_at
     FROM insight.research_case_transition_events
     WHERE patient_id = $1
     ORDER BY to_revision, occurred_at, id`,
    [patientId],
  );
  return result.rows.map((row) => ({
    patientLink: { patientId: row.patient_id, researchCaseId: row.research_case_id },
    command: row.command,
    fromState: row.from_state,
    toState: row.to_state,
    fromRevision: Number(row.from_revision),
    toRevision: Number(row.to_revision),
    inputRevision: Number(row.input_revision),
    actorUserId: row.actor_user_id,
    requestId: row.request_id,
    domainResultIds: row.domain_result_ids,
    provenance: row.provenance,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

export async function transitionResearchCase(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  command: WorkflowCommand,
  expectedRevision: number,
  requestId: string,
  now = new Date(),
): Promise<ResearchCaseWorkflow> {
  requirePsychiatrist(actor);
  return withTransaction(pool, async (client) => {
    const row = await caseByPatient(client, patientId, true);
    if (!row) throw new ResearchCaseNotFoundError();
    assertRevision(row, expectedRevision);
    const transition = WORKFLOW_TRANSITIONS.find(
      (candidate) => candidate.from === row.workflow_state && candidate.command === command,
    );
    if (!transition) throw new WorkflowTransitionError();

    const resultIds = await requiredResultIds(client, row, transition);
    await client.query("SELECT set_config('insight.workflow_transition', 'allowed', true)");
    const updated = await client.query<CaseRow>(
      `UPDATE insight.research_cases
       SET workflow_state = $2,
           workflow_revision = workflow_revision + 1,
           updated_by_user_id = $3,
           updated_at = $4
       WHERE id = $1 AND workflow_revision = $5
       RETURNING id, patient_id, workflow_state, workflow_revision, input_revision,
                 last_input_invalidation_at, last_input_invalidation_reason`,
      [row.id, transition.to, actor.id, now, expectedRevision],
    );
    if (updated.rowCount !== 1) throw new StaleResearchCaseRevisionError();
    const next = updated.rows[0]!;
    await client.query(
      `INSERT INTO insight.research_case_transition_events (
         research_case_id, patient_id, command, from_state, to_state,
         from_revision, to_revision, input_revision, actor_user_id, request_id,
         domain_result_ids, provenance, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.id,
        row.patient_id,
        transition.command,
        transition.from,
        transition.to,
        expectedRevision,
        Number(next.workflow_revision),
        Number(next.input_revision),
        actor.id,
        requestId,
        resultIds,
        { command: transition.command, domainResultIds: resultIds },
        now,
      ],
    );
    return materializeWorkflow(client, next);
  });
}

export async function recordAssessmentState(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  assessmentType: AssessmentType,
  status: AssessmentStatus,
  expectedRevision: number,
  now = new Date(),
): Promise<void> {
  requirePsychiatrist(actor);
  await withTransaction(pool, async (client) => {
    const row = await caseByPatient(client, patientId, true);
    if (!row) throw new ResearchCaseNotFoundError();
    assertRevision(row, expectedRevision);
    if (row.workflow_state !== "DATA_COLLECTION") throw new WorkflowTransitionError();
    await client.query(
      `UPDATE insight.research_case_assessments
       SET status = $3, updated_by_user_id = $4, updated_at = $5
       WHERE research_case_id = $1 AND assessment_type = $2`,
      [row.id, assessmentType, status, actor.id, now],
    );
  });
}

export async function recordDomainResult(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  input: {
    readonly type: DomainResultType;
    readonly status: DomainResultStatus;
    readonly resultReference: string;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly expectedRevision: number;
  },
  now = new Date(),
): Promise<string> {
  requirePsychiatrist(actor);
  if (
    input.resultReference.trim() !== input.resultReference ||
    input.resultReference.length === 0
  ) {
    throw new WorkflowTransitionError("Domain result reference is invalid.");
  }
  return withTransaction(pool, async (client) => {
    const row = await caseByPatient(client, patientId, true);
    if (!row) throw new ResearchCaseNotFoundError();
    assertRevision(row, input.expectedRevision);
    if (RESULT_STATE[input.type] !== row.workflow_state) throw new WorkflowTransitionError();
    await client.query("SELECT set_config('insight.workflow_transition', 'allowed', true)");
    const result = await client.query<{ id: string }>(
      `INSERT INTO insight.research_case_domain_results (
         research_case_id, result_type, status, workflow_revision, input_revision,
         result_reference, provenance, recorded_by_user_id, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        row.id,
        input.type,
        input.status,
        input.expectedRevision,
        Number(row.input_revision),
        input.resultReference,
        input.provenance,
        actor.id,
        now,
      ],
    );
    return result.rows[0]!.id;
  });
}

export async function invalidateResearchCaseInputs(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  expectedRevision: number,
  reason: string,
  requestId: string,
  now = new Date(),
): Promise<ResearchCaseWorkflow> {
  requirePsychiatrist(actor);
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0 || normalizedReason.length > 500) {
    throw new WorkflowTransitionError("Input invalidation reason is invalid.");
  }
  return withTransaction(pool, async (client) => {
    const row = await caseByPatient(client, patientId, true);
    if (!row) throw new ResearchCaseNotFoundError();
    assertRevision(row, expectedRevision);
    return invalidateLockedCase(client, row, actor, normalizedReason, requestId, now);
  });
}

export async function invalidateResearchCaseInputsInTransaction(
  client: PoolClient,
  actor: PatientActor,
  patientId: string,
  reason: string,
  requestId: string,
  now = new Date(),
): Promise<void> {
  requirePsychiatrist(actor);
  const row = await caseByPatient(client, patientId, true);
  if (!row) throw new ResearchCaseNotFoundError();
  await invalidateLockedCase(client, row, actor, reason, requestId, now);
}

async function invalidateLockedCase(
  client: PoolClient,
  row: CaseRow,
  actor: PatientActor,
  reason: string,
  requestId: string,
  now: Date,
): Promise<ResearchCaseWorkflow> {
  if (row.workflow_state === "FINALIZED" || row.workflow_state === "DELETED") {
    throw new WorkflowTransitionError();
  }
  await client.query("SELECT set_config('insight.workflow_transition', 'allowed', true)");
  const invalidated = await client.query<{ id: string }>(
    `UPDATE insight.research_case_domain_results
     SET invalidated_at = $2, invalidated_by_user_id = $3, invalidation_reason = $4
     WHERE research_case_id = $1 AND invalidated_at IS NULL
     RETURNING id`,
    [row.id, now, actor.id, reason],
  );
  const updated = await client.query<CaseRow>(
    `UPDATE insight.research_cases
     SET workflow_state = 'DATA_COLLECTION',
         workflow_revision = workflow_revision + 1,
         input_revision = input_revision + 1,
         last_input_invalidation_at = $2,
         last_input_invalidation_reason = $3,
         updated_by_user_id = $4,
         updated_at = $2
     WHERE id = $1 AND workflow_revision = $5
     RETURNING id, patient_id, workflow_state, workflow_revision, input_revision,
               last_input_invalidation_at, last_input_invalidation_reason`,
    [row.id, now, reason, actor.id, Number(row.workflow_revision)],
  );
  if (updated.rowCount !== 1) throw new StaleResearchCaseRevisionError();
  const next = updated.rows[0]!;
  const resultIds = invalidated.rows.map(({ id }) => id);
  await client.query(
    `INSERT INTO insight.research_case_transition_events (
       research_case_id, patient_id, command, from_state, to_state,
       from_revision, to_revision, input_revision, actor_user_id, request_id,
       domain_result_ids, provenance, occurred_at
     ) VALUES ($1, $2, 'INVALIDATE_STALE_INPUTS', $3, 'DATA_COLLECTION',
               $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.id,
      row.patient_id,
      row.workflow_state,
      Number(row.workflow_revision),
      Number(next.workflow_revision),
      Number(next.input_revision),
      actor.id,
      requestId,
      resultIds,
      { reason, invalidatedDomainResultIds: resultIds },
      now,
    ],
  );
  return materializeWorkflow(client, next);
}

async function requiredResultIds(
  database: Queryable,
  row: CaseRow,
  transition: TransitionDefinition,
): Promise<readonly string[]> {
  const latest = await latestResults(database, row);
  const required: DomainResultType[] = [];
  if (transition.resultType) {
    const bypassCount = await bypassedAssessmentCount(database, row.id);
    if (transition.resultType !== "ASSESSMENT_IMPUTATION" || bypassCount > 0) {
      required.push(transition.resultType);
    }
  }
  if (transition.to === "READY_TO_FINALIZE") required.push(...UPSTREAM_REQUIRED);
  if (transition.command === "BEGIN_NORMALIZATION" && !(await assessmentsReady(database, row.id))) {
    throw new RequiredDomainResultError();
  }

  const ids: string[] = [];
  for (const type of new Set(required)) {
    const result = latest.get(type);
    if (!result || result.status !== "SUCCEEDED") throw new RequiredDomainResultError();
    if (
      type === transition.resultType &&
      Number(result.workflow_revision) !== Number(row.workflow_revision)
    ) {
      throw new RequiredDomainResultError();
    }
    ids.push(result.id);
  }
  return ids;
}

async function materializeWorkflow(
  database: Queryable,
  row: CaseRow,
): Promise<ResearchCaseWorkflow> {
  const commands: WorkflowCommand[] = [];
  for (const transition of WORKFLOW_TRANSITIONS) {
    if (transition.from !== row.workflow_state) continue;
    try {
      await requiredResultIds(database, row, transition);
      commands.push(transition.command);
    } catch (error) {
      if (!(error instanceof RequiredDomainResultError)) throw error;
    }
  }
  return {
    id: row.id,
    state: row.workflow_state,
    revision: Number(row.workflow_revision),
    inputRevision: Number(row.input_revision),
    currentStep: STEP[row.workflow_state],
    allowedCommands: commands,
    modelAllowedTools: MODEL_TOOLS[row.workflow_state],
    lastInputInvalidation:
      row.last_input_invalidation_at && row.last_input_invalidation_reason
        ? {
            at: row.last_input_invalidation_at.toISOString(),
            reason: row.last_input_invalidation_reason,
          }
        : null,
  };
}

async function latestResults(
  database: Queryable,
  row: CaseRow,
): Promise<ReadonlyMap<DomainResultType, ResultRow>> {
  const result = await database.query<ResultRow>(
    `SELECT DISTINCT ON (result_type) id, result_type, status, workflow_revision
     FROM insight.research_case_domain_results
     WHERE research_case_id = $1 AND input_revision = $2 AND invalidated_at IS NULL
     ORDER BY result_type, recorded_at DESC, id DESC`,
    [row.id, Number(row.input_revision)],
  );
  return new Map(result.rows.map((item) => [item.result_type, item]));
}

async function assessmentsReady(database: Queryable, researchCaseId: string): Promise<boolean> {
  const result = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM insight.research_case_assessments
     WHERE research_case_id = $1 AND status IN ('COMPLETED', 'BYPASSED')`,
    [researchCaseId],
  );
  return result.rows[0]?.count === 3;
}

async function bypassedAssessmentCount(
  database: Queryable,
  researchCaseId: string,
): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM insight.research_case_assessments
     WHERE research_case_id = $1 AND status = 'BYPASSED'`,
    [researchCaseId],
  );
  return result.rows[0]?.count ?? 0;
}

async function caseByPatient(
  database: Queryable,
  patientId: string,
  lock = false,
): Promise<CaseRow | undefined> {
  const result = await database.query<CaseRow>(
    `SELECT id, patient_id, workflow_state, workflow_revision, input_revision,
            last_input_invalidation_at, last_input_invalidation_reason
     FROM insight.research_cases
     WHERE patient_id = $1${lock ? " FOR UPDATE" : ""}`,
    [patientId],
  );
  return result.rows[0];
}

function assertRevision(row: CaseRow, expectedRevision: number): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    Number(row.workflow_revision) !== expectedRevision
  ) {
    throw new StaleResearchCaseRevisionError();
  }
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST") throw new WorkflowTransitionError("Psychiatrist required.");
}

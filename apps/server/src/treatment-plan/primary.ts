import { createHash, randomBytes } from "node:crypto";

import {
  PrimaryTreatmentPlanInputSchema,
  TREATMENT_PLAN_SCHEMA_VERSION,
  stableSerialize,
  type JsonValue,
  type PrimaryTreatmentPlanInput,
  type PrimaryTreatmentPlanOutput,
} from "@insight/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Pool, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { TrustedToolContext } from "../deidentification/gateway.js";
import { McpToolError, type ToolHandlers } from "../mcp/gateway.js";

export interface PrimaryPlanExecution {
  readonly executionId: string;
  readonly researchCaseId: string;
  readonly requestedByUserId: string;
  readonly workflowRevision: number;
  readonly inputRevision: number;
  readonly inputExecutionRefs: readonly string[];
  readonly primaryDdiExecutionRef: string;
  readonly imputationSnapshotRef: string | null;
}

export interface PrimaryPlanDraft extends PrimaryTreatmentPlanOutput {
  readonly schemaVersion: typeof TREATMENT_PLAN_SCHEMA_VERSION;
  readonly plan: PrimaryTreatmentPlanInput;
  readonly sourceExecutionRefs: readonly string[];
  readonly primaryDdiExecutionRef: string;
  readonly workflowRevision: number;
  readonly inputRevision: number;
  readonly updatedAt: string;
}

interface DdiRow extends QueryResultRow {
  research_case_id: string;
  input_revision: string;
  purpose: string;
  exact_regimen: Array<{
    kind: "CURRENT" | "PROPOSED";
    normalizationState: "NORMALIZED" | "UNKNOWN";
    canonicalId?: string;
  }>;
  excluded_canonical_ids: string[];
  findings: Array<{ sourceRecordRef: string }>;
}

interface DraftRow extends QueryResultRow {
  draft_ref: string;
  revision: string;
  schema_version: string;
  plan_payload: PrimaryTreatmentPlanInput;
  plan_hash: string;
  source_execution_refs: string[];
  primary_ddi_execution_ref: string;
  ai_imputation_notice_visible: boolean;
  workflow_revision: string;
  input_revision: string;
  last_tool_execution_id: string;
  updated_at: Date;
}

interface ExecutionRow extends QueryResultRow {
  id: string;
  research_case_id: string;
  research_case_revision: string;
  input_revision: string;
  requested_by_user_id: string;
}

const INPUT_RESULT_TYPES = [
  "MEDICATION_NORMALIZATION",
  "ASSESSMENT_IMPUTATION",
  "BN_ROUTING",
  "CPT_SNAPSHOT",
  "BN_INFERENCE",
  "PRIMARY_DDI",
] as const;

const sha256 = (value: JsonValue): string =>
  createHash("sha256").update(stableSerialize(value)).digest("hex");
const sorted = (values: readonly string[]): string[] => [...values].sort();
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  sorted(left).every((value, index) => value === sorted(right)[index]);

export async function submitPrimaryPlan(
  pool: Pool,
  execution: PrimaryPlanExecution,
  input: PrimaryTreatmentPlanInput,
  now = new Date(),
): Promise<PrimaryPlanDraft> {
  if (
    input.schemaVersion !== TREATMENT_PLAN_SCHEMA_VERSION ||
    !Value.Check(PrimaryTreatmentPlanInputSchema, input)
  ) {
    throw new McpToolError("PLAN_SCHEMA_INVALID");
  }
  if (!sameStrings(input.sourceExecutionRefs, execution.inputExecutionRefs)) {
    throw new McpToolError("PROVENANCE_MISMATCH");
  }

  return withTransaction(pool, async (client) => {
    const currentCase = await client.query(
      `SELECT id FROM insight.research_cases
       WHERE id=$1 AND workflow_revision=$2 AND input_revision=$3 FOR UPDATE`,
      [execution.researchCaseId, execution.workflowRevision, execution.inputRevision],
    );
    if (!currentCase.rows[0]) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");

    const ddiResult = await client.query<DdiRow>(
      `SELECT research_case_id,input_revision,purpose,exact_regimen,
              excluded_canonical_ids,findings
       FROM insight.ddi_executions WHERE execution_ref=$1`,
      [execution.primaryDdiExecutionRef],
    );
    const ddi = ddiResult.rows[0];
    if (
      !ddi ||
      ddi.research_case_id !== execution.researchCaseId ||
      Number(ddi.input_revision) !== execution.inputRevision ||
      ddi.purpose !== "PRIMARY_FILTER" ||
      !input.sourceExecutionRefs.includes(execution.primaryDdiExecutionRef)
    ) {
      throw new McpToolError("PROVENANCE_MISMATCH");
    }

    validatePlanReferences(input, ddi, execution.inputExecutionRefs);
    const planHash = sha256(input as unknown as JsonValue);
    const existingResult = await client.query<DraftRow>(
      "SELECT * FROM insight.primary_treatment_plan_drafts WHERE research_case_id=$1",
      [execution.researchCaseId],
    );
    const existing = existingResult.rows[0];
    if (existing?.last_tool_execution_id === execution.executionId) {
      if (existing.plan_hash !== planHash) throw new McpToolError("PROVENANCE_MISMATCH");
      return materializeDraft(existing);
    }

    await client.query("SELECT set_config('insight.primary_plan_write','allowed',true)");
    const saved = await client.query<DraftRow>(
      `INSERT INTO insight.primary_treatment_plan_drafts
         (research_case_id,draft_ref,revision,schema_version,plan_payload,plan_hash,
          source_execution_refs,primary_ddi_execution_ref,ai_imputation_notice_visible,
          workflow_revision,input_revision,last_tool_execution_id,created_by_user_id,
          updated_by_user_id,created_at,updated_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$13)
       ON CONFLICT (research_case_id) DO UPDATE SET
         revision=primary_treatment_plan_drafts.revision+1,
         schema_version=EXCLUDED.schema_version,plan_payload=EXCLUDED.plan_payload,
         plan_hash=EXCLUDED.plan_hash,source_execution_refs=EXCLUDED.source_execution_refs,
         primary_ddi_execution_ref=EXCLUDED.primary_ddi_execution_ref,
         ai_imputation_notice_visible=EXCLUDED.ai_imputation_notice_visible,
         workflow_revision=EXCLUDED.workflow_revision,input_revision=EXCLUDED.input_revision,
         last_tool_execution_id=EXCLUDED.last_tool_execution_id,
         updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        execution.researchCaseId,
        existing?.draft_ref ?? `primary-plan-draft-${randomBytes(32).toString("hex")}`,
        TREATMENT_PLAN_SCHEMA_VERSION,
        JSON.stringify(input),
        planHash,
        JSON.stringify(sorted(execution.inputExecutionRefs)),
        execution.primaryDdiExecutionRef,
        execution.imputationSnapshotRef !== null,
        execution.workflowRevision,
        execution.inputRevision,
        execution.executionId,
        execution.requestedByUserId,
        now,
      ],
    );
    return materializeDraft(saved.rows[0]!);
  });
}

function validatePlanReferences(
  input: PrimaryTreatmentPlanInput,
  ddi: DdiRow,
  inputExecutionRefs: readonly string[],
): void {
  const candidates = new Set(
    ddi.exact_regimen
      .filter(
        ({ kind, normalizationState, canonicalId }) =>
          kind === "PROPOSED" && normalizationState === "NORMALIZED" && canonicalId,
      )
      .map(({ canonicalId }) => canonicalId!),
  );
  const excluded = new Set(ddi.excluded_canonical_ids);
  const submitted = new Set<string>();
  for (const medication of input.regimen) {
    if (
      submitted.has(medication.canonicalMedicationId) ||
      !candidates.has(medication.canonicalMedicationId) ||
      excluded.has(medication.canonicalMedicationId)
    ) {
      throw new McpToolError("MEDICATION_CANDIDATE_INVALID");
    }
    submitted.add(medication.canonicalMedicationId);
  }

  const findingRefs = new Set(ddi.findings.map(({ sourceRecordRef }) => sourceRecordRef));
  const rationaleRefs = new Set([...inputExecutionRefs, ...findingRefs]);
  if (
    input.regimen.some(
      ({ rationale, warningRefs }) =>
        rationale.some(({ sourceRef }) => !rationaleRefs.has(sourceRef)) ||
        warningRefs.some((sourceRef) => !findingRefs.has(sourceRef)),
    )
  ) {
    throw new McpToolError("PROVENANCE_MISMATCH");
  }
}

function materializeDraft(row: DraftRow): PrimaryPlanDraft {
  return {
    draftRef: row.draft_ref,
    draftRevision: Number(row.revision),
    aiImputationNoticeVisible: row.ai_imputation_notice_visible,
    schemaVersion: TREATMENT_PLAN_SCHEMA_VERSION,
    plan: row.plan_payload,
    sourceExecutionRefs: row.source_execution_refs,
    primaryDdiExecutionRef: row.primary_ddi_execution_ref,
    workflowRevision: Number(row.workflow_revision),
    inputRevision: Number(row.input_revision),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getPrimaryPlanDraft(
  pool: Pool,
  researchCaseId: string,
): Promise<PrimaryPlanDraft | null> {
  const result = await pool.query<DraftRow>(
    "SELECT * FROM insight.primary_treatment_plan_drafts WHERE research_case_id=$1",
    [researchCaseId],
  );
  return result.rows[0] ? materializeDraft(result.rows[0]) : null;
}

export function createTreatmentPlanToolHandlers(
  pool: Pool,
  resolveExecution: (context: TrustedToolContext) => Promise<PrimaryPlanExecution> = (context) =>
    loadPrimaryPlanExecution(pool, context),
): ToolHandlers {
  return {
    "treatment_plan.submit_primary": async (context, input) => {
      const draft = await submitPrimaryPlan(
        pool,
        await resolveExecution(context),
        input as unknown as PrimaryTreatmentPlanInput,
      );
      return {
        data: {
          draftRef: draft.draftRef,
          draftRevision: draft.draftRevision,
          aiImputationNoticeVisible: draft.aiImputationNoticeVisible,
        },
        knowledgeVersions: [`treatment-plan-schema:${TREATMENT_PLAN_SCHEMA_VERSION}`],
      };
    },
  };
}

export async function loadPrimaryPlanExecution(
  pool: Pool,
  context: TrustedToolContext,
): Promise<PrimaryPlanExecution> {
  const executionResult = await pool.query<ExecutionRow>(
    `SELECT execution.id,execution.research_case_id,execution.research_case_revision,
            execution.input_revision,job.requested_by_user_id
     FROM insight.model_agent_executions execution
     JOIN insight.jobs job ON job.id=execution.job_id
     WHERE execution.id=$1 AND execution.job_id=$2
       AND execution.workflow_state='GENERATING_PRIMARY_PLAN'`,
    [context.executionId, context.jobId],
  );
  const execution = executionResult.rows[0];
  if (!execution || Number(execution.research_case_revision) !== context.researchCaseRevision) {
    throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
  }
  const results = await pool.query<{ result_type: string; result_reference: string }>(
    `SELECT DISTINCT ON (result_type) result_type,result_reference
     FROM insight.research_case_domain_results
     WHERE research_case_id=$1 AND input_revision=$2 AND status='SUCCEEDED'
       AND invalidated_at IS NULL AND result_type=ANY($3::text[])
     ORDER BY result_type,recorded_at DESC,id DESC`,
    [execution.research_case_id, execution.input_revision, INPUT_RESULT_TYPES],
  );
  const primaryDdi = results.rows.find(({ result_type }) => result_type === "PRIMARY_DDI");
  const bnInference = results.rows.find(({ result_type }) => result_type === "BN_INFERENCE");
  if (!primaryDdi || !bnInference) throw new McpToolError("DEPENDENCY_UNAVAILABLE");
  const imputation = results.rows.find(
    ({ result_type }) => result_type === "ASSESSMENT_IMPUTATION",
  );
  return {
    executionId: execution.id,
    researchCaseId: execution.research_case_id,
    requestedByUserId: execution.requested_by_user_id,
    workflowRevision: Number(execution.research_case_revision),
    inputRevision: Number(execution.input_revision),
    inputExecutionRefs: sorted(results.rows.map(({ result_reference }) => result_reference)),
    primaryDdiExecutionRef: primaryDdi.result_reference,
    imputationSnapshotRef: imputation?.result_reference ?? null,
  };
}

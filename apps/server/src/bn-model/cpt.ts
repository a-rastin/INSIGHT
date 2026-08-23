import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PROBABILITY_TOLERANCE,
  expectedTableLength,
  findDefinition,
  parseXmlBif,
} from "@insight/bayes";
import { stableSerialize, type JsonValue } from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { TrustedToolContext } from "../deidentification/gateway.js";
import {
  canonicalProjectionInput,
  type ModelVisibleProjection,
} from "../deidentification/projections.js";
import { withTransaction } from "../database/transaction.js";
import { McpToolError, type ToolHandlers } from "../mcp/gateway.js";
import { INITIAL_BN_ROUTING_ARTIFACT } from "./routing.js";

export const CPT_PROMPT_VERSION = "1.0.0";
export const CPT_OUTPUT_SCHEMA_VERSION = "1.0.0";
export const MAX_CPT_GENERATION_ATTEMPTS = 3;

export interface CptNodeContract {
  readonly nodeRef: string;
  readonly outcomes: readonly string[];
  readonly orderedParentRefs: readonly string[];
  readonly requiredTableLength: number;
}

export interface CptGenerationContract {
  readonly routeRuleRef: string;
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly modelHash: string;
  readonly nodes: readonly CptNodeContract[];
}

export interface GeneratedCptTable {
  readonly nodeRef: string;
  readonly probabilities: readonly unknown[];
}

export interface CptValidationDiagnostic {
  readonly code: string;
  readonly nodeRef?: string;
  readonly tableIndex?: number;
  readonly rowIndex?: number;
  readonly expected?: number | string;
  readonly actual?: number | string;
}

export interface CptDependencyInput {
  readonly canonicalResearchCaseInput: string;
  readonly models: readonly {
    readonly modelRef: string;
    readonly modelVersion: string;
    readonly modelHash: string;
  }[];
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly endpointFingerprint: string;
  readonly requestedModel: string;
  readonly generationSettings: JsonValue;
  readonly imputationSnapshotRef?: string | null;
}

export interface CptExecution {
  readonly executionId: string;
  readonly jobId: string;
  readonly researchCaseId: string;
  readonly requestedByUserId: string;
  readonly workflowRevision: number;
  readonly inputRevision: number;
  readonly dependencies: CptDependencyInput;
}

export interface CptSnapshot {
  readonly snapshotRef: string;
  readonly snapshotHash: string;
  readonly modelRef: string;
  readonly tables: readonly {
    readonly nodeRef: string;
    readonly probabilities: readonly number[];
  }[];
}

interface RoutedModel {
  readonly modelId: string;
  readonly pathwayIdentity: string;
  readonly version: number;
  readonly contentSha256: string;
}

interface RoutingRow extends QueryResultRow {
  matched_rule_refs: string[];
  selected_models: RoutedModel[];
}

interface ModelArtifactRow extends QueryResultRow {
  id: string;
  pathway_identity: string;
  version: number;
  content_sha256: string;
  artifact_path: string;
}

interface ExecutionRow extends QueryResultRow {
  id: string;
  job_id: string;
  research_case_id: string;
  research_case_revision: string;
  input_revision: string;
  endpoint_fingerprint: string;
  prompt_version: string;
  input_payload: JsonValue;
  output_schema: { $id?: string };
  settings: JsonValue;
  requested_by_user_id: string;
  model: string;
  imputation_snapshot_ref: string | null;
}

interface SnapshotRow extends QueryResultRow {
  snapshot_ref: string;
  snapshot_hash: string;
  model_version_id: string;
  tables: { nodeRef: string; probabilities: number[] }[];
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function fingerprintCptDependencies(input: CptDependencyInput): string {
  return sha256(
    stableSerialize({
      canonicalResearchCaseInput: input.canonicalResearchCaseInput,
      models: input.models,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
      endpointFingerprint: input.endpointFingerprint,
      requestedModel: input.requestedModel,
      generationSettings: input.generationSettings,
      imputationSnapshotRef: input.imputationSnapshotRef ?? null,
    } as unknown as JsonValue),
  );
}

export function validateGeneratedCptTables(
  contract: CptGenerationContract,
  tables: readonly GeneratedCptTable[],
): CptValidationDiagnostic[] {
  const diagnostics: CptValidationDiagnostic[] = [];
  const expectedRefs = contract.nodes.map(({ nodeRef }) => nodeRef);
  const actualRefs = tables.map(({ nodeRef }) => nodeRef);
  const count = (values: readonly string[], value: string) =>
    values.reduce((total, candidate) => total + Number(candidate === value), 0);

  for (const nodeRef of expectedRefs) {
    if (count(actualRefs, nodeRef) === 0) diagnostics.push({ code: "CPT_NODE_MISSING", nodeRef });
    if (count(actualRefs, nodeRef) > 1) diagnostics.push({ code: "CPT_NODE_DUPLICATE", nodeRef });
  }
  for (const nodeRef of actualRefs) {
    if (!expectedRefs.includes(nodeRef) && count(actualRefs, nodeRef) === 1) {
      diagnostics.push({ code: "CPT_NODE_UNEXPECTED", nodeRef });
    }
  }
  if (
    actualRefs.length !== expectedRefs.length ||
    actualRefs.some((nodeRef, index) => nodeRef !== expectedRefs[index])
  ) {
    const mismatch = expectedRefs.findIndex((nodeRef, index) => nodeRef !== actualRefs[index]);
    const tableIndex = mismatch < 0 ? Math.min(expectedRefs.length, actualRefs.length) : mismatch;
    diagnostics.push({
      code: "CPT_NODE_ORDER",
      tableIndex,
      expected: expectedRefs[tableIndex] ?? "<none>",
      actual: actualRefs[tableIndex] ?? "<missing>",
    });
  }

  contract.nodes.forEach((node) => {
    const matches = tables.filter(({ nodeRef }) => nodeRef === node.nodeRef);
    if (matches.length !== 1) return;
    const probabilities = matches[0]!.probabilities;
    if (probabilities.length !== node.requiredTableLength) {
      diagnostics.push({
        code: "CPT_TABLE_DIMENSION",
        nodeRef: node.nodeRef,
        expected: node.requiredTableLength,
        actual: probabilities.length,
      });
    }
    probabilities.forEach((value, tableIndex) => {
      if (typeof value !== "number") {
        diagnostics.push({ code: "CPT_VALUE_NOT_NUMBER", nodeRef: node.nodeRef, tableIndex });
      } else if (!Number.isFinite(value)) {
        diagnostics.push({ code: "CPT_VALUE_NON_FINITE", nodeRef: node.nodeRef, tableIndex });
      } else if (value < 0) {
        diagnostics.push({
          code: "CPT_VALUE_NEGATIVE",
          nodeRef: node.nodeRef,
          tableIndex,
          actual: value,
        });
      }
    });
    if (probabilities.length !== node.requiredTableLength) return;
    for (let start = 0; start < probabilities.length; start += node.outcomes.length) {
      const row = probabilities.slice(start, start + node.outcomes.length);
      if (!row.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
      const sum = (row as number[]).reduce((total, value) => total + value, 0);
      if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
        diagnostics.push({
          code: "CPT_ROW_SUM",
          nodeRef: node.nodeRef,
          rowIndex: start / node.outcomes.length,
          expected: 1,
          actual: sum,
        });
      }
    }
  });
  return diagnostics;
}

export function evaluateCptAttempt(
  contract: CptGenerationContract,
  tables: readonly GeneratedCptTable[],
  previousAttemptCount: number,
): {
  readonly attemptNumber: number;
  readonly accepted: boolean;
  readonly retryable: boolean;
  readonly attemptsRemaining: number;
  readonly diagnostics: readonly CptValidationDiagnostic[];
} {
  if (!Number.isInteger(previousAttemptCount) || previousAttemptCount < 0) {
    throw new RangeError("Previous CPT attempt count is invalid.");
  }
  if (previousAttemptCount >= MAX_CPT_GENERATION_ATTEMPTS) {
    return {
      attemptNumber: MAX_CPT_GENERATION_ATTEMPTS,
      accepted: false,
      retryable: false,
      attemptsRemaining: 0,
      diagnostics: [{ code: "CPT_ATTEMPT_LIMIT" }],
    };
  }
  const diagnostics = validateGeneratedCptTables(contract, tables);
  const attemptNumber = previousAttemptCount + 1;
  return {
    attemptNumber,
    accepted: diagnostics.length === 0,
    retryable: diagnostics.length > 0 && attemptNumber < MAX_CPT_GENERATION_ATTEMPTS,
    attemptsRemaining: diagnostics.length > 0 ? MAX_CPT_GENERATION_ATTEMPTS - attemptNumber : 0,
    diagnostics,
  };
}

export async function getRoutedCptContracts(
  pool: Pool,
  execution: Pick<CptExecution, "researchCaseId" | "workflowRevision">,
  artifactRoot = resolve("artifacts"),
): Promise<readonly CptGenerationContract[]> {
  const routing = await pool.query<RoutingRow>(
    `SELECT matched_rule_refs,selected_models FROM insight.bn_routing_evaluations
     WHERE research_case_id=$1 AND research_case_revision=$2
     ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
    [execution.researchCaseId, execution.workflowRevision],
  );
  const decision = routing.rows[0];
  if (!decision) throw new McpToolError("DEPENDENCY_UNAVAILABLE");
  const contracts: CptGenerationContract[] = [];
  for (const [index, routed] of decision.selected_models.entries()) {
    const model = await pool.query<ModelArtifactRow>(
      `SELECT model.id,model.pathway_identity,model.version,artifact.content_sha256,
              artifact.artifact_path
       FROM insight.bn_research_case_model_pins pin
       JOIN insight.bn_model_versions model ON model.id=pin.model_version_id
       JOIN insight.bn_model_artifacts artifact ON artifact.id=model.artifact_id
       WHERE pin.research_case_id=$1 AND pin.model_version_id=$2
         AND pin.model_version=$3 AND pin.content_sha256=$4`,
      [execution.researchCaseId, routed.modelId, routed.version, routed.contentSha256],
    );
    const row = model.rows[0];
    if (!row) throw new McpToolError("PROVENANCE_MISMATCH");
    const parsed = parseXmlBif(await readFile(resolve(artifactRoot, row.artifact_path), "utf8"));
    if (!parsed.ok) throw new McpToolError("DEPENDENCY_UNAVAILABLE");
    const nodes = parsed.file.networks.flatMap((network) =>
      network.variables.flatMap((variable) => {
        if (variable.type !== "nature") return [];
        const definition = findDefinition(network, variable.name);
        const length = definition ? expectedTableLength(network, definition) : undefined;
        if (!definition || length === undefined) throw new McpToolError("PROVENANCE_MISMATCH");
        return [
          {
            nodeRef: variable.name,
            outcomes: [...variable.outcomes],
            orderedParentRefs: [...definition.given],
            requiredTableLength: length,
          },
        ];
      }),
    );
    if (nodes.length === 0 || new Set(nodes.map(({ nodeRef }) => nodeRef)).size !== nodes.length) {
      throw new McpToolError("PROVENANCE_MISMATCH");
    }
    const knownRule = INITIAL_BN_ROUTING_ARTIFACT.rules.find(
      ({ pathwayIdentity, ref }) =>
        pathwayIdentity === row.pathway_identity && decision.matched_rule_refs.includes(ref),
    );
    const routeRuleRef = knownRule?.ref ?? decision.matched_rule_refs[index];
    if (!routeRuleRef) throw new McpToolError("PROVENANCE_MISMATCH");
    contracts.push({
      routeRuleRef,
      modelRef: `bn-model-${row.content_sha256}`,
      modelVersion: String(row.version),
      modelHash: row.content_sha256,
      nodes,
    });
  }
  return contracts;
}

export async function findReusableCptSnapshots(
  pool: Pool,
  execution: CptExecution,
  contracts: readonly CptGenerationContract[],
): Promise<readonly CptSnapshot[] | null> {
  const fingerprint = fingerprintCptDependencies(execution.dependencies);
  const rows = await pool.query<SnapshotRow>(
    `SELECT snapshot.snapshot_ref,snapshot.snapshot_hash,snapshot.model_version_id,snapshot.tables
     FROM insight.bn_cpt_snapshots snapshot
     JOIN insight.bn_model_versions model ON model.id=snapshot.model_version_id
     JOIN insight.bn_model_artifacts artifact ON artifact.id=model.artifact_id
     WHERE snapshot.research_case_id=$1 AND snapshot.dependency_fingerprint=$2
       AND ('bn-model-' || artifact.content_sha256)=ANY($3::text[])
     ORDER BY model.pathway_identity,model.version`,
    [execution.researchCaseId, fingerprint, contracts.map(({ modelRef }) => modelRef)],
  );
  if (rows.rows.length !== contracts.length) return null;
  const byModelId = new Map(rows.rows.map((row) => [row.model_version_id, row]));
  const modelIds = await resolveModelIds(pool, contracts);
  if (modelIds.some(({ id }) => !byModelId.has(id))) return null;
  return modelIds.map(({ id, modelRef }) => {
    const row = byModelId.get(id)!;
    return {
      snapshotRef: row.snapshot_ref,
      snapshotHash: row.snapshot_hash,
      modelRef,
      tables: row.tables,
    };
  });
}

export async function ensureCptSnapshots(
  pool: Pool,
  execution: CptExecution,
  contracts: readonly CptGenerationContract[],
  invokeModel: () => Promise<void>,
): Promise<{ readonly reused: boolean; readonly snapshots: readonly CptSnapshot[] }> {
  const reusable = await findReusableCptSnapshots(pool, execution, contracts);
  if (reusable) return { reused: true, snapshots: reusable };
  await invokeModel();
  const generated = await findReusableCptSnapshots(pool, execution, contracts);
  if (!generated)
    throw new McpToolError("CPT_VALIDATION_FAILED", [{ code: "CPT_GENERATION_FAILED" }], false);
  return { reused: false, snapshots: generated };
}

export async function submitCptSnapshot(
  pool: Pool,
  execution: CptExecution,
  contract: CptGenerationContract,
  tables: readonly GeneratedCptTable[],
  now = new Date(),
): Promise<CptSnapshot> {
  if (
    !execution.dependencies.models.some(
      ({ modelRef, modelVersion, modelHash }) =>
        modelRef === contract.modelRef &&
        modelVersion === contract.modelVersion &&
        modelHash === contract.modelHash,
    )
  ) {
    throw new McpToolError("PROVENANCE_MISMATCH");
  }
  const dependencyFingerprint = fingerprintCptDependencies(execution.dependencies);
  const [{ id: modelId }] = await resolveModelIds(pool, [contract]);
  const pinned = await pool.query(
    `SELECT 1 FROM insight.bn_research_case_model_pins
     WHERE research_case_id=$1 AND model_version_id=$2`,
    [execution.researchCaseId, modelId],
  );
  if (pinned.rowCount !== 1) throw new McpToolError("PROVENANCE_MISMATCH");
  const outcome = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      execution.executionId,
      contract.modelRef,
    ]);
    const reusable = await loadSnapshot(
      client,
      execution.researchCaseId,
      modelId,
      dependencyFingerprint,
    );
    if (reusable) return { snapshot: materializeSnapshot(reusable, contract.modelRef) } as const;
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM insight.bn_cpt_attempts
       WHERE execution_id=$1 AND model_version_id=$2`,
      [execution.executionId, modelId],
    );
    const evaluation = evaluateCptAttempt(contract, tables, count.rows[0]!.count);
    if (evaluation.diagnostics.some(({ code }) => code === "CPT_ATTEMPT_LIMIT")) {
      return { evaluation } as const;
    }
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO insight.bn_cpt_attempts
         (execution_id,research_case_id,model_version_id,dependency_fingerprint,attempt_number,
          raw_response,diagnostics,accepted,created_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
       WHERE EXISTS (
         SELECT 1 FROM insight.research_cases
         WHERE id=$2 AND workflow_state='GENERATING_CPTS'
           AND workflow_revision=$10 AND input_revision=$11
       ) RETURNING id`,
      [
        execution.executionId,
        execution.researchCaseId,
        modelId,
        dependencyFingerprint,
        evaluation.attemptNumber,
        JSON.stringify(tables),
        JSON.stringify(evaluation.diagnostics),
        evaluation.accepted,
        now,
        execution.workflowRevision,
        execution.inputRevision,
      ],
    );
    if (!attempt.rows[0]) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
    if (!evaluation.accepted) {
      if (!evaluation.retryable)
        await recordFailedGeneration(client, execution, dependencyFingerprint, now);
      return { evaluation } as const;
    }
    const acceptedTables = tables.map(({ nodeRef, probabilities }) => ({
      nodeRef,
      probabilities: [...probabilities] as number[],
    }));
    const snapshotHash = sha256(stableSerialize(acceptedTables as unknown as JsonValue));
    const snapshotRef = `cpt-snapshot-${sha256(
      stableSerialize({
        researchCaseId: execution.researchCaseId,
        modelId,
        dependencyFingerprint,
        snapshotHash,
      } as unknown as JsonValue),
    )}`;
    const inserted = await client.query<SnapshotRow>(
      `INSERT INTO insight.bn_cpt_snapshots
         (snapshot_ref,research_case_id,model_version_id,dependency_fingerprint,
          dependency_manifest,snapshot_hash,tables,accepted_attempt_id,created_by_user_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING snapshot_ref,snapshot_hash,model_version_id,tables`,
      [
        snapshotRef,
        execution.researchCaseId,
        modelId,
        dependencyFingerprint,
        JSON.stringify(execution.dependencies),
        snapshotHash,
        JSON.stringify(acceptedTables),
        attempt.rows[0].id,
        execution.requestedByUserId,
        now,
      ],
    );
    return { snapshot: materializeSnapshot(inserted.rows[0]!, contract.modelRef) } as const;
  });
  if (outcome.evaluation) {
    throw new McpToolError(
      "CPT_VALIDATION_FAILED",
      {
        attemptNumber: outcome.evaluation.attemptNumber,
        attemptsRemaining: outcome.evaluation.attemptsRemaining,
        diagnostics: outcome.evaluation.diagnostics,
      } as unknown as JsonValue,
      outcome.evaluation.retryable,
    );
  }
  return outcome.snapshot;
}

export function createBnCptToolHandlers(
  pool: Pool,
  artifactRoot = resolve("artifacts"),
  resolveExecution: (context: TrustedToolContext) => Promise<CptExecution> = (context) =>
    loadCptExecution(pool, context, artifactRoot),
): ToolHandlers {
  return {
    "bn.get_routed_contracts": async (context) => ({
      data: (await getRoutedCptContracts(
        pool,
        await resolveExecution(context),
        artifactRoot,
      )) as unknown as JsonValue,
    }),
    "bn.submit_cpt_snapshot": async (context, input) => {
      const execution = await resolveExecution(context);
      const contracts = await getRoutedCptContracts(pool, execution, artifactRoot);
      const submission = input as unknown as { modelRef: string; tables: GeneratedCptTable[] };
      const contract = contracts.find(({ modelRef }) => modelRef === submission.modelRef);
      if (!contract) throw new McpToolError("INVALID_TOOL_INPUT");
      const snapshot = await submitCptSnapshot(pool, execution, contract, submission.tables);
      return {
        data: {
          status: "ACCEPTED",
          snapshotRef: snapshot.snapshotRef,
          snapshotHash: snapshot.snapshotHash,
        },
        knowledgeVersions: [
          `bn-model:${contract.modelVersion}`,
          `cpt-schema:${CPT_OUTPUT_SCHEMA_VERSION}`,
        ],
      };
    },
  };
}

export async function loadCptExecution(
  pool: Pool,
  context: TrustedToolContext,
  artifactRoot = resolve("artifacts"),
): Promise<CptExecution> {
  const result = await pool.query<ExecutionRow>(
    `SELECT execution.id,execution.job_id,execution.research_case_id,
            execution.research_case_revision,execution.input_revision,execution.endpoint_fingerprint,
            execution.prompt_version,execution.input_payload,execution.output_schema,execution.settings,
            job.requested_by_user_id,configuration.model,
            imputation.result_reference AS imputation_snapshot_ref
     FROM insight.model_agent_executions execution
     JOIN insight.jobs job ON job.id=execution.job_id
     JOIN insight.model_endpoint_configurations configuration
       ON configuration.id=execution.endpoint_configuration_id
     LEFT JOIN LATERAL (
       SELECT result_reference FROM insight.research_case_domain_results result
       WHERE result.research_case_id=execution.research_case_id
         AND result.input_revision=execution.input_revision
         AND result.result_type='ASSESSMENT_IMPUTATION' AND result.status='SUCCEEDED'
         AND result.invalidated_at IS NULL
       ORDER BY result.recorded_at DESC,result.id DESC LIMIT 1
     ) imputation ON true
     WHERE execution.id=$1 AND execution.job_id=$2
       AND execution.workflow_state='GENERATING_CPTS'`,
    [context.executionId, context.jobId],
  );
  const row = result.rows[0];
  if (!row || Number(row.research_case_revision) !== context.researchCaseRevision) {
    throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
  }
  const contracts = await getRoutedCptContracts(
    pool,
    {
      researchCaseId: row.research_case_id,
      workflowRevision: Number(row.research_case_revision),
    },
    artifactRoot,
  );
  const projection = row.input_payload as unknown as ModelVisibleProjection;
  return {
    executionId: row.id,
    jobId: row.job_id,
    researchCaseId: row.research_case_id,
    requestedByUserId: row.requested_by_user_id,
    workflowRevision: Number(row.research_case_revision),
    inputRevision: Number(row.input_revision),
    dependencies: {
      canonicalResearchCaseInput: canonicalProjectionInput(projection),
      models: contracts.map(({ modelRef, modelVersion, modelHash }) => ({
        modelRef,
        modelVersion,
        modelHash,
      })),
      promptVersion: row.prompt_version,
      schemaVersion: row.output_schema.$id ?? CPT_OUTPUT_SCHEMA_VERSION,
      endpointFingerprint: row.endpoint_fingerprint,
      requestedModel: row.model,
      generationSettings: row.settings,
      imputationSnapshotRef: row.imputation_snapshot_ref,
    },
  };
}

async function resolveModelIds(
  pool: Pool,
  contracts: readonly CptGenerationContract[],
): Promise<readonly { id: string; modelRef: string }[]> {
  const result = await pool.query<{ id: string; content_sha256: string }>(
    `SELECT model.id,artifact.content_sha256 FROM insight.bn_model_versions model
     JOIN insight.bn_model_artifacts artifact ON artifact.id=model.artifact_id
     WHERE artifact.content_sha256=ANY($1::text[])`,
    [contracts.map(({ modelHash }) => modelHash)],
  );
  return contracts.map((contract) => {
    const model = result.rows.find(({ content_sha256 }) => content_sha256 === contract.modelHash);
    if (!model) throw new McpToolError("PROVENANCE_MISMATCH");
    return { id: model.id, modelRef: contract.modelRef };
  });
}

async function loadSnapshot(
  client: PoolClient,
  researchCaseId: string,
  modelId: string,
  dependencyFingerprint: string,
): Promise<SnapshotRow | undefined> {
  const result = await client.query<SnapshotRow>(
    `SELECT snapshot_ref,snapshot_hash,model_version_id,tables FROM insight.bn_cpt_snapshots
     WHERE research_case_id=$1 AND model_version_id=$2 AND dependency_fingerprint=$3`,
    [researchCaseId, modelId, dependencyFingerprint],
  );
  return result.rows[0];
}

function materializeSnapshot(row: SnapshotRow, modelRef: string): CptSnapshot {
  return {
    snapshotRef: row.snapshot_ref,
    snapshotHash: row.snapshot_hash,
    modelRef,
    tables: row.tables,
  };
}

async function recordFailedGeneration(
  client: PoolClient,
  execution: CptExecution,
  fingerprint: string,
  now: Date,
): Promise<void> {
  await client.query("SELECT set_config('insight.workflow_transition','allowed',true)");
  await client.query(
    `INSERT INTO insight.research_case_domain_results
       (research_case_id,result_type,status,workflow_revision,input_revision,result_reference,
        provenance,recorded_by_user_id,recorded_at)
     SELECT $1,'CPT_SNAPSHOT','FAILED',$2,$3,$4,$5,$6,$7
     WHERE NOT EXISTS (
       SELECT 1 FROM insight.research_case_domain_results
       WHERE research_case_id=$1 AND result_type='CPT_SNAPSHOT' AND status='FAILED'
         AND workflow_revision=$2 AND input_revision=$3 AND result_reference=$4
     )`,
    [
      execution.researchCaseId,
      execution.workflowRevision,
      execution.inputRevision,
      `cpt-generation-failed:${fingerprint}`,
      { code: "CPT_GENERATION_FAILED", executionId: execution.executionId },
      execution.requestedByUserId,
      now,
    ],
  );
}

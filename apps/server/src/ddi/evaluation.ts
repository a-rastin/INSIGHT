import { createHash } from "node:crypto";

import { stableSerialize, type DdiExtractedInteraction, type JsonValue } from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { TrustedToolContext } from "../deidentification/gateway.js";
import { DDI_TRANSFORM_VERSION, MEDSCAPE_PARSER_VERSION } from "../ddi-source/governance.js";
import { McpToolError, type ToolHandlers } from "../mcp/gateway.js";
import { withTransaction } from "../database/transaction.js";

export type DdiPurpose = "PRIMARY_FILTER" | "FINAL_RECHECK";

export interface DdiRegimenMedication {
  readonly medicationEntryRef: string;
  readonly kind: "CURRENT" | "PROPOSED";
  readonly normalizationState: "NORMALIZED" | "UNKNOWN";
  readonly canonicalId?: string;
  readonly regimenDetails?: JsonValue;
}

export interface DdiPair {
  readonly leftCanonicalId: string;
  readonly rightCanonicalId: string;
}

export interface DdiExecutionContext {
  readonly toolExecutionId: string;
  readonly researchCaseId: string;
  readonly requestedByUserId: string;
  readonly workflowRevision: number;
  readonly inputRevision: number;
}

interface SourceRow extends QueryResultRow {
  id: string;
  version: number;
  drug_identity: string;
  content_hash: string;
  parser_version: string;
  transform_version: string;
  permission_record: {
    status: string;
    coversStorage: boolean;
    coversTransformation: boolean;
    coversResearchUse: boolean;
  };
  interactions: DdiExtractedInteraction[];
  lifecycle: string;
  legal_approval_reference: string | null;
  clinical_approval_reference: string | null;
}

interface KnownMedication {
  canonicalId: string;
  kinds: Set<DdiRegimenMedication["kind"]>;
}

interface DdiFinding {
  leftCanonicalId: string;
  rightCanonicalId: string;
  severity: string;
  mechanism?: string;
  clinicalEffect?: string;
  recommendedAction?: string;
  sourceRecordRef: string;
}

export interface DdiEvaluationOutput {
  readonly executionRef: string;
  readonly sourceVersion: string;
  readonly evaluatedCanonicalIds: readonly string[];
  readonly unknownMedicationEntryRefs: readonly string[];
  readonly omittedPairCount: number;
  readonly excludedCanonicalIds: readonly string[];
  readonly findings: readonly DdiFinding[];
}

export interface DdiExecution extends DdiEvaluationOutput {
  readonly purpose: DdiPurpose;
  readonly exactRegimen: readonly DdiRegimenMedication[];
  readonly evaluatedPairs: readonly DdiPair[];
  readonly sourceVersions: readonly string[];
  readonly workflowRevision: number;
  readonly inputRevision: number;
  readonly executedAt: string;
}

const identity = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const hash = (value: unknown) =>
  createHash("sha256")
    .update(stableSerialize(value as JsonValue))
    .digest("hex");

function pairInScope(
  purpose: DdiPurpose,
  leftKinds: ReadonlySet<DdiRegimenMedication["kind"]>,
  rightKinds: ReadonlySet<DdiRegimenMedication["kind"]>,
): boolean {
  return purpose === "FINAL_RECHECK" || leftKinds.has("CURRENT") || rightKinds.has("CURRENT");
}

export function enumerateDdiPairs(
  purpose: DdiPurpose,
  regimen: readonly DdiRegimenMedication[],
): {
  readonly knownCanonicalIds: readonly string[];
  readonly unknownMedicationEntryRefs: readonly string[];
  readonly omittedPairCount: number;
  readonly pairs: readonly DdiPair[];
} {
  const known = new Map<string, KnownMedication>();
  const unknown = regimen
    .filter(({ normalizationState }) => normalizationState === "UNKNOWN")
    .sort((left, right) => left.medicationEntryRef.localeCompare(right.medicationEntryRef));
  for (const medication of regimen) {
    if (medication.normalizationState !== "NORMALIZED" || !medication.canonicalId) continue;
    const key = identity(medication.canonicalId);
    const existing = known.get(key);
    if (existing) existing.kinds.add(medication.kind);
    else known.set(key, { canonicalId: medication.canonicalId, kinds: new Set([medication.kind]) });
  }
  const medications = [...known.values()].sort((left, right) =>
    identity(left.canonicalId).localeCompare(identity(right.canonicalId)),
  );
  const pairs: DdiPair[] = [];
  for (let left = 0; left < medications.length; left += 1) {
    for (let right = left + 1; right < medications.length; right += 1) {
      const a = medications[left]!;
      const b = medications[right]!;
      if (pairInScope(purpose, a.kinds, b.kinds)) {
        pairs.push({ leftCanonicalId: a.canonicalId, rightCanonicalId: b.canonicalId });
      }
    }
  }
  let omittedPairCount = 0;
  for (const omitted of unknown) {
    const omittedKinds = new Set([omitted.kind]);
    omittedPairCount += medications.filter((knownMedication) =>
      pairInScope(purpose, omittedKinds, knownMedication.kinds),
    ).length;
  }
  for (let left = 0; left < unknown.length; left += 1) {
    for (let right = left + 1; right < unknown.length; right += 1) {
      if (pairInScope(purpose, new Set([unknown[left]!.kind]), new Set([unknown[right]!.kind]))) {
        omittedPairCount += 1;
      }
    }
  }
  return {
    knownCanonicalIds: medications.map(({ canonicalId }) => canonicalId),
    unknownMedicationEntryRefs: unknown.map(({ medicationEntryRef }) => medicationEntryRef),
    omittedPairCount,
    pairs,
  };
}

export async function evaluateDdiRegimen(
  pool: Pool,
  execution: DdiExecutionContext,
  purpose: DdiPurpose,
  medicationEntryRefs: readonly string[],
  regimen: readonly DdiRegimenMedication[],
  now = new Date(),
): Promise<DdiEvaluationOutput> {
  const requestedRefs = [...medicationEntryRefs].sort();
  const exactRegimen = [...regimen].sort((left, right) =>
    left.medicationEntryRef.localeCompare(right.medicationEntryRef),
  );
  if (
    exactRegimen.length !== requestedRefs.length ||
    exactRegimen.some(
      ({ medicationEntryRef }, index) => medicationEntryRef !== requestedRefs[index],
    ) ||
    exactRegimen.some(
      (medication) =>
        (medication.normalizationState === "NORMALIZED") !== Boolean(medication.canonicalId),
    )
  ) {
    throw new McpToolError("INVALID_TOOL_INPUT");
  }
  const enumeration = enumerateDdiPairs(purpose, exactRegimen);
  return withTransaction(pool, async (client) => {
    const sources = await loadActiveSources(client, enumeration.knownCanonicalIds);
    const findings = findingsForPairs(enumeration.pairs, sources);
    const excludedCanonicalIds =
      purpose === "PRIMARY_FILTER"
        ? [
            ...new Set(
              findings.flatMap(({ leftCanonicalId, rightCanonicalId }) => [
                leftCanonicalId,
                rightCanonicalId,
              ]),
            ),
          ].sort((left, right) => identity(left).localeCompare(identity(right)))
        : [];
    const sourcePins = sources.map((source) => sourcePin(source));
    const sourceVersion = `ddi-source-set-${hash(sourcePins)}`;
    const executionRef = `ddi-execution-${hash({
      toolExecutionId: execution.toolExecutionId,
      purpose,
      exactRegimen,
      pairs: enumeration.pairs,
      sourcePins,
      findings,
      workflowRevision: execution.workflowRevision,
      inputRevision: execution.inputRevision,
    })}`;
    const output: DdiEvaluationOutput = {
      executionRef,
      sourceVersion,
      evaluatedCanonicalIds: [...enumeration.knownCanonicalIds],
      unknownMedicationEntryRefs: [...enumeration.unknownMedicationEntryRefs],
      omittedPairCount: enumeration.omittedPairCount,
      excludedCanonicalIds,
      findings,
    };
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      execution.toolExecutionId,
      purpose,
    ]);
    const existing = await client.query<{ execution_ref: string }>(
      `SELECT execution_ref FROM insight.ddi_executions
       WHERE tool_execution_id=$1 AND purpose=$2`,
      [execution.toolExecutionId, purpose],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].execution_ref !== executionRef) {
        throw new McpToolError("PROVENANCE_MISMATCH");
      }
      return output;
    }
    const inserted = await client.query(
      `INSERT INTO insight.ddi_executions
         (execution_ref,tool_execution_id,research_case_id,requested_by_user_id,purpose,
          workflow_revision,input_revision,exact_regimen,evaluated_pairs,source_versions,
          source_version,unknown_medication_entry_refs,omitted_pair_count,findings,
          excluded_canonical_ids,executed_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       WHERE EXISTS (
         SELECT 1 FROM insight.research_cases
         WHERE id=$3 AND workflow_revision=$6 AND input_revision=$7
       )`,
      [
        executionRef,
        execution.toolExecutionId,
        execution.researchCaseId,
        execution.requestedByUserId,
        purpose,
        execution.workflowRevision,
        execution.inputRevision,
        JSON.stringify(exactRegimen),
        JSON.stringify(enumeration.pairs),
        JSON.stringify(sourcePins),
        sourceVersion,
        JSON.stringify(enumeration.unknownMedicationEntryRefs),
        enumeration.omittedPairCount,
        JSON.stringify(findings),
        JSON.stringify(excludedCanonicalIds),
        now,
      ],
    );
    if (inserted.rowCount !== 1) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
    return output;
  });
}

export function createDdiToolHandlers(
  pool: Pool,
  resolveExecution: (context: TrustedToolContext) => Promise<DdiExecutionContext> = (context) =>
    loadExecution(pool, context),
  resolveRegimen: (
    execution: DdiExecutionContext,
    purpose: DdiPurpose,
    medicationEntryRefs: readonly string[],
  ) => Promise<readonly DdiRegimenMedication[]> = (execution, purpose, refs) =>
    loadRegimen(pool, execution, purpose, refs),
): ToolHandlers {
  return {
    "ddi.evaluate_regimen": async (context, input) => {
      const { purpose, medicationEntryRefs } = input as {
        purpose: DdiPurpose;
        medicationEntryRefs: string[];
      };
      if ((context.workflowState === "CHECKING_PRIMARY_DDI") !== (purpose === "PRIMARY_FILTER")) {
        throw new McpToolError("INVALID_TOOL_INPUT");
      }
      const execution = await resolveExecution(context);
      const output = await evaluateDdiRegimen(
        pool,
        execution,
        purpose,
        medicationEntryRefs,
        await resolveRegimen(execution, purpose, medicationEntryRefs),
      );
      return {
        data: output as unknown as JsonValue,
        knowledgeVersions: [`ddi-source-set:${output.sourceVersion}`],
        warnings:
          output.unknownMedicationEntryRefs.length > 0
            ? [
                {
                  code: "UNKNOWN_MEDICATIONS_OMITTED",
                  safeMessage: "Unknown medications were omitted from DDI pairs.",
                },
              ]
            : [],
      };
    },
  };
}

async function loadActiveSources(
  client: PoolClient,
  canonicalIds: readonly string[],
): Promise<SourceRow[]> {
  const result = await client.query<SourceRow>(
    `SELECT source.*,latest.lifecycle,latest.legal_approval_reference,
            latest.clinical_approval_reference
     FROM insight.ddi_source_versions source
     JOIN insight.ddi_active_sources active ON active.source_version_id=source.id
     JOIN LATERAL (
       SELECT lifecycle,legal_approval_reference,clinical_approval_reference
       FROM insight.ddi_source_lifecycle_events event
       WHERE event.source_version_id=source.id ORDER BY sequence DESC LIMIT 1
     ) latest ON true
     WHERE lower(normalize(source.drug_identity,NFKC))=ANY($1::text[])
     ORDER BY lower(normalize(source.drug_identity,NFKC)),source.version`,
    [canonicalIds.map(identity)],
  );
  const byIdentity = new Map(result.rows.map((source) => [identity(source.drug_identity), source]));
  if (canonicalIds.some((canonicalId) => !byIdentity.has(identity(canonicalId)))) {
    throw new McpToolError("DDI_SOURCE_DISABLED");
  }
  const sources = canonicalIds.map((canonicalId) => byIdentity.get(identity(canonicalId))!);
  for (const source of sources) {
    if (
      source.lifecycle !== "active" ||
      source.parser_version !== MEDSCAPE_PARSER_VERSION ||
      source.transform_version !== DDI_TRANSFORM_VERSION ||
      !source.legal_approval_reference ||
      !source.clinical_approval_reference ||
      source.permission_record.status !== "granted" ||
      !source.permission_record.coversStorage ||
      !source.permission_record.coversTransformation ||
      !source.permission_record.coversResearchUse
    ) {
      throw new McpToolError("DDI_SOURCE_DISABLED");
    }
    if (
      source.interactions.some(
        ({ evidenceReference }) => evidenceReference.sourceSha256 !== source.content_hash,
      )
    ) {
      throw new McpToolError("PROVENANCE_MISMATCH");
    }
  }
  return sources;
}

function findingsForPairs(pairs: readonly DdiPair[], sources: readonly SourceRow[]): DdiFinding[] {
  const sourceByIdentity = new Map(
    sources.map((source) => [identity(source.drug_identity), source]),
  );
  const findings: DdiFinding[] = [];
  for (const pair of pairs) {
    for (const owner of [pair.leftCanonicalId, pair.rightCanonicalId]) {
      const source = sourceByIdentity.get(identity(owner))!;
      const partner =
        identity(owner) === identity(pair.leftCanonicalId)
          ? pair.rightCanonicalId
          : pair.leftCanonicalId;
      for (const interaction of source.interactions) {
        const interactingDrugIdentity =
          interaction.interactingDrugIdentity ?? interactionIdentity(interaction.evidenceText);
        if (!interactingDrugIdentity) throw new McpToolError("PROVENANCE_MISMATCH");
        if (identity(interactingDrugIdentity) !== identity(partner)) continue;
        findings.push({
          ...pair,
          severity: interaction.severity,
          ...(interaction.mechanism ? { mechanism: interaction.mechanism } : {}),
          ...(interaction.clinicalEffect ? { clinicalEffect: interaction.clinicalEffect } : {}),
          ...(interaction.recommendedAction
            ? { recommendedAction: interaction.recommendedAction }
            : {}),
          sourceRecordRef: `ddi-record-${source.content_hash}-L${interaction.evidenceReference.lineStart}`,
        });
      }
    }
  }
  return findings.sort((left, right) =>
    `${identity(left.leftCanonicalId)}\0${identity(left.rightCanonicalId)}\0${left.sourceRecordRef}`.localeCompare(
      `${identity(right.leftCanonicalId)}\0${identity(right.rightCanonicalId)}\0${right.sourceRecordRef}`,
    ),
  );
}

function interactionIdentity(evidenceText: string): string | undefined {
  const match = /^[•*-]\s+([^:]+):/.exec(evidenceText);
  return match?.[1]?.trim() || undefined;
}

function sourcePin(source: SourceRow): string {
  return `ddi-source-${identity(source.drug_identity)}-v${source.version}-${source.content_hash}`;
}

async function loadExecution(
  pool: Pool,
  context: TrustedToolContext,
): Promise<DdiExecutionContext> {
  const result = await pool.query<{
    research_case_id: string;
    requested_by_user_id: string;
    research_case_revision: string;
    input_revision: string;
  }>(
    `SELECT execution.research_case_id,job.requested_by_user_id,
            execution.research_case_revision,execution.input_revision
     FROM insight.model_agent_executions execution
     JOIN insight.jobs job ON job.id=execution.job_id
     WHERE execution.id=$1 AND execution.job_id=$2
       AND execution.research_case_revision=$3`,
    [context.executionId, context.jobId, context.researchCaseRevision],
  );
  const row = result.rows[0];
  if (!row) throw new McpToolError("PROVENANCE_MISMATCH");
  return {
    toolExecutionId: context.executionId,
    researchCaseId: row.research_case_id,
    requestedByUserId: row.requested_by_user_id,
    workflowRevision: Number(row.research_case_revision),
    inputRevision: Number(row.input_revision),
  };
}

async function loadRegimen(
  pool: Pool,
  execution: DdiExecutionContext,
  purpose: DdiPurpose,
  refs: readonly string[],
): Promise<DdiRegimenMedication[]> {
  const result: DdiRegimenMedication[] = [];
  for (const ref of refs) {
    const match = /^current-([1-9][0-9]*)$/.exec(ref);
    if (!match) throw new McpToolError("INVALID_TOOL_INPUT");
    const entry = await pool.query<{
      normalization_state: "NORMALIZED" | "UNKNOWN" | null;
      canonical_medication_id: string | null;
    }>(
      `SELECT normalization_state,canonical_medication_id
       FROM insight.current_medication_entries
       WHERE research_case_id=$1 AND position=$2`,
      [execution.researchCaseId, Number(match[1]) - 1],
    );
    if (!entry.rows[0]?.normalization_state) throw new McpToolError("INVALID_TOOL_INPUT");
    result.push({
      medicationEntryRef: ref,
      kind: "CURRENT",
      normalizationState: entry.rows[0].normalization_state,
      ...(entry.rows[0].canonical_medication_id
        ? { canonicalId: entry.rows[0].canonical_medication_id }
        : {}),
    });
  }
  void purpose;
  return result;
}

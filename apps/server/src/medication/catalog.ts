import type {
  MedicationCatalogEntryInput,
  MedicationCatalogInput,
  MedicationCatalogVersion,
  JsonValue,
  Role,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import type { TrustedToolContext } from "../deidentification/gateway.js";
import { McpToolError, type ToolHandlers } from "../mcp/gateway.js";

export interface MedicationActor {
  readonly id: string;
  readonly role: Role;
}

export interface MedicationExecution {
  readonly executionId: string;
  readonly researchCaseId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly catalogVersion?: number;
  readonly researchCaseRevision?: number;
  readonly inputRevision?: number;
  readonly leaseOwner?: string;
  readonly attempt?: number;
  readonly jobId?: string;
}

interface VersionRow extends QueryResultRow {
  id: string;
  version: number;
  created_by_user_id: string;
  created_at: Date;
  active: boolean;
}

interface EntryRow extends QueryResultRow {
  catalog_version_id: string;
  canonical_id: string;
  preferred_name: string;
  synonyms: string[];
  normalized_terms: string[];
}

interface CandidateSetRow extends QueryResultRow {
  id: string;
  catalog_version_id: string;
  catalog_version: number;
  raw_text: string;
  candidates: MedicationCandidate[];
  model: string;
  prompt_version: string;
  schema_version: string;
}

interface MedicationCandidate {
  canonicalId: string;
  preferredName: string;
  synonyms: string[];
}

export class MedicationAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to govern the medication catalog.");
    this.name = "MedicationAuthorizationError";
  }
}

export class MedicationCatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedicationCatalogInputError";
  }
}

export function normalizeMedicationSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function validateMedicationCatalogInput(
  input: MedicationCatalogInput,
): MedicationCatalogInput {
  const entries = input.entries.map((entry) => {
    const canonicalId = required(entry.canonicalId, "Canonical ID");
    const preferredName = required(entry.preferredName, "Preferred name");
    const synonyms = entry.synonyms.map((synonym) => required(synonym, "Synonym"));
    const normalized = [preferredName, ...synonyms].map(normalizeMedicationSearch);
    if (normalized.some((term) => !term))
      throw new MedicationCatalogInputError("Search term is empty.");
    if (new Set(normalized).size !== normalized.length) {
      throw new MedicationCatalogInputError(
        "Medication names and synonyms must be unique per entry.",
      );
    }
    return { canonicalId, preferredName, synonyms };
  });
  if (new Set(entries.map(({ canonicalId }) => canonicalId)).size !== entries.length) {
    throw new MedicationCatalogInputError("Canonical IDs must be unique.");
  }
  return { entries };
}

export async function saveMedicationCatalog(
  pool: Pool,
  actor: MedicationActor,
  input: MedicationCatalogInput,
  now = new Date(),
): Promise<MedicationCatalogVersion> {
  requireAdministrator(actor);
  const catalog = validateMedicationCatalogInput(input);
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT active_version_id FROM insight.medication_catalog_state WHERE singleton=true FOR UPDATE",
    );
    const next = await client.query<{ version: number }>(
      "SELECT coalesce(max(version),0)::integer+1 AS version FROM insight.medication_catalog_versions",
    );
    const inserted = await client.query<VersionRow>(
      `INSERT INTO insight.medication_catalog_versions (version,created_by_user_id,created_at)
       VALUES ($1,$2,$3) RETURNING id,version,created_by_user_id,created_at,false AS active`,
      [next.rows[0]!.version, actor.id, now],
    );
    const version = inserted.rows[0]!;
    await client.query("SELECT set_config('insight.medication_catalog_write','allowed',true)");
    await insertEntries(client, version.id, catalog.entries);
    await client.query(
      `UPDATE insight.medication_catalog_state
       SET active_version_id=$1,activated_by_user_id=$2,activated_at=$3 WHERE singleton=true`,
      [version.id, actor.id, now],
    );
    return { ...materializeVersion(version, catalog.entries), active: true };
  });
}

export async function getMedicationCatalogHistory(
  pool: Pool,
  actor: MedicationActor,
): Promise<readonly MedicationCatalogVersion[]> {
  requireAdministrator(actor);
  return loadVersions(pool);
}

export function createMedicationToolHandlers(
  pool: Pool,
  resolveExecution: (context: TrustedToolContext) => Promise<MedicationExecution> = (context) =>
    loadExecution(pool, context),
): ToolHandlers {
  return {
    "medication.search_candidates": async (context, input) => {
      const { medicationEntryRef, query } = input as {
        medicationEntryRef: string;
        query: string;
      };
      const execution = await resolveExecution(context);
      const result = await searchMedicationCandidates(pool, execution, medicationEntryRef, query);
      return {
        data: result as unknown as JsonValue,
        knowledgeVersions: [`medication-catalog:${result.catalogVersion}`],
      };
    },
    "medication.commit_mapping": async (context, input) => {
      const selection = input as {
        medicationEntryRef: string;
        catalogVersion: string;
        selectedCanonicalId: string | null;
      };
      return {
        data: (await commitMedicationMapping(
          pool,
          await resolveExecution(context),
          selection.medicationEntryRef,
          selection.catalogVersion,
          selection.selectedCanonicalId,
        )) as JsonValue,
        knowledgeVersions: [`medication-catalog:${selection.catalogVersion}`],
      };
    },
  };
}

export async function searchMedicationCandidates(
  pool: Pool,
  execution: MedicationExecution,
  medicationEntryRef: string,
  query: string,
  now = new Date(),
): Promise<{ catalogVersion: string; candidates: MedicationCandidate[] }> {
  void query;
  return withTransaction(pool, async (client) => {
    const rawText = await medicationRawText(client, execution.researchCaseId, medicationEntryRef);
    const normalizedQuery = normalizeMedicationSearch(rawText) || "unsearchable";
    const version = execution.catalogVersion
      ? await client.query<VersionRow>(
          `SELECT id,version,created_by_user_id,created_at,false AS active
           FROM insight.medication_catalog_versions WHERE version=$1`,
          [execution.catalogVersion],
        )
      : await client.query<VersionRow>(
          `SELECT version.id,version.version,version.created_by_user_id,version.created_at,true AS active
           FROM insight.medication_catalog_state state
           JOIN insight.medication_catalog_versions version ON version.id=state.active_version_id
           WHERE state.singleton=true`,
        );
    if (!version.rows[0]) throw new McpToolError("KNOWLEDGE_VERSION_INACTIVE");
    const entries = await client.query<EntryRow>(
      `SELECT catalog_version_id,canonical_id,preferred_name,synonyms,normalized_terms
       FROM insight.medication_catalog_entries WHERE catalog_version_id=$1`,
      [version.rows[0].id],
    );
    const candidates = entries.rows
      .map((entry) => ({ entry, score: matchScore(normalizedQuery, entry.normalized_terms) }))
      .filter(({ score }) => score !== null)
      .sort(
        (left, right) =>
          left.score! - right.score! ||
          (left.entry.canonical_id < right.entry.canonical_id
            ? -1
            : left.entry.canonical_id > right.entry.canonical_id
              ? 1
              : 0),
      )
      .slice(0, 100)
      .map(({ entry }) => ({
        canonicalId: entry.canonical_id,
        preferredName: entry.preferred_name,
        synonyms: entry.synonyms,
      }));
    const inserted = await client.query(
      `INSERT INTO insight.medication_candidate_sets
         (execution_id,research_case_id,medication_entry_ref,catalog_version_id,catalog_version,
           raw_text,normalized_text,candidates,model,prompt_version,schema_version,searched_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        WHERE $13::text IS NULL OR EXISTS (
          SELECT 1 FROM insight.jobs job
          WHERE job.id=$14 AND job.status='RUNNING' AND job.lease_owner=$13
            AND job.attempt_count=$15 AND job.lease_expires_at>clock_timestamp()
        )`,
      [
        execution.executionId,
        execution.researchCaseId,
        medicationEntryRef,
        version.rows[0].id,
        version.rows[0].version,
        rawText,
        normalizedQuery,
        JSON.stringify(candidates),
        execution.model,
        execution.promptVersion,
        execution.schemaVersion,
        now,
        execution.leaseOwner ?? null,
        execution.jobId ?? null,
        execution.attempt ?? null,
      ],
    );
    if (inserted.rowCount !== 1) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
    return { catalogVersion: catalogRef(version.rows[0].version), candidates };
  });
}

export async function commitMedicationMapping(
  pool: Pool,
  execution: MedicationExecution,
  medicationEntryRef: string,
  catalogVersion: string,
  selectedCanonicalId: string | null,
  now = new Date(),
): Promise<
  | { normalizationState: "UNKNOWN" }
  | { normalizationState: "NORMALIZED"; canonicalId: string; preferredName: string }
> {
  const version = parseCatalogRef(catalogVersion);
  return withTransaction(pool, async (client) => {
    const sets = await client.query<CandidateSetRow>(
      `SELECT candidate_set.id,candidate_set.catalog_version_id,candidate_set.catalog_version,
              candidate_set.raw_text,candidate_set.candidates,candidate_set.model,
              candidate_set.prompt_version,candidate_set.schema_version
       FROM insight.medication_candidate_sets candidate_set
       WHERE execution_id=$1 AND research_case_id=$2 AND medication_entry_ref=$3
         AND catalog_version=$4 ORDER BY searched_at DESC,id DESC FOR UPDATE`,
      [execution.executionId, execution.researchCaseId, medicationEntryRef, version],
    );
    const candidateSet = selectedCanonicalId
      ? sets.rows.find(({ candidates }) =>
          candidates.some(({ canonicalId }) => canonicalId === selectedCanonicalId),
        )
      : sets.rows[0];
    if (!candidateSet) throw new McpToolError("MEDICATION_CANDIDATE_INVALID");
    const candidate = selectedCanonicalId
      ? candidateSet.candidates.find(({ canonicalId }) => canonicalId === selectedCanonicalId)
      : undefined;
    if (selectedCanonicalId && !candidate) throw new McpToolError("MEDICATION_CANDIDATE_INVALID");

    const existing = await client.query<{
      normalization_state: "NORMALIZED" | "UNKNOWN";
      canonical_id: string | null;
      preferred_name: string | null;
    }>(
      `SELECT normalization_state,canonical_id,preferred_name FROM insight.medication_mappings
       WHERE execution_id=$1 AND research_case_id=$2 AND medication_entry_ref=$3`,
      [execution.executionId, execution.researchCaseId, medicationEntryRef],
    );
    if (existing.rows[0]) {
      if ((existing.rows[0].canonical_id ?? null) !== selectedCanonicalId) {
        throw new McpToolError("MEDICATION_CANDIDATE_INVALID");
      }
      return mappingOutput(existing.rows[0]);
    }

    const state = candidate ? "NORMALIZED" : "UNKNOWN";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO insight.medication_mappings
         (candidate_set_id,execution_id,research_case_id,medication_entry_ref,catalog_version_id,
          catalog_version,raw_text,candidates,normalization_state,canonical_id,preferred_name,
          model,prompt_version,schema_version,selected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        candidateSet.id,
        execution.executionId,
        execution.researchCaseId,
        medicationEntryRef,
        candidateSet.catalog_version_id,
        candidateSet.catalog_version,
        candidateSet.raw_text,
        JSON.stringify(candidateSet.candidates),
        state,
        candidate?.canonicalId ?? null,
        candidate?.preferredName ?? null,
        candidateSet.model,
        candidateSet.prompt_version,
        candidateSet.schema_version,
        now,
      ],
    );
    await client.query("SELECT set_config('insight.medical_history_write','allowed',true)");
    const target = medicationTarget(medicationEntryRef);
    const updated = await client.query(
      `UPDATE insight.${target.table}
       SET normalization_state=$1,canonical_medication_id=$2,medication_mapping_id=$3,
           medication_catalog_version_id=$4
         WHERE research_case_id=$5 AND position=$6 AND ${target.rawColumn}=$7
           AND normalization_state IS NULL
           AND ($8::bigint IS NULL OR EXISTS (
            SELECT 1 FROM insight.research_cases research_case
            WHERE research_case.id=$5 AND research_case.workflow_state='NORMALIZING_MEDICATIONS'
              AND research_case.workflow_revision=$8 AND research_case.input_revision=$9
          ))
          AND ($10::text IS NULL OR EXISTS (
            SELECT 1 FROM insight.jobs job
            WHERE job.id=$11 AND job.status='RUNNING' AND job.lease_owner=$10
              AND job.attempt_count=$12 AND job.lease_expires_at>clock_timestamp()
          ))`,
      [
        state,
        candidate?.canonicalId ?? null,
        inserted.rows[0]!.id,
        candidateSet.catalog_version_id,
        execution.researchCaseId,
        target.position,
        candidateSet.raw_text,
        execution.researchCaseRevision ?? null,
        execution.inputRevision ?? null,
        execution.leaseOwner ?? null,
        execution.jobId ?? null,
        execution.attempt ?? null,
      ],
    );
    if (updated.rowCount !== 1) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
    return candidate
      ? {
          normalizationState: "NORMALIZED",
          canonicalId: candidate.canonicalId,
          preferredName: candidate.preferredName,
        }
      : { normalizationState: "UNKNOWN" };
  });
}

function matchScore(query: string, terms: readonly string[]): number | null {
  if (terms.includes(query)) return 0;
  if (terms.some((term) => term.startsWith(query) || query.startsWith(term))) return 1;
  if (terms.some((term) => term.includes(query) || query.includes(term))) return 2;
  const tokens = query.split(" ");
  return terms.some((term) => tokens.every((token) => term.includes(token))) ? 3 : null;
}

function medicationTarget(ref: string) {
  const match = /^(current|prior)-([1-9][0-9]*)$/.exec(ref);
  if (!match) throw new McpToolError("INVALID_TOOL_INPUT");
  return match[1] === "current"
    ? {
        table: "current_medication_entries",
        rawColumn: "raw_medication",
        position: Number(match[2]) - 1,
      }
    : {
        table: "prior_antipsychotic_trials",
        rawColumn: "medication",
        position: Number(match[2]) - 1,
      };
}

async function medicationRawText(client: PoolClient, researchCaseId: string, ref: string) {
  const target = medicationTarget(ref);
  const result = await client.query<{ raw_text: string }>(
    `SELECT ${target.rawColumn} AS raw_text FROM insight.${target.table}
     WHERE research_case_id=$1 AND position=$2`,
    [researchCaseId, target.position],
  );
  if (!result.rows[0]) throw new McpToolError("INVALID_TOOL_INPUT");
  return result.rows[0].raw_text;
}

async function loadExecution(
  pool: Pool,
  context: TrustedToolContext,
): Promise<MedicationExecution> {
  const result = await pool.query<{
    execution_id: string;
    research_case_id: string;
    model: string;
    prompt_version: string;
    catalog_version: number;
    research_case_revision: string;
    input_revision: string;
    lease_owner: string;
    attempt_count: number;
    job_id: string;
  }>(
    `SELECT execution.id AS execution_id,execution.research_case_id,configuration.model,
            execution.prompt_version,run.catalog_version,execution.research_case_revision,
            execution.input_revision,job.lease_owner,job.attempt_count,job.id AS job_id
     FROM insight.model_agent_executions execution
     JOIN insight.model_endpoint_configurations configuration
       ON configuration.id=execution.endpoint_configuration_id
     JOIN insight.research_cases research_case ON research_case.id=execution.research_case_id
     JOIN insight.medication_normalization_runs run ON run.execution_id=execution.id
     JOIN insight.jobs job ON job.id=execution.job_id
     WHERE execution.id=$1 AND execution.job_id=$2 AND execution.research_case_revision=$3
       AND execution.workflow_state='NORMALIZING_MEDICATIONS'
       AND execution.status IN ('PENDING','RUNNING')
       AND research_case.workflow_state=execution.workflow_state
       AND research_case.workflow_revision=execution.research_case_revision
       AND research_case.input_revision=execution.input_revision
       AND ($4::text IS NULL OR (job.status='RUNNING' AND job.lease_owner=$4
         AND job.attempt_count=$5 AND job.lease_expires_at>clock_timestamp()))`,
    [
      context.executionId,
      context.jobId,
      context.researchCaseRevision,
      context.leaseOwner ?? null,
      context.attempt ?? null,
    ],
  );
  if (!result.rows[0]) throw new McpToolError("STALE_RESEARCH_CASE_REVISION");
  return {
    ...result.rows[0],
    executionId: result.rows[0].execution_id,
    researchCaseId: result.rows[0].research_case_id,
    schemaVersion: "medication-tools-1.0.0",
    catalogVersion: result.rows[0].catalog_version,
    researchCaseRevision: Number(result.rows[0].research_case_revision),
    inputRevision: Number(result.rows[0].input_revision),
    leaseOwner: context.leaseOwner,
    attempt: context.attempt,
    jobId: context.jobId,
    promptVersion: result.rows[0].prompt_version,
  };
}

async function insertEntries(
  client: PoolClient,
  versionId: string,
  entries: readonly MedicationCatalogEntryInput[],
) {
  for (const [position, entry] of entries.entries()) {
    await client.query(
      `INSERT INTO insight.medication_catalog_entries
         (catalog_version_id,canonical_id,preferred_name,synonyms,normalized_terms,position)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        versionId,
        entry.canonicalId,
        entry.preferredName,
        entry.synonyms,
        [entry.preferredName, ...entry.synonyms].map(normalizeMedicationSearch),
        position,
      ],
    );
  }
}

async function loadVersions(pool: Pool): Promise<MedicationCatalogVersion[]> {
  const versions = await pool.query<VersionRow>(
    `SELECT version.id,version.version,version.created_by_user_id,version.created_at,
            state.active_version_id=version.id AS active
     FROM insight.medication_catalog_versions version CROSS JOIN insight.medication_catalog_state state
     ORDER BY version.version DESC`,
  );
  if (!versions.rows.length) return [];
  const entries = await pool.query<EntryRow>(
    `SELECT catalog_version_id,canonical_id,preferred_name,synonyms,normalized_terms
     FROM insight.medication_catalog_entries WHERE catalog_version_id=ANY($1::uuid[])
     ORDER BY catalog_version_id,position`,
    [versions.rows.map(({ id }) => id)],
  );
  return versions.rows.map((version) =>
    materializeVersion(
      version,
      entries.rows
        .filter(({ catalog_version_id }) => catalog_version_id === version.id)
        .map((entry) => ({
          canonicalId: entry.canonical_id,
          preferredName: entry.preferred_name,
          synonyms: entry.synonyms,
        })),
    ),
  );
}

function materializeVersion(
  row: VersionRow,
  entries: readonly MedicationCatalogEntryInput[],
): MedicationCatalogVersion {
  return {
    id: row.id,
    version: Number(row.version),
    entries: [...entries],
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    active: row.active,
  };
}

function mappingOutput(row: {
  normalization_state: "NORMALIZED" | "UNKNOWN";
  canonical_id: string | null;
  preferred_name: string | null;
}) {
  return row.normalization_state === "UNKNOWN"
    ? { normalizationState: "UNKNOWN" as const }
    : {
        normalizationState: "NORMALIZED" as const,
        canonicalId: row.canonical_id!,
        preferredName: row.preferred_name!,
      };
}

function requireAdministrator(actor: MedicationActor) {
  if (actor.role !== "ADMINISTRATOR") throw new MedicationAuthorizationError();
}

function required(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new MedicationCatalogInputError(`${label} cannot be blank.`);
  return trimmed;
}

const catalogRef = (version: number) => `medication-catalog-${version}`;
function parseCatalogRef(value: string) {
  const match = /^medication-catalog-([1-9][0-9]*)$/.exec(value);
  if (!match) throw new McpToolError("MEDICATION_CANDIDATE_INVALID");
  return Number(match[1]);
}

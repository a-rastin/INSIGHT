import { COMORBIDITY_RULE_RESULT_KINDS } from "@insight/contracts";
import type {
  ComorbidityKnowledgeInput,
  ComorbidityKnowledgeVersion,
  ComorbidityRuleEvaluation,
  ComorbidityRuleInput,
  ComorbidityRuleResultDefinition,
  ComorbiditySelectionInput,
  ComorbidityTermInput,
  Role,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export interface ComorbidityKnowledgeActor {
  readonly id: string;
  readonly role: Role;
}

interface VersionRow extends QueryResultRow {
  id: string;
  version: number;
  source_reference: string;
  reviewer_id: string;
  reviewed_at: Date;
  reviewer_record_reference: string;
  created_by_user_id: string;
  created_at: Date;
  active: boolean;
}

interface TermRow extends QueryResultRow {
  knowledge_version_id: string;
  term_id: string;
  label: string;
}

interface RuleRow extends QueryResultRow {
  knowledge_version_id: string;
  rule_id: string;
  all_of_term_ids: string[];
  results: ComorbidityRuleResultDefinition[];
}

export class ComorbidityKnowledgeAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to access the comorbidity knowledge operation.");
    this.name = "ComorbidityKnowledgeAuthorizationError";
  }
}

export class ComorbidityKnowledgeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComorbidityKnowledgeInputError";
  }
}

export function validateComorbidityKnowledgeInput(
  input: ComorbidityKnowledgeInput,
): ComorbidityKnowledgeInput {
  if (input.terms.length === 0) {
    throw new ComorbidityKnowledgeInputError("Catalog requires at least one term.");
  }
  const terms = input.terms
    .map((term) => ({
      termId: governedId(term.termId, "Term ID"),
      label: requiredText(term.label, "Term label"),
    }))
    .sort((left, right) => compareText(left.termId, right.termId));
  rejectDuplicates(
    terms.map(({ termId }) => termId),
    "Catalog term IDs must be unique.",
  );
  const termIds = new Set(terms.map(({ termId }) => termId));
  const rules = input.rules
    .map((rule) => normalizeRule(rule, termIds))
    .sort((left, right) => compareText(left.ruleId, right.ruleId));
  rejectDuplicates(
    rules.map(({ ruleId }) => ruleId),
    "Rule IDs must be unique.",
  );
  rejectDuplicates(
    rules.map(({ allOfTermIds }) => allOfTermIds.join("\0")),
    "Rules with identical match conditions are ambiguous.",
  );
  rejectDuplicates(
    rules.flatMap(({ results }) => results.map(({ kind, targetId }) => `${kind}\0${targetId}`)),
    "Rules producing the same result target are conflicting or ambiguous.",
  );
  return {
    sourceReference: requiredText(input.sourceReference, "Source reference"),
    reviewerRecord: {
      reviewerId: requiredText(input.reviewerRecord.reviewerId, "Reviewer ID"),
      reviewedAt: input.reviewerRecord.reviewedAt,
      recordReference: requiredText(input.reviewerRecord.recordReference, "Reviewer record"),
    },
    terms,
    rules,
  };
}

export function evaluateComorbidityRules(
  knowledge: ComorbidityKnowledgeVersion,
  selections: readonly Pick<ComorbiditySelectionInput, "termId">[],
): ComorbidityRuleEvaluation {
  const selected = new Set(selections.map(({ termId }) => termId));
  const results = knowledge.rules
    .filter(({ allOfTermIds }) => allOfTermIds.every((termId) => selected.has(termId)))
    .flatMap((rule) =>
      rule.results.map((result) => ({
        knowledgeVersionId: knowledge.id,
        knowledgeVersion: knowledge.version,
        ruleId: rule.ruleId,
        ...result,
        matchedTermIds: [...rule.allOfTermIds].sort(),
      })),
    )
    .sort((left, right) =>
      compareText(
        [left.kind, left.targetId, left.ruleId].join("\0"),
        [right.kind, right.targetId, right.ruleId].join("\0"),
      ),
    );
  return { knowledgeVersionId: knowledge.id, knowledgeVersion: knowledge.version, results };
}

export async function saveComorbidityKnowledge(
  pool: Pool,
  actor: ComorbidityKnowledgeActor,
  input: ComorbidityKnowledgeInput,
  now = new Date(),
): Promise<ComorbidityKnowledgeVersion> {
  requireRole(actor, "ADMINISTRATOR");
  const knowledge = validateComorbidityKnowledgeInput(input);
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT active_version_id FROM insight.comorbidity_knowledge_state WHERE singleton = true FOR UPDATE",
    );
    const next = await client.query<{ version: number }>(
      "SELECT coalesce(max(version), 0)::integer + 1 AS version FROM insight.comorbidity_knowledge_versions",
    );
    const inserted = await client.query<VersionRow>(
      `INSERT INTO insight.comorbidity_knowledge_versions (
         version, source_reference, reviewer_id, reviewed_at, reviewer_record_reference,
         created_by_user_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *, false AS active`,
      [
        next.rows[0].version,
        knowledge.sourceReference,
        knowledge.reviewerRecord.reviewerId,
        knowledge.reviewerRecord.reviewedAt,
        knowledge.reviewerRecord.recordReference,
        actor.id,
        now,
      ],
    );
    const version = inserted.rows[0];
    await client.query("SELECT set_config('insight.comorbidity_knowledge_write', 'allowed', true)");
    await insertTerms(client, version.id, knowledge.terms);
    await insertRules(client, version.id, knowledge.rules);
    await client.query(
      `UPDATE insight.comorbidity_knowledge_state
       SET active_version_id = $1, activated_by_user_id = $2, activated_at = $3
       WHERE singleton = true`,
      [version.id, actor.id, now],
    );
    return { ...materializeVersion(version, knowledge.terms, knowledge.rules), active: true };
  });
}

export async function getComorbidityKnowledgeHistory(
  pool: Pool,
  actor: ComorbidityKnowledgeActor,
): Promise<readonly ComorbidityKnowledgeVersion[]> {
  requireRole(actor, "ADMINISTRATOR");
  return loadVersions(pool);
}

export async function getActiveComorbidityKnowledge(
  pool: Pool,
  actor: ComorbidityKnowledgeActor,
): Promise<ComorbidityKnowledgeVersion | null> {
  requireRole(actor, "PSYCHIATRIST");
  return (await loadVersions(pool, { activeOnly: true }))[0] ?? null;
}

export async function loadComorbidityKnowledgeVersion(
  database: Pool | PoolClient,
  id: string,
): Promise<ComorbidityKnowledgeVersion | null> {
  return (await loadVersions(database, { id }))[0] ?? null;
}

function normalizeRule(rule: ComorbidityRuleInput, termIds: ReadonlySet<string>) {
  if (rule.allOfTermIds.length === 0 || rule.results.length === 0) {
    throw new ComorbidityKnowledgeInputError(
      "Each rule requires match terms and at least one result.",
    );
  }
  const allOfTermIds = rule.allOfTermIds.map((termId) => governedId(termId, "Rule term ID")).sort();
  rejectDuplicates(allOfTermIds, "Rule match term IDs must be unique.");
  if (allOfTermIds.some((termId) => !termIds.has(termId))) {
    throw new ComorbidityKnowledgeInputError("Every rule term must exist in its catalog version.");
  }
  const results = rule.results
    .map((result) => {
      if (!COMORBIDITY_RULE_RESULT_KINDS.includes(result.kind)) {
        throw new ComorbidityKnowledgeInputError("Rule result kind is invalid.");
      }
      return {
        kind: result.kind,
        targetId: governedId(result.targetId, "Result target ID"),
        value: requiredText(result.value, "Result value"),
        explanation: requiredText(result.explanation, "Result explanation"),
      };
    })
    .sort((left, right) =>
      compareText([left.kind, left.targetId].join("\0"), [right.kind, right.targetId].join("\0")),
    );
  rejectDuplicates(
    results.map(({ kind, targetId }) => `${kind}\0${targetId}`),
    "A rule cannot produce duplicate result targets.",
  );
  return { ruleId: governedId(rule.ruleId, "Rule ID"), allOfTermIds, results };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectDuplicates(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new ComorbidityKnowledgeInputError(message);
}

function requireRole(actor: ComorbidityKnowledgeActor, role: Role): void {
  if (actor.role !== role) throw new ComorbidityKnowledgeAuthorizationError();
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ComorbidityKnowledgeInputError(`${label} cannot be blank.`);
  return trimmed;
}

function governedId(value: string, label: string): string {
  const id = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new ComorbidityKnowledgeInputError(`${label} is not a valid governed ID.`);
  }
  return id;
}

async function insertTerms(
  client: PoolClient,
  versionId: string,
  terms: readonly ComorbidityTermInput[],
): Promise<void> {
  for (const [position, term] of terms.entries()) {
    await client.query(
      `INSERT INTO insight.comorbidity_knowledge_terms
         (knowledge_version_id, term_id, label, position) VALUES ($1, $2, $3, $4)`,
      [versionId, term.termId, term.label, position],
    );
  }
}

async function insertRules(
  client: PoolClient,
  versionId: string,
  rules: readonly ComorbidityRuleInput[],
): Promise<void> {
  for (const rule of rules) {
    await client.query(
      `INSERT INTO insight.comorbidity_knowledge_rules
         (knowledge_version_id, rule_id, all_of_term_ids, results) VALUES ($1, $2, $3, $4)`,
      [versionId, rule.ruleId, rule.allOfTermIds, JSON.stringify(rule.results)],
    );
  }
}

async function loadVersions(
  database: Pool | PoolClient,
  options: { activeOnly?: boolean; id?: string } = {},
): Promise<ComorbidityKnowledgeVersion[]> {
  const conditions = [
    ...(options.activeOnly ? ["state.active_version_id = version.id"] : []),
    ...(options.id ? ["version.id = $1"] : []),
  ];
  const versions = await database.query<VersionRow>(
    `SELECT version.*, state.active_version_id = version.id AS active
     FROM insight.comorbidity_knowledge_versions version
     CROSS JOIN insight.comorbidity_knowledge_state state
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY version.version DESC`,
    options.id ? [options.id] : [],
  );
  if (versions.rows.length === 0) return [];
  const ids = versions.rows.map(({ id }) => id);
  const [terms, rules] = await Promise.all([
    database.query<TermRow>(
      `SELECT knowledge_version_id, term_id, label FROM insight.comorbidity_knowledge_terms
       WHERE knowledge_version_id = ANY($1::uuid[]) ORDER BY knowledge_version_id, position`,
      [ids],
    ),
    database.query<RuleRow>(
      `SELECT knowledge_version_id, rule_id, all_of_term_ids, results
       FROM insight.comorbidity_knowledge_rules
       WHERE knowledge_version_id = ANY($1::uuid[]) ORDER BY knowledge_version_id, rule_id`,
      [ids],
    ),
  ]);
  return versions.rows.map((version) =>
    materializeVersion(
      version,
      terms.rows
        .filter((term) => term.knowledge_version_id === version.id)
        .map((term) => ({ termId: term.term_id, label: term.label })),
      rules.rows
        .filter((rule) => rule.knowledge_version_id === version.id)
        .map((rule) => ({
          ruleId: rule.rule_id,
          allOfTermIds: rule.all_of_term_ids,
          results: rule.results,
        })),
    ),
  );
}

function materializeVersion(
  row: VersionRow,
  terms: readonly ComorbidityTermInput[],
  rules: readonly ComorbidityRuleInput[],
): ComorbidityKnowledgeVersion {
  return {
    id: row.id,
    version: Number(row.version),
    sourceReference: row.source_reference,
    reviewerRecord: {
      reviewerId: row.reviewer_id,
      reviewedAt: row.reviewed_at.toISOString(),
      recordReference: row.reviewer_record_reference,
    },
    terms: [...terms],
    rules: [...rules],
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    active: row.active,
  };
}

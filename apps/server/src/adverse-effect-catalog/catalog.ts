import type {
  AdverseEffectCatalogInput,
  AdverseEffectCatalogVersion,
  AdverseEffectTermInput,
  Role,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export interface CatalogActor {
  readonly id: string;
  readonly role: Role;
}

interface VersionRow extends QueryResultRow {
  id: string;
  version: number;
  created_by_user_id: string;
  created_at: Date;
  active: boolean;
}

interface TermRow extends QueryResultRow {
  catalog_version_id: string;
  term_id: string;
  label: string;
}

export class AdverseEffectCatalogAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to access the adverse-effect catalog operation.");
    this.name = "AdverseEffectCatalogAuthorizationError";
  }
}

export class AdverseEffectCatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdverseEffectCatalogInputError";
  }
}

export function validateAdverseEffectCatalogInput(
  input: AdverseEffectCatalogInput,
): AdverseEffectCatalogInput {
  if (input.terms.length === 0) {
    throw new AdverseEffectCatalogInputError("Catalog requires at least one term.");
  }
  const terms = input.terms.map((term) => ({
    termId: requiredText(term.termId, "Term ID"),
    label: requiredText(term.label, "Term label"),
  }));
  if (new Set(terms.map(({ termId }) => termId)).size !== terms.length) {
    throw new AdverseEffectCatalogInputError("Catalog term IDs must be unique.");
  }
  if (terms.filter(({ termId }) => termId === "OTHER").length !== 1) {
    throw new AdverseEffectCatalogInputError("Catalog requires exactly one OTHER term.");
  }
  return { terms };
}

export async function saveAdverseEffectCatalog(
  pool: Pool,
  actor: CatalogActor,
  input: AdverseEffectCatalogInput,
  now = new Date(),
): Promise<AdverseEffectCatalogVersion> {
  requireRole(actor, "ADMINISTRATOR");
  const catalog = validateAdverseEffectCatalogInput(input);
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT active_version_id FROM insight.adverse_effect_catalog_state WHERE singleton = true FOR UPDATE",
    );
    const next = await client.query<{ version: number }>(
      "SELECT coalesce(max(version), 0)::integer + 1 AS version FROM insight.adverse_effect_catalog_versions",
    );
    const inserted = await client.query<VersionRow>(
      `INSERT INTO insight.adverse_effect_catalog_versions
         (version, created_by_user_id, created_at)
       VALUES ($1, $2, $3)
       RETURNING id, version, created_by_user_id, created_at, false AS active`,
      [next.rows[0].version, actor.id, now],
    );
    const version = inserted.rows[0];
    await client.query(
      "SELECT set_config('insight.adverse_effect_catalog_write', 'allowed', true)",
    );
    await insertTerms(client, version.id, catalog.terms);
    await client.query(
      `UPDATE insight.adverse_effect_catalog_state
       SET active_version_id = $1, activated_by_user_id = $2, activated_at = $3
       WHERE singleton = true`,
      [version.id, actor.id, now],
    );
    return { ...materializeVersion(version, catalog.terms), active: true };
  });
}

export async function getAdverseEffectCatalogHistory(
  pool: Pool,
  actor: CatalogActor,
): Promise<readonly AdverseEffectCatalogVersion[]> {
  requireRole(actor, "ADMINISTRATOR");
  return loadVersions(pool);
}

export async function getActiveAdverseEffectCatalog(
  pool: Pool,
  actor: CatalogActor,
): Promise<AdverseEffectCatalogVersion | null> {
  requireRole(actor, "PSYCHIATRIST");
  return (await loadVersions(pool, true))[0] ?? null;
}

function requireRole(actor: CatalogActor, role: Role): void {
  if (actor.role !== role) throw new AdverseEffectCatalogAuthorizationError();
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AdverseEffectCatalogInputError(`${label} cannot be blank.`);
  return trimmed;
}

async function insertTerms(
  client: PoolClient,
  versionId: string,
  terms: readonly AdverseEffectTermInput[],
): Promise<void> {
  for (const [position, term] of terms.entries()) {
    await client.query(
      `INSERT INTO insight.adverse_effect_catalog_terms
         (catalog_version_id, term_id, label, position)
       VALUES ($1, $2, $3, $4)`,
      [versionId, term.termId, term.label, position],
    );
  }
}

async function loadVersions(
  pool: Pool,
  activeOnly = false,
): Promise<AdverseEffectCatalogVersion[]> {
  const versions = await pool.query<VersionRow>(
    `SELECT version.id, version.version, version.created_by_user_id, version.created_at,
            state.active_version_id = version.id AS active
     FROM insight.adverse_effect_catalog_versions version
     CROSS JOIN insight.adverse_effect_catalog_state state
     ${activeOnly ? "WHERE state.active_version_id = version.id" : ""}
     ORDER BY version.version DESC`,
  );
  if (versions.rows.length === 0) return [];
  const terms = await pool.query<TermRow>(
    `SELECT catalog_version_id, term_id, label
     FROM insight.adverse_effect_catalog_terms
     WHERE catalog_version_id = ANY($1::uuid[])
     ORDER BY catalog_version_id, position`,
    [versions.rows.map(({ id }) => id)],
  );
  return versions.rows.map((version) =>
    materializeVersion(
      version,
      terms.rows
        .filter((term) => term.catalog_version_id === version.id)
        .map((term) => ({ termId: term.term_id, label: term.label })),
    ),
  );
}

function materializeVersion(
  row: VersionRow,
  terms: readonly AdverseEffectTermInput[],
): AdverseEffectCatalogVersion {
  return {
    id: row.id,
    version: Number(row.version),
    terms: [...terms],
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    active: row.active,
  };
}

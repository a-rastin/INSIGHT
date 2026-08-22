import type { Pool, PoolClient } from "pg";

import { POSTGRES_MAJOR } from "./config.js";
import {
  migrations as productionMigrations,
  prepareMigrations,
  type Migration,
  type PreparedMigration,
} from "./migrations.js";

const MIGRATION_LOCK_ID = "3911807625093621319";

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export type MigrationState = "empty" | "behind" | "current" | "incompatible";

export interface MigrationStatus {
  state: MigrationState;
  databaseHead: number;
  codeHead: number;
  appliedCount: number;
  detail?: string;
}

export interface MigrationResult extends MigrationStatus {
  applied: readonly number[];
}

export class DatabaseCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseCompatibilityError";
  }
}

export class MigrationError extends Error {
  readonly version: number;
  readonly sqlState?: string;

  constructor(migration: PreparedMigration, sqlState?: string) {
    const state = sqlState ? ` SQLSTATE ${sqlState}.` : "";
    super(
      `Migration ${migration.version} (${migration.name}) failed.${state} ` +
        "Its transaction was rolled back and the migration ledger was not advanced. " +
        "Correct the migration or restore a compatible backup, then rerun npm run db:migrate.",
    );
    this.name = "MigrationError";
    this.version = migration.version;
    this.sqlState = sqlState;
  }
}

async function assertPostgresMajor(client: PoolClient): Promise<void> {
  const result = await client.query<{ server_version_num: string }>("SHOW server_version_num");
  const versionNumber = Number(result.rows[0]?.server_version_num);
  const actualMajor = Math.floor(versionNumber / 10_000);
  if (!Number.isInteger(actualMajor) || actualMajor !== POSTGRES_MAJOR) {
    throw new DatabaseCompatibilityError(
      `PostgreSQL major ${POSTGRES_MAJOR} is required; connected server reports major ${actualMajor || "unknown"}. ` +
        "Use maintenance mode, a full backup that passed checksum and test-restore checks, and the documented major-upgrade procedure.",
    );
  }
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.insight_schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum character(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function readLedger(client: PoolClient): Promise<readonly MigrationRow[]> {
  try {
    const result = await client.query<MigrationRow>(
      "SELECT version, name, checksum, applied_at FROM public.insight_schema_migrations ORDER BY version",
    );
    return result.rows;
  } catch (error) {
    if (sqlState(error) === "42P01") return [];
    throw error;
  }
}

function statusFor(
  rows: readonly MigrationRow[],
  known: readonly PreparedMigration[],
): MigrationStatus {
  const databaseHead = rows.at(-1)?.version ?? 0;
  const codeHead = known.at(-1)?.version ?? 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = known[index];
    if (
      !row ||
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    ) {
      return {
        state: "incompatible",
        databaseHead,
        codeHead,
        appliedCount: rows.length,
        detail: `Migration ledger diverges at version ${row?.version ?? index + 1}.`,
      };
    }
  }

  return {
    state: rows.length === 0 ? "empty" : rows.length < known.length ? "behind" : "current",
    databaseHead,
    codeHead,
    appliedCount: rows.length,
  };
}

export async function getMigrationStatus(
  pool: Pool,
  source: readonly Migration[] = productionMigrations,
): Promise<MigrationStatus> {
  const known = prepareMigrations(source);
  const client = await pool.connect();
  try {
    await assertPostgresMajor(client);
    return statusFor(await readLedger(client), known);
  } finally {
    client.release();
  }
}

export async function assertSchemaAtHead(
  pool: Pool,
  source: readonly Migration[] = productionMigrations,
): Promise<MigrationStatus> {
  const status = await getMigrationStatus(pool, source);
  if (status.state === "current") return status;

  if (status.state === "incompatible") {
    throw new DatabaseCompatibilityError(
      `Database schema is incompatible (database head ${status.databaseHead}, code head ${status.codeHead}). ` +
        `${status.detail ?? "Migration ledger does not match this build."} ` +
        "Restore a compatible backup or deploy the matching application; never edit the ledger manually.",
    );
  }
  throw new DatabaseCompatibilityError(
    `Database schema is ${status.state} (database head ${status.databaseHead}, required head ${status.codeHead}). ` +
      "Run npm run db:migrate before starting the server.",
  );
}

export async function migrateToHead(
  pool: Pool,
  source: readonly Migration[] = productionMigrations,
): Promise<MigrationResult> {
  const known = prepareMigrations(source);
  const client = await pool.connect();
  let locked = false;
  try {
    await assertPostgresMajor(client);
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    locked = true;
    await ensureLedger(client);

    const before = statusFor(await readLedger(client), known);
    if (before.state === "incompatible") {
      throw new DatabaseCompatibilityError(
        `${before.detail ?? "Migration ledger is incompatible."} Restore a compatible backup or deploy the matching application.`,
      );
    }

    const applied: number[] = [];
    for (const migration of known.slice(before.appliedCount)) {
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query(migration.sql);
        await migration.run?.(client);
        await client.query(
          "INSERT INTO public.insight_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationError(migration, sqlState(error));
      }
    }

    return { ...statusFor(await readLedger(client), known), applied };
  } finally {
    let destroyClient = false;
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

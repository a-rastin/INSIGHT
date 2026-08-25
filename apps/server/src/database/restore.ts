import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Pool, QueryResultRow } from "pg";

import { POSTGRES_MAJOR, createPostgresPool } from "./config.js";
import { assertSchemaAtHead, getMigrationStatus, migrateToHead } from "./migrator.js";
import { migrations } from "./migrations.js";

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;

interface RestoreManifest {
  readonly schemaVersion: "1";
  readonly backupId: string;
  readonly applicationVersion: string;
  readonly postgresMajor: number;
  readonly migrationHead: number;
  readonly createdAt: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly dumpFilename: string;
}

interface ArtifactReference extends QueryResultRow {
  source: string;
  relative_path: string;
  byte_length: string;
  sha256: string;
}

export interface RestoreArtifactIssue {
  readonly source: string;
  readonly relativePath: string;
  readonly problem: "MISSING" | "NOT_FILE" | "UNSAFE_PATH" | "SIZE_MISMATCH" | "HASH_MISMATCH";
}

export interface RestoreResult {
  readonly restoredDatabase: string;
  readonly rollbackDatabase: string;
  readonly migrationHead: number;
  readonly appliedMigrations: readonly number[];
  readonly verifiedArtifacts: number;
}

export interface RestoreRollbackResult {
  readonly restoredDatabase: string;
  readonly displacedDatabase: string;
  readonly migrationHead: number;
}

export interface RestoreOptions {
  readonly adminDatabaseUrl: string;
  readonly targetDatabaseUrl: string;
  readonly dumpPath: string;
  readonly manifestPath: string;
  readonly artifactRoot: string;
  readonly maintenanceMarkerPath: string;
  readonly applicationVersion: string;
  readonly postRestoreCheck?: (pool: Pool) => Promise<void>;
}

export class RestoreValidationError extends Error {
  readonly artifactIssues: readonly RestoreArtifactIssue[];

  constructor(message: string, artifactIssues: readonly RestoreArtifactIssue[] = []) {
    super(message);
    this.name = "RestoreValidationError";
    this.artifactIssues = artifactIssues;
  }
}

export class RestorePostCheckError extends Error {
  readonly rollbackDatabase: string;

  constructor(rollbackDatabase: string) {
    super(
      `Restore post-check failed. Maintenance mode remains active. Rollback database: ${rollbackDatabase}.`,
    );
    this.name = "RestorePostCheckError";
    this.rollbackDatabase = rollbackDatabase;
  }
}

export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  await writeFile(options.maintenanceMarkerPath, "restore in progress\n", {
    encoding: "utf8",
    mode: 0o640,
  });

  const target = databaseIdentity(options.targetDatabaseUrl);
  const administrator = databaseIdentity(options.adminDatabaseUrl);
  if (target.host !== administrator.host || target.port !== administrator.port) {
    throw new RestoreValidationError(
      "Restore administrator and target must use the same PostgreSQL server.",
    );
  }
  if (target.database === administrator.database) {
    throw new RestoreValidationError(
      "Restore administrator must connect to a maintenance database, not the target.",
    );
  }

  const manifest = await validateBackup(options);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const stagedDatabase = derivedDatabaseName(target.database, "restore", suffix);
  const rollbackDatabase = derivedDatabaseName(target.database, "rollback", suffix);
  const adminPool = createPostgresPool({
    connectionString: options.adminDatabaseUrl,
    maxConnections: 1,
  });
  let stagedExists = false;
  let replaced = false;

  try {
    await assertPostgresServer(adminPool);
    await adminPool.query(
      `CREATE DATABASE ${quoteIdentifier(stagedDatabase)} OWNER ${quoteIdentifier(target.user)} TEMPLATE template0 ENCODING 'UTF8'`,
    );
    stagedExists = true;
    await restorePostgres(options.adminDatabaseUrl, stagedDatabase, options.dumpPath);

    const stagedPool = createPostgresPool({
      connectionString: databaseUrlFor(options.adminDatabaseUrl, stagedDatabase),
      maxConnections: 2,
      ...(administrator.user === target.user ? {} : { role: target.user }),
    });
    let verifiedArtifacts = 0;
    try {
      const status = await getMigrationStatus(stagedPool);
      if (
        status.state === "empty" ||
        status.state === "incompatible" ||
        status.databaseHead !== manifest.migrationHead ||
        status.databaseHead > status.codeHead
      ) {
        throw new RestoreValidationError(
          "Backup schema is incompatible with this application build.",
        );
      }
      verifiedArtifacts = await verifyArtifactReferences(stagedPool, options.artifactRoot);
    } finally {
      await stagedPool.end();
    }

    await terminateDatabaseConnections(adminPool, target.database);
    await adminPool.query("BEGIN");
    try {
      await adminPool.query(
        `ALTER DATABASE ${quoteIdentifier(target.database)} RENAME TO ${quoteIdentifier(rollbackDatabase)}`,
      );
      await adminPool.query(
        `ALTER DATABASE ${quoteIdentifier(stagedDatabase)} RENAME TO ${quoteIdentifier(target.database)}`,
      );
      await adminPool.query("COMMIT");
      replaced = true;
      stagedExists = false;
    } catch (error) {
      await adminPool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const restoredPool = createPostgresPool({
      connectionString: databaseUrlFor(options.adminDatabaseUrl, target.database),
      maxConnections: 2,
      ...(administrator.user === target.user ? {} : { role: target.user }),
    });
    try {
      const migration = await migrateToHead(restoredPool);
      await assertSchemaAtHead(restoredPool);
      await checkDatabaseIntegrity(restoredPool);
      await (options.postRestoreCheck?.(restoredPool) ?? Promise.resolve());
      await rm(options.maintenanceMarkerPath);
      return {
        restoredDatabase: target.database,
        rollbackDatabase,
        migrationHead: migration.databaseHead,
        appliedMigrations: migration.applied,
        verifiedArtifacts,
      };
    } catch {
      throw new RestorePostCheckError(rollbackDatabase);
    } finally {
      await restoredPool.end();
    }
  } finally {
    if (stagedExists && !replaced) {
      await terminateDatabaseConnections(adminPool, stagedDatabase).catch(() => undefined);
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdentifier(stagedDatabase)}`)
        .catch(() => undefined);
    }
    await adminPool.end();
  }
}

export async function rollbackDatabaseRestore(
  options: Pick<RestoreOptions, "adminDatabaseUrl" | "targetDatabaseUrl" | "maintenanceMarkerPath">,
  rollbackDatabase: string,
): Promise<RestoreRollbackResult> {
  await writeFile(options.maintenanceMarkerPath, "restore rollback in progress\n", {
    encoding: "utf8",
    mode: 0o640,
  });
  const target = databaseIdentity(options.targetDatabaseUrl);
  const administrator = databaseIdentity(options.adminDatabaseUrl);
  if (target.host !== administrator.host || target.port !== administrator.port) {
    throw new RestoreValidationError(
      "Restore administrator and target must use the same PostgreSQL server.",
    );
  }
  const rollbackPrefix = derivedDatabaseName(target.database, "rollback", "0".repeat(12)).slice(
    0,
    -12,
  );
  const rollbackPattern = new RegExp(`^${escapeRegExp(rollbackPrefix)}[0-9a-f]{12}$`);
  if (!rollbackPattern.test(rollbackDatabase)) {
    throw new RestoreValidationError("Rollback database name is invalid for this target.");
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const displacedDatabase = derivedDatabaseName(target.database, "failed", suffix);
  const adminPool = createPostgresPool({
    connectionString: options.adminDatabaseUrl,
    maxConnections: 1,
  });
  try {
    await assertPostgresServer(adminPool);
    const exists = await adminPool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [rollbackDatabase],
    );
    if (!exists.rows[0]?.exists)
      throw new RestoreValidationError("Rollback database does not exist.");
    await terminateDatabaseConnections(adminPool, target.database);
    await terminateDatabaseConnections(adminPool, rollbackDatabase);
    await adminPool.query("BEGIN");
    try {
      await adminPool.query(
        `ALTER DATABASE ${quoteIdentifier(target.database)} RENAME TO ${quoteIdentifier(displacedDatabase)}`,
      );
      await adminPool.query(
        `ALTER DATABASE ${quoteIdentifier(rollbackDatabase)} RENAME TO ${quoteIdentifier(target.database)}`,
      );
      await adminPool.query("COMMIT");
    } catch (error) {
      await adminPool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const pool = createPostgresPool({
      connectionString: databaseUrlFor(options.adminDatabaseUrl, target.database),
      maxConnections: 2,
      ...(administrator.user === target.user ? {} : { role: target.user }),
    });
    try {
      const status = await assertSchemaAtHead(pool);
      await checkDatabaseIntegrity(pool);
      await rm(options.maintenanceMarkerPath);
      return {
        restoredDatabase: target.database,
        displacedDatabase,
        migrationHead: status.databaseHead,
      };
    } catch {
      throw new RestorePostCheckError(displacedDatabase);
    } finally {
      await pool.end();
    }
  } finally {
    await adminPool.end();
  }
}

async function validateBackup(options: RestoreOptions): Promise<RestoreManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(options.manifestPath, "utf8"));
  } catch {
    throw new RestoreValidationError("Backup manifest is not readable JSON.");
  }
  if (!isRecord(raw)) throw new RestoreValidationError("Backup manifest must be an object.");
  const required = [
    "schemaVersion",
    "backupId",
    "applicationVersion",
    "postgresMajor",
    "migrationHead",
    "createdAt",
    "byteLength",
    "sha256",
    "dumpFilename",
  ];
  if (Object.keys(raw).sort().join("\0") !== [...required].sort().join("\0")) {
    throw new RestoreValidationError("Backup manifest fields are invalid.");
  }
  if (
    raw.schemaVersion !== "1" ||
    typeof raw.backupId !== "string" ||
    !UUID.test(raw.backupId) ||
    typeof raw.applicationVersion !== "string" ||
    !applicationVersionsCompatible(raw.applicationVersion, options.applicationVersion) ||
    raw.postgresMajor !== POSTGRES_MAJOR ||
    !Number.isInteger(raw.migrationHead) ||
    (raw.migrationHead as number) < 1 ||
    (raw.migrationHead as number) > migrations.length ||
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Number.isSafeInteger(raw.byteLength) ||
    (raw.byteLength as number) < 1 ||
    typeof raw.sha256 !== "string" ||
    !SHA256.test(raw.sha256) ||
    typeof raw.dumpFilename !== "string" ||
    raw.dumpFilename !== basename(options.dumpPath) ||
    raw.dumpFilename !== `${raw.backupId}.dump`
  ) {
    throw new RestoreValidationError("Backup manifest is incompatible or invalid.");
  }

  const dump = await stat(options.dumpPath).catch(() => null);
  if (
    !dump?.isFile() ||
    dump.size !== raw.byteLength ||
    (await hashFile(options.dumpPath)) !== raw.sha256
  ) {
    throw new RestoreValidationError("Backup dump size or SHA-256 does not match its manifest.");
  }
  try {
    const listing = await executeFile("pg_restore", ["--list", options.dumpPath]);
    const dumpedMajor = Number(
      /^;\s+Dumped from database version: (\d+)(?:\.|$)/m.exec(listing.stdout)?.[1],
    );
    if (dumpedMajor !== POSTGRES_MAJOR) {
      throw new RestoreValidationError(
        `Backup was created by unsupported PostgreSQL major ${dumpedMajor || "unknown"}.`,
      );
    }
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError("Backup is not a readable PostgreSQL custom-format dump.");
  }
  return raw as unknown as RestoreManifest;
}

async function verifyArtifactReferences(pool: Pool, artifactRoot: string): Promise<number> {
  const references = await loadArtifactReferences(pool);
  const root = await realpath(artifactRoot).catch(() => null);
  if (!root && references.length > 0) {
    throw new RestoreValidationError(
      "Restored metadata references unavailable artifacts; no files were recovered.",
      references.slice(0, 1000).map((reference) => ({
        source: reference.source,
        relativePath: reference.relative_path,
        problem: "MISSING",
      })),
    );
  }

  const issues: RestoreArtifactIssue[] = [];
  for (const reference of references) {
    const path = safeArtifactPath(root!, reference.relative_path);
    if (!path) {
      issues.push(issue(reference, "UNSAFE_PATH"));
      continue;
    }
    const file = await stat(path).catch(() => null);
    if (!file) issues.push(issue(reference, "MISSING"));
    else if (!file.isFile()) issues.push(issue(reference, "NOT_FILE"));
    else if ((await realpath(path).catch(() => null)) !== path)
      issues.push(issue(reference, "UNSAFE_PATH"));
    else if (file.size !== Number(reference.byte_length))
      issues.push(issue(reference, "SIZE_MISMATCH"));
    else if ((await hashFile(path)) !== reference.sha256)
      issues.push(issue(reference, "HASH_MISMATCH"));
    if (issues.length >= 1000) break;
  }
  if (issues.length > 0) {
    throw new RestoreValidationError(
      "Restored metadata references missing, mismatched, or unsafe artifacts; no files were recovered.",
      issues,
    );
  }
  return references.length;
}

async function loadArtifactReferences(pool: Pool): Promise<readonly ArtifactReference[]> {
  const sources = [
    ["artifacts", "relative_path", "byte_length", "sha256"],
    ["ddi_source_versions", "artifact_path", "artifact_byte_length", "content_hash"],
    ["bn_model_artifacts", "artifact_path", "byte_length", "content_sha256"],
    ["final_plan_export_artifacts", "artifact_path", "byte_length", "content_hash"],
  ] as const;
  const references: ArtifactReference[] = [];
  for (const [table, path, length, hash] of sources) {
    const exists = await pool.query<{ table: string | null }>("SELECT to_regclass($1) AS table", [
      `insight.${table}`,
    ]);
    if (!exists.rows[0]?.table) continue;
    const result = await pool.query<ArtifactReference>(
      `SELECT $1::text AS source, ${path} AS relative_path, ${length}::text AS byte_length, ${hash} AS sha256
         FROM insight.${table}
        ORDER BY ${path}`,
      [table],
    );
    references.push(...result.rows);
  }
  return references;
}

async function checkDatabaseIntegrity(pool: Pool): Promise<void> {
  const constraints = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname IN ('public', 'insight') AND NOT c.convalidated`,
  );
  const indexes = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname IN ('public', 'insight') AND NOT i.indisvalid`,
  );
  if (constraints.rows[0]?.count !== 0 || indexes.rows[0]?.count !== 0) {
    throw new Error("Database integrity check failed.");
  }
}

async function assertPostgresServer(pool: Pool): Promise<void> {
  const result = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
  if (Math.floor(Number(result.rows[0]?.server_version_num) / 10_000) !== POSTGRES_MAJOR) {
    throw new RestoreValidationError(`PostgreSQL major ${POSTGRES_MAJOR} is required.`);
  }
}

async function restorePostgres(
  adminUrl: string,
  database: string,
  dumpPath: string,
): Promise<void> {
  const connection = new URL(adminUrl);
  await executeFile(
    "pg_restore",
    ["--exit-on-error", "--no-password", "--dbname", database, dumpPath],
    { env: postgresEnvironment(connection) },
  ).catch(() => {
    throw new RestoreValidationError("Backup could not be restored into a disposable database.");
  });
}

async function terminateDatabaseConnections(pool: Pool, database: string): Promise<void> {
  await pool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
}

function postgresEnvironment(connection: URL): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: connection.searchParams.get("host") ?? connection.hostname,
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: connection.searchParams.get("sslmode") ?? "prefer",
  };
}

function databaseIdentity(connectionString: string) {
  const value = new URL(connectionString);
  const database = decodeURIComponent(value.pathname.slice(1));
  const user = decodeURIComponent(value.username);
  if (!database || !user || database.includes("\0") || user.includes("\0")) {
    throw new RestoreValidationError("Database URLs must include database and user names.");
  }
  return {
    database,
    user,
    host: value.searchParams.get("host") ?? value.hostname,
    port: value.port || "5432",
  };
}

function databaseUrlFor(connectionString: string, database: string): string {
  const value = new URL(connectionString);
  value.pathname = `/${encodeURIComponent(database)}`;
  return value.toString();
}

function applicationVersionsCompatible(backup: string, current: string): boolean {
  const backupMatch = SEMVER.exec(backup);
  const currentMatch = SEMVER.exec(current);
  if (!backupMatch || !currentMatch) return false;
  return (
    backupMatch[1] === currentMatch[1] &&
    (backupMatch[1] !== "0" || backupMatch[2] === currentMatch[2])
  );
}

function safeArtifactPath(root: string, relativePath: string): string | null {
  if (isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const path = resolve(root, relativePath);
  return path !== root && path.startsWith(`${root}${sep}`) ? path : null;
}

function issue(
  reference: ArtifactReference,
  problem: RestoreArtifactIssue["problem"],
): RestoreArtifactIssue {
  return { source: reference.source, relativePath: reference.relative_path, problem };
}

function derivedDatabaseName(database: string, operation: string, suffix: string): string {
  const separatorLength = 2;
  const baseLength = 63 - operation.length - suffix.length - separatorLength;
  return `${database.slice(0, baseLength)}_${operation}_${suffix}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

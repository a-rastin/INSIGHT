import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { ApiErrorSchema, CURRENT_SCHEMA_VERSION, type ApiError } from "@insight/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { POSTGRES_MAJOR } from "./database/config.js";
import { getMigrationStatus } from "./database/migrator.js";
import { withTransaction } from "./database/transaction.js";
import type { SessionContext } from "./identity/sessions.js";

const executeFile = promisify(execFile);
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export interface BackupActor {
  readonly id: string;
  readonly role: "ADMINISTRATOR" | "PSYCHIATRIST";
}

export interface BackupManifest {
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

export interface BackupStatus {
  readonly id: string;
  readonly status: "RUNNING" | "COMPLETED" | "FAILED";
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly manifest: BackupManifest | null;
  readonly failureCode: "BACKUP_FAILED" | null;
}

interface BackupRow extends QueryResultRow {
  id: string;
  status: BackupStatus["status"];
  application_version: string;
  postgres_major: number;
  migration_head: number;
  created_at: Date;
  completed_at: Date | null;
  dump_filename: string;
  byte_length: string | null;
  sha256: string | null;
  failure_code: "BACKUP_FAILED" | null;
}

export interface BackupOptions {
  readonly pool: Pool;
  readonly root: string;
  readonly databaseUrl: string;
  readonly applicationVersion: string;
  readonly dumpDatabase?: (databaseUrl: string, outputPath: string) => Promise<void>;
}

export class BackupAuthorizationError extends Error {}
export class BackupNotFoundError extends Error {}
export class BackupNotReadyError extends Error {}
export class BackupIntegrityError extends Error {}

export async function startDatabaseBackup(
  options: BackupOptions,
  actor: BackupActor,
  requestId: string,
  now = new Date(),
): Promise<BackupStatus> {
  await assertAdministrator(options.pool, actor);
  const migration = await getMigrationStatus(options.pool);
  if (migration.state !== "current") throw new BackupNotReadyError();

  const id = randomUUID();
  const dumpFilename = `${id}.dump`;
  await mkdir(options.root, { recursive: true, mode: 0o750 });
  await withTransaction(options.pool, async (client) => {
    await client.query(
      `INSERT INTO insight.database_backups
         (id, status, created_by_user_id, request_id, application_version,
          postgres_major, migration_head, created_at, dump_filename)
       VALUES ($1, 'RUNNING', $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        actor.id,
        requestId,
        options.applicationVersion,
        POSTGRES_MAJOR,
        migration.databaseHead,
        now,
        dumpFilename,
      ],
    );
    await audit(client, "DATABASE_BACKUP_STARTED", id, actor.id, requestId, {
      applicationVersion: options.applicationVersion,
      postgresMajor: POSTGRES_MAJOR,
      migrationHead: migration.databaseHead,
    });
  });

  const status: BackupStatus = {
    id,
    status: "RUNNING",
    createdAt: now.toISOString(),
    completedAt: null,
    manifest: null,
    failureCode: null,
  };
  void createBackup(options, status, actor.id, requestId, dumpFilename, migration.databaseHead);
  return status;
}

export async function getDatabaseBackup(
  options: BackupOptions,
  actor: BackupActor,
  backupId: string,
): Promise<BackupStatus> {
  await assertAdministrator(options.pool, actor);
  return statusFromRow(await loadBackup(options.pool, backupId));
}

export async function getDatabaseBackupFile(
  options: BackupOptions,
  actor: BackupActor,
  backupId: string,
  requestId: string,
): Promise<{ readonly path: string; readonly manifest: BackupManifest }> {
  await assertAdministrator(options.pool, actor);
  const row = await loadBackup(options.pool, backupId);
  const status = statusFromRow(row);
  if (!status.manifest) throw new BackupNotReadyError();

  const path = resolve(options.root, row.dump_filename);
  const file = await stat(path).catch(() => null);
  const sha256 = file?.isFile() ? await hashFile(path) : null;
  if (file?.size !== status.manifest.byteLength || sha256 !== status.manifest.sha256) {
    await audit(
      options.pool,
      "DATABASE_BACKUP_INTEGRITY_FAILED",
      backupId,
      actor.id,
      requestId,
      null,
    );
    throw new BackupIntegrityError();
  }
  await audit(options.pool, "DATABASE_BACKUP_DOWNLOADED", backupId, actor.id, requestId, {
    byteLength: status.manifest.byteLength,
    sha256: status.manifest.sha256,
  });
  return { path, manifest: status.manifest };
}

export function databaseBackupRoutes(
  options: BackupOptions,
  sessionFor: (request: FastifyRequest) => SessionContext | undefined,
): FastifyPluginAsync {
  const params = Type.Object(
    { backupId: Type.String({ pattern: UUID_PATTERN }) },
    { additionalProperties: false },
  );
  return async (app) => {
    app.post(
      "/admin/backups",
      {
        schema: {
          operationId: "startDatabaseBackup",
          tags: ["backup"],
          response: { 202: backupResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const actor = actorFrom(sessionFor(request));
        if (!actor) return forbidden(request, reply);
        try {
          return reply.status(202).send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            backup: await startDatabaseBackup(options, actor, request.id),
          });
        } catch (error) {
          return sendBackupError(error, request, reply);
        }
      },
    );

    app.get<{ Params: { backupId: string } }>(
      "/admin/backups/:backupId",
      {
        schema: {
          operationId: "getDatabaseBackupStatus",
          tags: ["backup"],
          params,
          response: { 200: backupResponseSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const actor = actorFrom(sessionFor(request));
        if (!actor) return forbidden(request, reply);
        try {
          return reply.send({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            backup: await getDatabaseBackup(options, actor, request.params.backupId),
          });
        } catch (error) {
          return sendBackupError(error, request, reply);
        }
      },
    );

    app.get<{ Params: { backupId: string } }>(
      "/admin/backups/:backupId/download",
      {
        schema: {
          operationId: "downloadDatabaseBackup",
          tags: ["backup"],
          params,
          response: { 200: Type.String({ format: "binary" }), default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const actor = actorFrom(sessionFor(request));
        if (!actor) return forbidden(request, reply);
        try {
          const file = await getDatabaseBackupFile(
            options,
            actor,
            request.params.backupId,
            request.id,
          );
          return reply
            .type("application/vnd.postgresql.custom-dump")
            .header("content-disposition", `attachment; filename="${file.manifest.dumpFilename}"`)
            .header("content-length", file.manifest.byteLength)
            .header("x-content-sha256", file.manifest.sha256)
            .send(createReadStream(file.path));
        } catch (error) {
          return sendBackupError(error, request, reply);
        }
      },
    );

    app.get<{ Params: { backupId: string } }>(
      "/admin/backups/:backupId/manifest",
      {
        schema: {
          operationId: "downloadDatabaseBackupManifest",
          tags: ["backup"],
          params,
          response: { 200: manifestSchema, default: ApiErrorSchema },
        },
      },
      async (request, reply) => {
        const actor = actorFrom(sessionFor(request));
        if (!actor) return forbidden(request, reply);
        try {
          const backup = await getDatabaseBackup(options, actor, request.params.backupId);
          if (!backup.manifest) throw new BackupNotReadyError();
          return reply
            .type("application/json")
            .header("content-disposition", `attachment; filename="${backup.id}.manifest.json"`)
            .send(backup.manifest);
        } catch (error) {
          return sendBackupError(error, request, reply);
        }
      },
    );
  };
}

async function createBackup(
  options: BackupOptions,
  started: BackupStatus,
  actorUserId: string,
  requestId: string,
  dumpFilename: string,
  migrationHead: number,
): Promise<void> {
  const dumpPath = resolve(options.root, dumpFilename);
  const temporaryDumpPath = `${dumpPath}.part`;
  const manifestPath = resolve(options.root, `${started.id}.manifest.json`);
  const temporaryManifestPath = `${manifestPath}.part`;
  try {
    await (options.dumpDatabase ?? dumpPostgres)(options.databaseUrl, temporaryDumpPath);
    await rename(temporaryDumpPath, dumpPath);
    const dumpStat = await stat(dumpPath);
    const manifest: BackupManifest = {
      schemaVersion: "1",
      backupId: started.id,
      applicationVersion: options.applicationVersion,
      postgresMajor: POSTGRES_MAJOR,
      migrationHead,
      createdAt: started.createdAt,
      byteLength: dumpStat.size,
      sha256: await hashFile(dumpPath),
      dumpFilename,
    };
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o640,
      flag: "wx",
    });
    await rename(temporaryManifestPath, manifestPath);
    await withTransaction(options.pool, async (client) => {
      await client.query(
        `UPDATE insight.database_backups
         SET status = 'COMPLETED', completed_at = clock_timestamp(), byte_length = $2, sha256 = $3
         WHERE id = $1 AND status = 'RUNNING'`,
        [started.id, manifest.byteLength, manifest.sha256],
      );
      await audit(client, "DATABASE_BACKUP_COMPLETED", started.id, actorUserId, requestId, {
        ...manifest,
      });
    });
  } catch {
    await Promise.all([
      rm(temporaryDumpPath, { force: true }).catch(() => undefined),
      rm(dumpPath, { force: true }).catch(() => undefined),
      rm(temporaryManifestPath, { force: true }).catch(() => undefined),
      rm(manifestPath, { force: true }).catch(() => undefined),
    ]);
    try {
      await withTransaction(options.pool, async (client) => {
        await client.query(
          `UPDATE insight.database_backups
           SET status = 'FAILED', completed_at = clock_timestamp(), failure_code = 'BACKUP_FAILED'
           WHERE id = $1 AND status = 'RUNNING'`,
          [started.id],
        );
        await audit(client, "DATABASE_BACKUP_FAILED", started.id, actorUserId, requestId, {
          failureCode: "BACKUP_FAILED",
        });
      });
    } catch {
      // Preserve original dump failure; API and logs expose no subprocess or database details.
    }
  }
}

async function dumpPostgres(databaseUrl: string, outputPath: string): Promise<void> {
  const database = new URL(databaseUrl);
  await executeFile("pg_dump", ["--format=custom", "--no-password", "--file", outputPath], {
    env: {
      ...process.env,
      PGHOST: database.searchParams.get("host") ?? database.hostname,
      PGPORT: database.port || "5432",
      PGUSER: decodeURIComponent(database.username),
      PGPASSWORD: decodeURIComponent(database.password),
      PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
      PGSSLMODE: database.searchParams.get("sslmode") ?? "prefer",
    },
  });
}

async function assertAdministrator(pool: Pool, actor: BackupActor): Promise<void> {
  if (actor.role !== "ADMINISTRATOR") throw new BackupAuthorizationError();
  const result = await pool.query(
    "SELECT 1 FROM insight.users WHERE id = $1 AND role = 'ADMINISTRATOR' AND status <> 'DISABLED'",
    [actor.id],
  );
  if (result.rowCount !== 1) throw new BackupAuthorizationError();
}

async function loadBackup(pool: Pool, id: string): Promise<BackupRow> {
  const result = await pool.query<BackupRow>(
    `SELECT id, status, application_version, postgres_major, migration_head, created_at,
            completed_at, dump_filename, byte_length::text, sha256, failure_code
     FROM insight.database_backups WHERE id = $1`,
    [id],
  );
  if (result.rowCount !== 1) throw new BackupNotFoundError();
  return result.rows[0]!;
}

function statusFromRow(row: BackupRow): BackupStatus {
  const completed = row.status === "COMPLETED" && row.byte_length !== null && row.sha256 !== null;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    manifest: completed
      ? {
          schemaVersion: "1",
          backupId: row.id,
          applicationVersion: row.application_version,
          postgresMajor: row.postgres_major,
          migrationHead: row.migration_head,
          createdAt: row.created_at.toISOString(),
          byteLength: Number(row.byte_length),
          sha256: row.sha256!,
          dumpFilename: row.dump_filename,
        }
      : null,
    failureCode: row.failure_code,
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function audit(
  database: Pool | PoolClient,
  eventType: string,
  backupId: string,
  actorUserId: string,
  requestId: string,
  metadata: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  await database.query(
    `INSERT INTO insight.database_backup_audit_events
       (event_type, backup_id, actor_user_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventType, backupId, actorUserId, requestId, metadata],
  );
}

function actorFrom(session: SessionContext | undefined): BackupActor | null {
  return session?.user.role === "ADMINISTRATOR"
    ? { id: session.user.id, role: session.user.role }
    : null;
}

function sendBackupError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof BackupAuthorizationError) return forbidden(request, reply);
  if (error instanceof BackupNotFoundError) return safeError(request, reply, 404, "NOT_FOUND");
  if (error instanceof BackupNotReadyError)
    return safeError(request, reply, 409, "BACKUP_NOT_READY");
  if (error instanceof BackupIntegrityError)
    return safeError(request, reply, 409, "BACKUP_INTEGRITY_FAILED");
  throw error;
}

function forbidden(request: FastifyRequest, reply: FastifyReply) {
  return safeError(request, reply, 403, "FORBIDDEN");
}

function safeError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 403 | 404 | 409,
  code: string,
) {
  const messages = {
    403: "Request is not permitted.",
    404: "Resource was not found.",
    409: "Backup is not available for download.",
  } as const;
  const body: ApiError = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    error: { status, code, message: messages[status], requestId: request.id },
  };
  return reply.status(status).send(body);
}

const manifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1"),
    backupId: Type.String({ pattern: UUID_PATTERN }),
    applicationVersion: Type.String(),
    postgresMajor: Type.Integer(),
    migrationHead: Type.Integer(),
    createdAt: Type.String({ format: "date-time" }),
    byteLength: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    dumpFilename: Type.String(),
  },
  { additionalProperties: false },
);

const backupResponseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CURRENT_SCHEMA_VERSION),
    backup: Type.Object(
      {
        id: Type.String({ pattern: UUID_PATTERN }),
        status: Type.Union([
          Type.Literal("RUNNING"),
          Type.Literal("COMPLETED"),
          Type.Literal("FAILED"),
        ]),
        createdAt: Type.String({ format: "date-time" }),
        completedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
        manifest: Type.Union([manifestSchema, Type.Null()]),
        failureCode: Type.Union([Type.Literal("BACKUP_FAILED"), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

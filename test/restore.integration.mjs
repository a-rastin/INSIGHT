import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildApp, storeArtifact } from "../.tsbuild/server/index.js";
import {
  RestorePostCheckError,
  RestoreValidationError,
  createPostgresPool,
  migrateToHead,
  rollbackDatabaseRestore,
  restoreDatabase,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const executeFile = promisify(execFile);
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;

test("full-replacement PostgreSQL restore", async (suite) => {
  assert.ok(
    adminDatabaseUrl,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test(
    "valid backup replaces every row and preserves authentication and artifacts",
    () =>
      withRestoreFixture(async (fixture) => {
        await fixture.pool.query("UPDATE insight.restore_probe SET value = 'live-modified'");
        await fixture.pool.end();

        const result = await restoreDatabase(fixture.options());
        assert.equal(result.verifiedArtifacts, 1);
        assert.equal(result.migrationHead, 36);
        assert.equal(await exists(fixture.markerPath), false);

        const restored = createPostgresPool({ connectionString: fixture.targetDatabaseUrl });
        const rollback = createPostgresPool({
          connectionString: databaseUrlFor(adminDatabaseUrl, result.rollbackDatabase),
        });
        try {
          assert.equal(
            (await restored.query("SELECT value FROM insight.restore_probe")).rows[0].value,
            "backup",
          );
          assert.equal(
            (await rollback.query("SELECT value FROM insight.restore_probe")).rows[0].value,
            "live-modified",
          );
          const app = buildApp({
            authentication: {
              pool: restored,
              allowInsecureLoopbackCookie: true,
              loginDelay: async () => {},
            },
          });
          try {
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url: "/api/v1/login",
                  payload: { username: "admin", password: "admin" },
                })
              ).statusCode,
              200,
            );
          } finally {
            await app.close();
          }
        } finally {
          await restored.end().catch(() => undefined);
          await rollback.end();
          await dropDatabase(result.rollbackDatabase);
        }
      }),
  );

  await suite.test("corrupt dump leaves live database untouched and maintenance active", () =>
    withRestoreFixture(async (fixture) => {
      await fixture.pool.query("UPDATE insight.restore_probe SET value = 'live-corrupt-test'");
      await writeFile(fixture.dumpPath, "corrupt");
      await assert.rejects(() => restoreDatabase(fixture.options()), RestoreValidationError);
      assert.equal(
        (await fixture.pool.query("SELECT value FROM insight.restore_probe")).rows[0].value,
        "live-corrupt-test",
      );
      assert.equal(await exists(fixture.markerPath), true);
    }),
  );

  await suite.test(
    "incompatible application and PostgreSQL versions leave live database untouched",
    () =>
      withRestoreFixture(async (fixture) => {
        await fixture.pool.query("UPDATE insight.restore_probe SET value = 'live-version-test'");
        const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
        manifest.applicationVersion = "1.0.0";
        await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
        await assert.rejects(() => restoreDatabase(fixture.options()), RestoreValidationError);
        manifest.applicationVersion = "0.1.0";
        manifest.postgresMajor = 15;
        await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
        await assert.rejects(() => restoreDatabase(fixture.options()), RestoreValidationError);
        assert.equal(
          (await fixture.pool.query("SELECT value FROM insight.restore_probe")).rows[0].value,
          "live-version-test",
        );
      }),
  );

  await suite.test("missing artifact is reported and never claimed as recovered", () =>
    withRestoreFixture(async (fixture) => {
      await fixture.pool.query("UPDATE insight.restore_probe SET value = 'live-artifact-test'");
      await rm(fixture.artifactPath);
      await assert.rejects(
        () => restoreDatabase(fixture.options()),
        (error) => {
          assert.ok(error instanceof RestoreValidationError);
          assert.match(error.message, /no files were recovered/);
          assert.deepEqual(error.artifactIssues, [
            {
              source: "artifacts",
              relativePath: fixture.artifactRelativePath,
              problem: "MISSING",
            },
          ]);
          return true;
        },
      );
      assert.equal(
        (await fixture.pool.query("SELECT value FROM insight.restore_probe")).rows[0].value,
        "live-artifact-test",
      );
    }),
  );

  await suite.test("failed post-check keeps maintenance mode and rollback database", () =>
    withRestoreFixture(async (fixture) => {
      await fixture.pool.query("UPDATE insight.restore_probe SET value = 'rollback-required'");
      await fixture.pool.end();
      let rollbackDatabase;
      await assert.rejects(
        () =>
          restoreDatabase({
            ...fixture.options(),
            postRestoreCheck: async () => {
              throw new Error("synthetic post-check failure");
            },
          }),
        (error) => {
          assert.ok(error instanceof RestorePostCheckError);
          rollbackDatabase = error.rollbackDatabase;
          return true;
        },
      );
      assert.equal(await exists(fixture.markerPath), true);
      const rollback = await rollbackDatabaseRestore(
        {
          adminDatabaseUrl,
          targetDatabaseUrl: fixture.targetDatabaseUrl,
          maintenanceMarkerPath: fixture.markerPath,
        },
        rollbackDatabase,
      );
      assert.equal(await exists(fixture.markerPath), false);
      const restored = createPostgresPool({ connectionString: fixture.targetDatabaseUrl });
      try {
        assert.equal(
          (await restored.query("SELECT value FROM insight.restore_probe")).rows[0].value,
          "rollback-required",
        );
      } finally {
        await restored.end();
        await dropDatabase(rollback.displacedDatabase);
      }
    }),
  );
});

async function withRestoreFixture(operation) {
  return withIsolatedTestDatabase(adminDatabaseUrl, async (targetDatabaseUrl) => {
    const root = await mkdtemp(join(tmpdir(), "insight-restore-test-"));
    const artifactRoot = join(root, "artifacts");
    const markerPath = join(root, "restore-maintenance");
    const pool = createPostgresPool({ connectionString: targetDatabaseUrl });
    let poolEnded = false;
    try {
      await migrateToHead(pool);
      await pool.query("CREATE TABLE insight.restore_probe (value text NOT NULL)");
      await pool.query("INSERT INTO insight.restore_probe VALUES ('backup')");
      const administrator = (
        await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
      ).rows[0];
      const artifact = await storeArtifact(
        pool,
        { id: administrator.id, role: "ADMINISTRATOR" },
        {
          kind: "XMLBIF",
          ownerId: administrator.id,
          mediaType: "application/xml",
          bytes: Buffer.from("<restore-test />"),
          accessClass: "ADMINISTRATOR",
          version: "restore-test-1",
        },
        artifactRoot,
      );
      const backupId = randomUUID();
      const dumpPath = join(root, `${backupId}.dump`);
      const manifestPath = join(root, `${backupId}.manifest.json`);
      await dumpDatabase(targetDatabaseUrl, dumpPath);
      const dumpStat = await stat(dumpPath);
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schemaVersion: "1",
          backupId,
          applicationVersion: "0.1.0",
          postgresMajor: 16,
          migrationHead: 36,
          createdAt: new Date().toISOString(),
          byteLength: dumpStat.size,
          sha256: await hashFile(dumpPath),
          dumpFilename: `${backupId}.dump`,
        })}\n`,
      );

      const originalEnd = pool.end.bind(pool);
      pool.end = async () => {
        poolEnded = true;
        return originalEnd();
      };
      await operation({
        pool,
        root,
        targetDatabaseUrl,
        artifactRoot,
        artifactPath: join(artifactRoot, artifact.relativePath),
        artifactRelativePath: artifact.relativePath,
        markerPath,
        dumpPath,
        manifestPath,
        options: () => ({
          adminDatabaseUrl,
          targetDatabaseUrl,
          dumpPath,
          manifestPath,
          artifactRoot,
          maintenanceMarkerPath: markerPath,
          applicationVersion: "0.1.0",
        }),
      });
    } finally {
      if (!poolEnded) await pool.end().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function dumpDatabase(connectionString, outputPath) {
  const database = new URL(connectionString);
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

async function dropDatabase(database) {
  const pool = createPostgresPool({ connectionString: adminDatabaseUrl, maxConnections: 1 });
  try {
    await pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await pool.query(`DROP DATABASE "${database}"`);
  } finally {
    await pool.end();
  }
}

function databaseUrlFor(connectionString, database) {
  const value = new URL(connectionString);
  value.pathname = `/${database}`;
  return value.toString();
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}

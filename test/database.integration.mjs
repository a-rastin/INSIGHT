import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseCompatibilityError,
  MigrationError,
  assertSchemaAtHead,
  createPostgresPool,
  getMigrationStatus,
  migrateToHead,
  migrations,
  withIsolatedTestDatabase,
  withTransaction,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL migration acceptance", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("empty database migrates to head and rerun is idempotent", async () => {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        assert.deepEqual(await getMigrationStatus(pool), {
          state: "empty",
          databaseHead: 0,
          codeHead: 3,
          appliedCount: 0,
        });
        await assert.rejects(() => assertSchemaAtHead(pool), DatabaseCompatibilityError);

        const first = await migrateToHead(pool);
        const second = await migrateToHead(pool);
        assert.deepEqual(first.applied, [1, 2, 3]);
        assert.deepEqual(second.applied, []);
        assert.equal((await assertSchemaAtHead(pool)).state, "current");
        assert.equal((await pool.query("SHOW TIME ZONE")).rows[0].TimeZone, "UTC");

        await assert.rejects(
          () =>
            withTransaction(pool, async (client) => {
              await client.query("CREATE TABLE insight.rollback_probe (id integer)");
              throw new Error("rollback probe");
            }),
          /rollback probe/,
        );
        assert.equal(
          (await pool.query("SELECT to_regclass('insight.rollback_probe') AS table_name")).rows[0]
            .table_name,
          null,
        );
      } finally {
        await pool.end();
      }
    });
  });

  await suite.test("concurrent migration attempts serialize", async () => {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const lockMigration = {
        version: 4,
        name: "migration_lock_probe",
        sql: "SELECT pg_sleep(0.2); CREATE TABLE insight.lock_probe (id integer);",
      };
      const testMigrations = [...migrations, lockMigration];
      const firstPool = createPostgresPool({ connectionString, maxConnections: 1 });
      const secondPool = createPostgresPool({ connectionString, maxConnections: 1 });
      try {
        const results = await Promise.all([
          migrateToHead(firstPool, testMigrations),
          migrateToHead(secondPool, testMigrations),
        ]);
        assert.equal(results.flatMap((result) => result.applied).length, 4);
        assert.equal(
          (
            await firstPool.query(
              "SELECT count(*)::integer AS count FROM insight_schema_migrations",
            )
          ).rows[0].count,
          4,
        );
      } finally {
        await Promise.all([firstPool.end(), secondPool.end()]);
      }
    });
  });

  await suite.test("failed migration rolls back and can be corrected safely", async () => {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      const failedMigration = {
        version: 4,
        name: "failure_probe",
        sql: "CREATE TABLE insight.failure_probe (id integer); SELECT missing_function();",
      };
      try {
        await assert.rejects(
          () => migrateToHead(pool, [...migrations, failedMigration]),
          (error) => {
            assert.ok(error instanceof MigrationError);
            assert.match(error.message, /transaction was rolled back/);
            assert.match(error.message, /SQLSTATE 42883/);
            assert.doesNotMatch(error.message, /missing_function/);
            return true;
          },
        );
        assert.equal(
          (await pool.query("SELECT count(*)::integer AS count FROM insight_schema_migrations"))
            .rows[0].count,
          3,
        );
        assert.equal(
          (await pool.query("SELECT to_regclass('insight.failure_probe') AS table_name")).rows[0]
            .table_name,
          null,
        );

        const repairedMigration = {
          version: 4,
          name: "failure_probe",
          sql: "CREATE TABLE insight.failure_probe (id integer);",
        };
        assert.deepEqual((await migrateToHead(pool, [...migrations, repairedMigration])).applied, [
          4,
        ]);
      } finally {
        await pool.end();
      }
    });
  });

  await suite.test("startup rejects a divergent migration ledger", async () => {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        await pool.query("UPDATE insight_schema_migrations SET checksum = $1 WHERE version = 1", [
          "0".repeat(64),
        ]);
        await assert.rejects(
          () => assertSchemaAtHead(pool),
          (error) =>
            error instanceof DatabaseCompatibilityError &&
            /never edit the ledger manually/.test(error.message),
        );
      } finally {
        await pool.end();
      }
    });
  });
});

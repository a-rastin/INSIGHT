import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_CREDENTIAL_RISK,
  LastEnabledAdministratorError,
  UsernameUnavailableError,
  authenticateUser,
  changePassword,
  createUser,
  setUserEnabled,
} from "../.tsbuild/server/identity/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const bootstrapCredential = "admin";

test("identity migration and services", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("first migration creates one usable bootstrap Administrator once", async () => {
    await withIdentityDatabase(async (pool) => {
      const beforeRestart = await pool.query(
        `SELECT id, username, username_normalized, password_hash, password_policy_version,
                role, status, bootstrap_credential_active
         FROM insight.users`,
      );
      assert.equal(beforeRestart.rowCount, 1);
      assert.deepEqual(
        {
          username: beforeRestart.rows[0].username,
          usernameNormalized: beforeRestart.rows[0].username_normalized,
          role: beforeRestart.rows[0].role,
          status: beforeRestart.rows[0].status,
          bootstrapCredentialActive: beforeRestart.rows[0].bootstrap_credential_active,
        },
        {
          username: "admin",
          usernameNormalized: "admin",
          role: "ADMINISTRATOR",
          status: "ENABLED",
          bootstrapCredentialActive: true,
        },
      );

      const authentication = await authenticateUser(
        pool,
        bootstrapCredential.toUpperCase(),
        bootstrapCredential,
      );
      assert.equal(authentication.authenticated, true);
      assert.equal(authentication.user?.securityRisk, BOOTSTRAP_CREDENTIAL_RISK);
      assert.equal(authentication.user?.status, "ENABLED");

      assert.deepEqual((await migrateToHead(pool)).applied, []);
      const afterRestart = await pool.query(
        "SELECT id, password_hash FROM insight.users ORDER BY created_at",
      );
      assert.equal(afterRestart.rowCount, 1);
      assert.equal(afterRestart.rows[0].id, beforeRestart.rows[0].id);
      assert.equal(afterRestart.rows[0].password_hash, beforeRestart.rows[0].password_hash);
    });
  });

  await suite.test(
    "usernames collide case-insensitively and one-character passwords work",
    async () => {
      await withIdentityDatabase(async (pool) => {
        const user = await createUser(pool, {
          username: "Alice",
          password: "x",
          role: "PSYCHIATRIST",
        });
        assert.equal(user.usernameNormalized, "alice");
        await assert.rejects(
          () =>
            createUser(pool, {
              username: "  aLICE ",
              password: "y",
              role: "PSYCHIATRIST",
            }),
          UsernameUnavailableError,
        );
        await assert.rejects(
          () => pool.query("UPDATE insight.users SET role = 'AUDITOR' WHERE id = $1", [user.id]),
          (error) => error.code === "22P02",
        );
        await assert.rejects(
          () => createUser(pool, { username: "Empty", password: "", role: "PSYCHIATRIST" }),
          /at least 1 character/,
        );
        await assert.rejects(() => changePassword(pool, user.id, ""), /at least 1 character/);
        await changePassword(pool, user.id, "z");
        assert.equal((await authenticateUser(pool, "ALICE", "z")).authenticated, true);
      });
    },
  );

  await suite.test(
    "successful verification rehashes after password policy version changes",
    async () => {
      await withIdentityDatabase(async (pool) => {
        const previousPolicy = {
          version: 1,
          memoryCost: 8_192,
          timeCost: 1,
          parallelism: 1,
          hashLength: 32,
        };
        const replacementPolicy = {
          version: 2,
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
          hashLength: 32,
        };
        const user = await createUser(
          pool,
          { username: "Rehash", password: "x", role: "PSYCHIATRIST" },
          previousPolicy,
        );
        const before = await pool.query("SELECT password_hash FROM insight.users WHERE id = $1", [
          user.id,
        ]);

        const authenticated = await authenticateUser(pool, "rehash", "x", replacementPolicy);
        assert.equal(authenticated.authenticated, true);
        assert.equal(authenticated.passwordRehashed, true);
        const after = await pool.query(
          "SELECT password_hash, password_policy_version FROM insight.users WHERE id = $1",
          [user.id],
        );
        assert.notEqual(after.rows[0].password_hash, before.rows[0].password_hash);
        assert.equal(after.rows[0].password_policy_version, replacementPolicy.version);
      });
    },
  );

  await suite.test("last enabled Administrator cannot be disabled", async () => {
    await withIdentityDatabase(async (pool) => {
      const bootstrap = (
        await pool.query("SELECT id FROM insight.users WHERE role = 'ADMINISTRATOR'")
      ).rows[0];
      await assert.rejects(
        () => setUserEnabled(pool, bootstrap.id, false),
        LastEnabledAdministratorError,
      );

      const second = await createUser(pool, {
        username: "SecondAdmin",
        password: "x",
        role: "ADMINISTRATOR",
      });
      assert.equal((await setUserEnabled(pool, bootstrap.id, false))?.status, "DISABLED");
      await assert.rejects(
        () => setUserEnabled(pool, second.id, false),
        LastEnabledAdministratorError,
      );

      await setUserEnabled(pool, bootstrap.id, true);
      const concurrent = await Promise.allSettled([
        setUserEnabled(pool, bootstrap.id, false),
        setUserEnabled(pool, second.id, false),
      ]);
      assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(
        concurrent.filter(
          (result) =>
            result.status === "rejected" && result.reason instanceof LastEnabledAdministratorError,
        ).length,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM insight.users WHERE role = 'ADMINISTRATOR' AND status = 'ENABLED'",
          )
        ).rows[0].count,
        1,
      );
    });
  });
});

async function withIdentityDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      return await operation(pool);
    } finally {
      await pool.end();
    }
  });
}

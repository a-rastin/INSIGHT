import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildApp,
  changePassword,
  createUser,
  queryOperationalAuditEvents,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const dumpBytes = Buffer.from("PGDMP synthetic complete database dump");

test("manual PostgreSQL backup", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("Administrator creates, verifies, audits, and downloads backup", () =>
    withBackupDatabase(async (pool, root) => {
      const administrator = (
        await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
      ).rows[0];
      await changePassword(pool, administrator.id, "backup-admin-password");
      const psychiatrist = await createUser(pool, {
        username: "BackupDenied",
        password: "backup-research-password",
        role: "PSYCHIATRIST",
      });
      let failDump = false;
      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        backup: {
          root,
          databaseUrl: "postgresql://not-used",
          applicationVersion: "9.8.7-test",
          dumpDatabase: async (_databaseUrl, outputPath) => {
            if (failDump) throw new Error("synthetic failure containing no clinical content");
            await writeFile(outputPath, dumpBytes, { flag: "wx" });
          },
        },
      });
      try {
        const adminSession = await login(app, "admin", "backup-admin-password");
        const psychiatristSession = await login(
          app,
          psychiatrist.username,
          "backup-research-password",
        );

        assert.equal(
          (await app.inject({ method: "POST", url: "/api/v1/admin/backups" })).statusCode,
          401,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/admin/backups",
              headers: {
                cookie: psychiatristSession.cookie,
                "x-csrf-token": psychiatristSession.csrfToken,
              },
            })
          ).statusCode,
          403,
        );

        const started = await app.inject({
          method: "POST",
          url: "/api/v1/admin/backups",
          headers: {
            cookie: adminSession.cookie,
            "x-csrf-token": adminSession.csrfToken,
          },
        });
        assert.equal(started.statusCode, 202);
        const completed = await waitForStatus(app, adminSession.cookie, started.json().backup.id);
        assert.equal(completed.status, "COMPLETED");
        assert.equal(completed.manifest.applicationVersion, "9.8.7-test");
        assert.equal(completed.manifest.postgresMajor, 16);
        assert.equal(completed.manifest.migrationHead, 36);
        assert.equal(completed.manifest.byteLength, dumpBytes.length);
        assert.equal(completed.manifest.sha256, sha256(dumpBytes));
        assert.doesNotMatch(JSON.stringify(completed), /patient|clinical|firstName|lastName/i);

        const sidecar = JSON.parse(
          await readFile(join(root, `${completed.id}.manifest.json`), "utf8"),
        );
        assert.deepEqual(sidecar, completed.manifest);
        for (const suffix of ["", "/manifest"]) {
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: `/api/v1/admin/backups/${completed.id}${suffix}`,
                headers: { cookie: psychiatristSession.cookie },
              })
            ).statusCode,
            403,
          );
        }
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/api/v1/admin/backups/${completed.id}/download`,
              headers: { cookie: psychiatristSession.cookie },
            })
          ).statusCode,
          403,
        );

        const download = await app.inject({
          method: "GET",
          url: `/api/v1/admin/backups/${completed.id}/download`,
          headers: { cookie: adminSession.cookie },
        });
        assert.equal(download.statusCode, 200);
        assert.deepEqual(download.rawPayload, dumpBytes);
        assert.equal(download.headers["x-content-sha256"], completed.manifest.sha256);

        const audit = await queryOperationalAuditEvents(
          pool,
          { id: administrator.id, role: "ADMINISTRATOR" },
          { targetType: "BACKUP", limit: 20 },
        );
        assert.deepEqual(audit.events.map(({ eventType }) => eventType).sort(), [
          "DATABASE_BACKUP_COMPLETED",
          "DATABASE_BACKUP_DOWNLOADED",
          "DATABASE_BACKUP_STARTED",
        ]);
        assert.doesNotMatch(JSON.stringify(audit), /patient|clinical|firstName|lastName/i);

        await writeFile(join(root, completed.manifest.dumpFilename), "corrupt");
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/api/v1/admin/backups/${completed.id}/download`,
              headers: { cookie: adminSession.cookie },
            })
          ).statusCode,
          409,
        );

        failDump = true;
        const failedStart = await app.inject({
          method: "POST",
          url: "/api/v1/admin/backups",
          headers: {
            cookie: adminSession.cookie,
            "x-csrf-token": adminSession.csrfToken,
          },
        });
        const failed = await waitForStatus(app, adminSession.cookie, failedStart.json().backup.id);
        assert.equal(failed.status, "FAILED");
        assert.equal(failed.failureCode, "BACKUP_FAILED");
        assert.equal(failed.manifest, null);
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/api/v1/admin/backups/${failed.id}/download`,
              headers: { cookie: adminSession.cookie },
            })
          ).statusCode,
          409,
        );
      } finally {
        await app.close();
      }
    }),
  );
});

async function waitForStatus(app, cookie, backupId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/backups/${backupId}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    if (response.json().backup.status !== "RUNNING") return response.json().backup;
    await delay(5);
  }
  assert.fail("backup did not finish");
}

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: response.headers["set-cookie"].split(";", 1)[0],
    csrfToken: response.json().csrfToken,
  };
}

async function withBackupDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    const root = await mkdtemp(join(tmpdir(), "insight-backup-test-"));
    try {
      await migrateToHead(pool);
      return await operation(pool, root);
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

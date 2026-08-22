import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildApp } from "../.tsbuild/server/app.js";
import { createUser } from "../.tsbuild/server/identity/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;

test("opaque session HTTP security", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test(
    "cookies are opaque and hardened, CSRF is central, sessions coexist, and credential changes revoke",
    async () => {
      await withAuthenticationDatabase(async (pool) => {
        await createUser(pool, {
          username: "Alice",
          password: "alice-password",
          role: "PSYCHIATRIST",
        });
        const app = buildAuthenticationApp(pool, async (api) => {
          api.post("/protected", async () => ({ accepted: true }));
        });
        try {
          const first = await login(app, "Alice", "alice-password");
          const second = await login(app, "Alice", "alice-password");

          assert.match(first.setCookie, /HttpOnly/i);
          assert.match(first.setCookie, /Secure/i);
          assert.match(first.setCookie, /SameSite=Strict/i);
          assert.doesNotMatch(first.response.body, new RegExp(escapeRegex(first.token)));
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM insight.sessions WHERE revoked_at IS NULL",
              )
            ).rows[0].count,
            2,
          );
          assert.deepEqual(
            (
              await pool.query("SELECT token_hash FROM insight.sessions WHERE token_hash = $1", [
                createHash("sha256").update(first.token).digest(),
              ])
            ).rowCount,
            1,
          );

          const missingCsrf = await app.inject({
            method: "POST",
            url: "/api/v1/protected",
            headers: { cookie: first.cookie },
          });
          assert.equal(missingCsrf.statusCode, 403);
          assert.equal(missingCsrf.json().error.code, "INVALID_CSRF");

          const validCsrf = await app.inject({
            method: "POST",
            url: "/api/v1/protected",
            headers: { cookie: first.cookie, "x-csrf-token": first.csrfToken },
          });
          assert.equal(validCsrf.statusCode, 200);

          const logout = await app.inject({
            method: "POST",
            url: "/api/v1/logout",
            headers: { cookie: first.cookie, "x-csrf-token": first.csrfToken },
          });
          assert.equal(logout.statusCode, 204);
          assert.match(logout.headers["set-cookie"], /Max-Age=0/i);
          assert.equal((await readSession(app, first.cookie)).statusCode, 401);
          assert.equal((await readSession(app, second.cookie)).statusCode, 200);

          const refreshed = await readSession(app, second.cookie);
          const passwordChange = await app.inject({
            method: "POST",
            url: "/api/v1/session/password",
            headers: {
              cookie: second.cookie,
              "x-csrf-token": refreshed.json().csrfToken,
            },
            payload: { password: "replacement-password" },
          });
          assert.equal(passwordChange.statusCode, 204);
          assert.equal((await readSession(app, second.cookie)).statusCode, 401);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM insight.sessions WHERE revoked_at IS NULL",
              )
            ).rows[0].count,
            0,
          );

          const loopback = buildAuthenticationApp(pool, undefined, true);
          try {
            const developmentLogin = await login(loopback, "Alice", "replacement-password");
            assert.doesNotMatch(developmentLogin.setCookie, /; Secure/i);
            assert.match(developmentLogin.setCookie, /HttpOnly/i);
            assert.match(developmentLogin.setCookie, /SameSite=Strict/i);
          } finally {
            await loopback.close();
          }
        } finally {
          await app.close();
        }
      });
    },
  );

  await suite.test("Administrator reset and disablement revoke every target session", async () => {
    await withAuthenticationDatabase(async (pool) => {
      const psychiatrist = await createUser(pool, {
        username: "Target",
        password: "target-password",
        role: "PSYCHIATRIST",
      });
      const app = buildAuthenticationApp(pool);
      try {
        const targetOne = await login(app, "Target", "target-password");
        const targetTwo = await login(app, "Target", "target-password");
        const administrator = await login(app, "admin", "admin");

        const reset = await app.inject({
          method: "POST",
          url: `/api/v1/admin/psychiatrists/${psychiatrist.id}/reset-password`,
          headers: {
            cookie: administrator.cookie,
            "x-csrf-token": administrator.csrfToken,
          },
          payload: { password: "temporary-password" },
        });
        assert.equal(reset.statusCode, 204);
        assert.equal((await readSession(app, targetOne.cookie)).statusCode, 401);
        assert.equal((await readSession(app, targetTwo.cookie)).statusCode, 401);

        const temporary = await login(app, "Target", "temporary-password");
        assert.equal(temporary.response.json().user.status, "PASSWORD_CHANGE_REQUIRED");
        const blocked = await app.inject({
          method: "POST",
          url: "/api/v1/protected-by-status",
          headers: { cookie: temporary.cookie, "x-csrf-token": temporary.csrfToken },
        });
        assert.equal(blocked.statusCode, 403);
        assert.equal(blocked.json().error.code, "PASSWORD_CHANGE_REQUIRED");

        const disable = await app.inject({
          method: "POST",
          url: `/api/v1/admin/psychiatrists/${psychiatrist.id}/disable`,
          headers: {
            cookie: administrator.cookie,
            "x-csrf-token": administrator.csrfToken,
          },
        });
        assert.equal(disable.statusCode, 204);
        assert.equal((await readSession(app, temporary.cookie)).statusCode, 401);

        assert.deepEqual(
          (
            await pool.query(
              `SELECT event_type FROM insight.security_audit_events
               WHERE subject_user_id = $1
                 AND event_type IN ('PASSWORD_RESET', 'ACCOUNT_DISABLED')
               ORDER BY occurred_at`,
              [psychiatrist.id],
            )
          ).rows.map(({ event_type }) => event_type),
          ["PASSWORD_RESET", "ACCOUNT_DISABLED"],
        );
      } finally {
        await app.close();
      }
    });
  });

  await suite.test(
    "failed sign-in delay progresses with generic, non-enumerating audit",
    async () => {
      await withAuthenticationDatabase(async (pool) => {
        await createUser(pool, {
          username: "Known",
          password: "known-password",
          role: "PSYCHIATRIST",
        });
        const delays = [];
        const app = buildAuthenticationApp(pool, undefined, false, async (milliseconds) => {
          delays.push(milliseconds);
        });
        try {
          const knownFirst = await failedLogin(app, "Known");
          const missingFirst = await failedLogin(app, "Missing");
          const knownSecond = await failedLogin(app, "Known");
          assert.deepEqual(delays, [250, 250, 500]);
          assert.deepEqual(publicError(knownFirst), publicError(missingFirst));
          assert.deepEqual(publicError(knownFirst), publicError(knownSecond));

          const audit = await pool.query(
            `SELECT actor_user_id, subject_user_id
           FROM insight.security_audit_events
           WHERE event_type = 'FAILED_SIGN_IN'`,
          );
          assert.equal(audit.rowCount, 3);
          assert.ok(
            audit.rows.every(
              ({ actor_user_id, subject_user_id }) =>
                actor_user_id === null && subject_user_id === null,
            ),
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer AS count
               FROM information_schema.columns
               WHERE table_schema = 'insight'
                 AND table_name = 'security_audit_events'
                 AND column_name LIKE '%username%'`,
              )
            ).rows[0].count,
            0,
          );
        } finally {
          await app.close();
        }
      });
    },
  );
});

function buildAuthenticationApp(
  pool,
  registerApiRoutes,
  allowInsecureLoopbackCookie = false,
  loginDelay = async () => {},
) {
  return buildApp({
    registerApiRoutes,
    authentication: { pool, allowInsecureLoopbackCookie, loginDelay },
  });
}

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  const cookie = setCookie.split(";", 1)[0];
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  return { response, setCookie, cookie, token, csrfToken: response.json().csrfToken };
}

function readSession(app, cookie) {
  return app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie } });
}

function failedLogin(app, username) {
  return app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password: "wrong-password" },
  });
}

function publicError(response) {
  const { status, code, message } = response.json().error;
  return { status, code, message };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withAuthenticationDatabase(operation) {
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "@sinclair/typebox";

import { buildApp } from "../.tsbuild/server/app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validationRoutes = async (api) => {
  api.post(
    "/validate/:id",
    {
      schema: {
        params: Type.Object({ id: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
        querystring: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        body: Type.Object(
          { label: Type.String({ minLength: 1, maxLength: 20 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ accepted: Type.Literal(true) }, { additionalProperties: false }),
        },
      },
    },
    async () => ({ accepted: true }),
  );

  api.get(
    "/unsafe-exception",
    {
      schema: {
        response: {
          200: Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false }),
        },
      },
    },
    async () => {
      throw new Error(
        "password=secret SELECT * FROM users at /srv/insight/apps/server/src/private.ts:42",
      );
    },
  );

  api.get(
    "/unsafe-response",
    {
      schema: {
        response: {
          200: Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false }),
        },
      },
    },
    async () => ({ password: "secret", path: "/srv/private" }),
  );
};

test("versioned health and readiness responses carry server UUID request IDs", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const health = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { "x-request-id": "browser-controlled" },
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { schemaVersion: "1", status: "ok" });
  assert.match(health.headers["x-request-id"], UUID);

  const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), {
    schemaVersion: "1",
    status: "ready",
    checks: { application: "ready", database: "ready", worker: "ready" },
  });
});

test("params, query, body, and responses are validated with safe stable errors", async (t) => {
  const app = buildApp({ registerApiRoutes: validationRoutes });
  t.after(() => app.close());

  const valid = await app.inject({
    method: "POST",
    url: "/api/v1/validate/1?enabled=true",
    payload: { label: "valid" },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { accepted: true });

  const malformedRequests = [
    { url: "/api/v1/validate/no?enabled=true", payload: { label: "valid" } },
    { url: "/api/v1/validate/1?enabled=not-boolean", payload: { label: "valid" } },
    { url: "/api/v1/validate/1?enabled=true", payload: { label: "", extra: true } },
  ];
  for (const request of malformedRequests) {
    const malformed = await app.inject({ method: "POST", ...request });
    assert.equal(malformed.statusCode, 400);
    const malformedBody = malformed.json();
    assert.equal(malformedBody.schemaVersion, "1");
    assert.equal(malformedBody.error.code, "INVALID_REQUEST");
    assert.equal(malformedBody.error.message, "Request validation failed.");
    assert.match(malformedBody.error.requestId, UUID);
    assert.ok(malformedBody.error.issues.length >= 1);
    assert.deepEqual(
      [...new Set(malformedBody.error.issues.map(({ message }) => message))],
      ["Value does not match the published contract."],
    );
  }

  const badJson = await app.inject({
    method: "POST",
    url: "/api/v1/validate/1?enabled=true",
    headers: { "content-type": "application/json" },
    payload: '{"label":',
  });
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.json().error.code, "BAD_REQUEST");

  for (const path of ["/api/v1/unsafe-exception", "/api/v1/unsafe-response"]) {
    const response = await app.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json().error.message, "An internal error occurred.");
    assert.doesNotMatch(response.body, /password|secret|select|\/srv\/|private\.ts/i);
  }
});

test("not-found and unsupported-version responses stay inside the API envelope", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const missing = await app.inject({ method: "GET", url: "/api/v1/missing" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "NOT_FOUND");

  const unsupported = await app.inject({ method: "GET", url: "/api/v2/health" });
  assert.equal(unsupported.statusCode, 404);
  assert.equal(unsupported.json().error.code, "UNSUPPORTED_API_VERSION");
});

test("published OpenAPI matches the checked-in contract", async (t) => {
  const app = buildApp({ authentication: { pool: {} } });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
  const published = JSON.parse(await readFile("docs/api/openapi.v1.json", "utf8"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), published);
  assert.ok(published.paths["/api/v1/admin/users"]);
  assert.ok(published.paths["/api/v1/admin/users/{userId}/reset-password"]);
  assert.equal(published.paths["/api/v1/signup"], undefined);
  assert.equal(published.paths["/api/v1/recover-password"], undefined);
});

test("production static assets and SPA fallback do not intercept API routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "insight-static-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>INSIGHT</title>");
  await writeFile(join(root, "app.js"), "globalThis.INSIGHT = true;");

  const app = buildApp({ staticRoot: root });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true });
  });

  const asset = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, "globalThis.INSIGHT = true;");

  const navigation = await app.inject({ method: "GET", url: "/patients/example" });
  assert.equal(navigation.statusCode, 200);
  assert.match(navigation.body, /<title>INSIGHT<\/title>/);

  const unsupported = await app.inject({ method: "GET", url: "/api/v9/health" });
  assert.equal(unsupported.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(unsupported.json().error.code, "UNSUPPORTED_API_VERSION");
});

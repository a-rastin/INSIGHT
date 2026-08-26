import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactInputError,
  ArtifactIntegrityError,
  DEFAULT_MODEL_AGENT_SETTINGS,
  InternalMcpGateway,
  MODEL_AGENT_PROMPT_VERSION,
  ModelAgentError,
  appendJobProgress,
  authenticateUser,
  buildApp,
  pinModelAgent,
  readArtifact,
  runModelAgent,
  sessionCookie,
} from "../.tsbuild/server/index.js";
import {
  MAX_XMLBIF_ELEMENTS,
  MAX_XMLBIF_NESTING_DEPTH,
  parseXmlBif,
} from "../packages/bayes/dist/index.js";
import { Type } from "@sinclair/typebox";

const UUID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000002";

const routes = async (api) => {
  api.post("/bounded", async (request) => request.body);
  api.get("/bounded", async () => ({ ok: true }));
};

test("HTTP limits, security headers, and safe 429 responses", async (t) => {
  const app = buildApp({
    production: true,
    registerApiRoutes: routes,
    rateLimit: { max: 2, windowMilliseconds: 60_000 },
  });
  t.after(() => app.close());

  const first = await app.inject({ method: "GET", url: "/api/v1/bounded" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  assert.equal(first.headers["x-frame-options"], "DENY");
  assert.equal(first.headers["cache-control"], "no-store");

  const second = await app.inject({ method: "GET", url: "/api/v1/bounded" });
  assert.equal(second.statusCode, 200);
  const limited = await app.inject({ method: "GET", url: "/api/v1/bounded" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "TOO_MANY_REQUESTS");
  assert.match(limited.headers["retry-after"], /^\d+$/);
  assert.doesNotMatch(limited.body, /stack|node_modules|\/home\//i);
});

test("body, JSON nesting, and header limits fail before handlers", async (t) => {
  const app = buildApp({ registerApiRoutes: routes });
  t.after(() => app.close());

  const oversized = await app.inject({
    method: "POST",
    url: "/api/v1/bounded",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ value: "x".repeat(1_048_576) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "PAYLOAD_TOO_LARGE");

  let nested = { value: true };
  for (let index = 0; index < 33; index += 1) nested = { value: nested };
  const deep = await app.inject({ method: "POST", url: "/api/v1/bounded", payload: nested });
  assert.equal(deep.statusCode, 413);
  assert.equal(deep.json().error.code, "PAYLOAD_TOO_LARGE");

  const headers = await app.inject({
    method: "GET",
    url: "/api/v1/bounded",
    headers: { "x-padding": "x".repeat(17_000) },
  });
  assert.equal(headers.statusCode, 431);
  assert.equal(headers.json().error.code, "REQUEST_HEADERS_TOO_LARGE");
});

test("XML entities, depth, and node floods return bounded diagnostics", () => {
  const entity = parseXmlBif(
    '<!DOCTYPE BIF [<!ENTITY x SYSTEM "file:///etc/passwd">]><BIF><NETWORK><NAME>&x;</NAME></NETWORK></BIF>',
  );
  assert.equal(entity.ok, false);
  assert.equal(entity.diagnostics[0].code, "XML_MALFORMED");
  assert.doesNotMatch(entity.diagnostics[0].message, /etc\/passwd|root:/i);
  assert.equal(
    parseXmlBif(`<BIF>${"<X>".repeat(MAX_XMLBIF_NESTING_DEPTH)}</X></BIF>`).diagnostics[0].code,
    "XML_DEPTH_LIMIT",
  );
  assert.equal(
    parseXmlBif(`<BIF>${"<X/>".repeat(MAX_XMLBIF_ELEMENTS)}</BIF>`).diagnostics[0].code,
    "XML_ELEMENT_LIMIT",
  );
});

test("SQL input stays parameterized", async () => {
  const attack = "admin' OR 1=1; DROP TABLE insight.users; --";
  let observed;
  const pool = {
    query: async (text, values) => {
      observed = { text, values };
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await authenticateUser(pool, attack, "invalid"), { authenticated: false });
  assert.equal(observed.text, "SELECT * FROM insight.users WHERE username_normalized = $1");
  assert.deepEqual(observed.values, [attack.toLowerCase()]);
  assert.doesNotMatch(observed.text, /drop table|or 1=1/i);
});

test("artifact traversal and symlink escapes never read outside root", async () => {
  const root = await mkdtemp(join(tmpdir(), "insight-abuse-root-"));
  const outside = await mkdtemp(join(tmpdir(), "insight-abuse-outside-"));
  const actor = { id: UUID, role: "PSYCHIATRIST" };
  const row = {
    id: ARTIFACT_ID,
    kind: "EXPORT",
    owner_id: UUID,
    relative_path: "../../etc/passwd",
    media_type: "application/json",
    byte_length: "1",
    sha256: "0".repeat(64),
    access_class: "OWNER",
    artifact_version: "1",
    created_by_user_id: UUID,
    created_at: new Date(),
  };
  const pool = {
    query: async (text) =>
      text.includes("FROM insight.users")
        ? { rows: [{ exists: 1 }], rowCount: 1 }
        : { rows: [row], rowCount: 1 },
  };
  try {
    await assert.rejects(() => readArtifact(pool, actor, ARTIFACT_ID, root), ArtifactInputError);
    row.relative_path = `${UUID}/${ARTIFACT_ID}`;
    await writeFile(join(outside, ARTIFACT_ID), "x");
    await symlink(outside, join(root, UUID));
    await assert.rejects(
      () => readArtifact(pool, actor, ARTIFACT_ID, root),
      ArtifactIntegrityError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("model tool arguments and endpoint duration are bounded", async () => {
  let domainCalls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      domainCalls += 1;
      return { data: { catalogVersion: "test", candidates: [] } };
    },
  });
  const context = {
    executionId: UUID,
    jobId: "job-1",
    subjectRef: "subject",
    researchCaseRevision: 1,
    workflowState: "NORMALIZING_MEDICATIONS",
    actorRole: "PSYCHIATRIST",
    allowedToolNames: [
      "research_case.get_context",
      "medication.search_candidates",
      "medication.commit_mapping",
    ],
    idempotencyKey: "test",
  };
  const pin = pinModelAgent({
    executionId: UUID,
    jobId: "job-1",
    researchCaseId: ARTIFACT_ID,
    researchCaseRevision: 1,
    inputRevision: 1,
    workflowState: context.workflowState,
    endpoint: {
      configurationId: UUID,
      configurationVersion: 1,
      configurationFingerprint: "a".repeat(64),
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test",
      credential: "test",
    },
    promptVersion: MODEL_AGENT_PROMPT_VERSION,
    prompt: "test",
    inputSchema: Type.Object({ task: Type.String() }),
    outputSchema: Type.Object({ ok: Type.Boolean() }),
    input: { task: "test" },
    settings: { ...DEFAULT_MODEL_AGENT_SETTINGS, endpointAttempts: 1, retryDelayMilliseconds: 0 },
    context,
    gateway,
  });
  const fetch = async () =>
    new globalThis.Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "attack",
                  type: "function",
                  function: {
                    name: "medication.search_candidates",
                    arguments: "x".repeat(65_537),
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    runModelAgent({ pin, gateway, assertCurrentRevision: async () => true, fetch }),
    (error) => error instanceof ModelAgentError && error.code === "TOOL_CALL_REJECTED",
  );
  assert.equal(domainCalls, 0);

  await assert.rejects(
    runModelAgent({
      pin: { ...pin, settings: { ...pin.settings, maxResponseBytes: 100 } },
      gateway,
      assertCurrentRevision: async () => true,
      fetch: async () => new globalThis.Response("x".repeat(101)),
    }),
    (error) => error instanceof ModelAgentError && error.code === "BUDGET_EXHAUSTED",
  );

  const startedAt = Date.now();
  const timeoutPin = {
    ...pin,
    settings: { ...pin.settings, timeoutMilliseconds: 5 },
  };
  const keepAlive = globalThis.setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(
      runModelAgent({
        pin: timeoutPin,
        gateway,
        assertCurrentRevision: async () => true,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      }),
      (error) => error instanceof ModelAgentError && error.code === "ENDPOINT_EXHAUSTED",
    );
  } finally {
    globalThis.clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - startedAt < 1_000);
});

test("job progress values are bounded before persistence", async () => {
  const noDatabase = { query: async () => assert.fail("database must not be reached") };
  const claim = { job: { id: "job" }, leaseOwner: "worker", attempt: 1 };
  await assert.rejects(
    appendJobProgress(noDatabase, claim, { code: "STAGE", completedUnits: 2, totalUnits: 1 }),
    /Invalid progress units/,
  );
  await assert.rejects(
    appendJobProgress(noDatabase, claim, { code: "STAGE", totalUnits: 1_000_000_001 }),
    /Invalid progress units/,
  );
});

test("production cookie flags retain explicit loopback development exception", () => {
  assert.match(sessionCookie("token"), /; HttpOnly; SameSite=Strict; Secure;/);
  assert.doesNotMatch(sessionCookie("token", false), /; Secure(?:;|$)/);
});

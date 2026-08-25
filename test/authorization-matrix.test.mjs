import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_MATRIX,
  AUTHORIZATION_PRINCIPALS,
  MODEL_TOOL_NAMES,
  REST_AUTHORIZATION_OPERATION_IDS,
  WORKFLOW_COMMANDS,
  authorizationRow,
  buildApp,
  isSurfaceAuthorized,
} from "../.tsbuild/server/index.js";

const fakePool = { query: async () => ({ rowCount: 0, rows: [] }) };

test("authorization inventory covers every REST and SSE operation", async () => {
  const app = buildApp({
    authentication: { pool: fakePool },
    backup: { root: "/tmp", databaseUrl: "postgresql://unused", applicationVersion: "test" },
    patient: {
      officialIdentifier: {
        type: "TEST",
        issuingAuthority: "TEST",
        pattern: "^TEST$",
        normalization: "NFKC",
      },
    },
  });
  try {
    await app.ready();
    const document = app.swagger();
    const registered = Object.values(document.paths)
      .flatMap((path) => Object.values(path))
      .map((operation) => operation?.operationId)
      .filter(Boolean);
    registered.push("getOpenApiDocument");
    assert.deepEqual(new Set(registered), new Set(REST_AUTHORIZATION_OPERATION_IDS));
  } finally {
    await app.close();
  }
});

test("every matrix row has explicit exhaustive allow and deny classifications", () => {
  assert.equal(new Set(AUTHORIZATION_MATRIX.map(({ id }) => id)).size, AUTHORIZATION_MATRIX.length);
  for (const policy of AUTHORIZATION_MATRIX) {
    assert.ok(policy.surface, policy.id);
    assert.ok(policy.objectAccess, policy.id);
    assert.ok(policy.dataClass, policy.id);
    assert.deepEqual(
      new Set([...policy.allowed, ...policy.denied]),
      new Set(AUTHORIZATION_PRINCIPALS),
      policy.id,
    );
    assert.deepEqual(
      policy.allowed.filter((principal) => policy.denied.includes(principal)),
      [],
      policy.id,
    );
    for (const principal of AUTHORIZATION_PRINCIPALS) {
      const expected = policy.allowed.includes(principal) && policy.workflowStates.length === 0;
      assert.equal(
        isSurfaceAuthorized(policy.id, principal),
        expected,
        `${policy.id}:${principal}`,
      );
      if (policy.workflowStates.length > 0) {
        assert.equal(isSurfaceAuthorized(policy.id, principal, "INVALID_STATE"), false, policy.id);
        assert.equal(
          isSurfaceAuthorized(policy.id, principal, policy.workflowStates[0]),
          policy.allowed.includes(principal),
          policy.id,
        );
      }
    }
  }
  assert.equal(isSurfaceAuthorized("unregistered-command", "ADMINISTRATOR"), false);
});

test("MCP and workflow command inventories are complete and state-bound", () => {
  assert.deepEqual(
    new Set(AUTHORIZATION_MATRIX.filter(({ surface }) => surface === "MCP").map(({ id }) => id)),
    new Set(MODEL_TOOL_NAMES),
  );
  assert.deepEqual(
    new Set(
      AUTHORIZATION_MATRIX.filter(({ surface }) => surface === "WORKFLOW").map(({ id }) => id),
    ),
    new Set(WORKFLOW_COMMANDS),
  );
  for (const id of [...MODEL_TOOL_NAMES, ...WORKFLOW_COMMANDS]) {
    const policy = authorizationRow(id);
    assert.deepEqual(policy.allowed, ["PSYCHIATRIST"], id);
    assert.equal(policy.objectAccess, "SHARED_PSYCHIATRIST_PATIENT", id);
    assert.ok(policy.workflowStates.length > 0, id);
  }
});

test("role separation denies clinical payloads to Administrators and administration to Psychiatrists", () => {
  for (const policy of AUTHORIZATION_MATRIX) {
    if (policy.dataClass === "CLINICAL") {
      assert.equal(policy.denied.includes("ADMINISTRATOR"), true, policy.id);
    }
    if (policy.dataClass === "SYSTEM_ADMIN") {
      assert.equal(policy.denied.includes("PSYCHIATRIST"), true, policy.id);
    }
    if (policy.allowed.includes("ADMINISTRATOR") && !policy.allowed.includes("PSYCHIATRIST")) {
      assert.equal(policy.denied.includes("PSYCHIATRIST"), true, policy.id);
    }
  }
  const deletion = authorizationRow("deletePatient");
  assert.deepEqual(deletion.allowed, ["PSYCHIATRIST"]);
  assert.equal(deletion.objectAccess, "SHARED_PSYCHIATRIST_PATIENT");
});

test("special surfaces have explicit rows", () => {
  const required = new Set([
    "SSE",
    "JOB",
    "MCP",
    "AUDIT",
    "ARTIFACT",
    "BACKUP",
    "RESTORE",
    "WORKFLOW",
  ]);
  for (const surface of AUTHORIZATION_MATRIX.map(({ surface }) => surface))
    required.delete(surface);
  assert.deepEqual(required, new Set());
});

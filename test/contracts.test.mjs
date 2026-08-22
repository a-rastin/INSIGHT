import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";

import {
  ASSESSMENT_STATUSES,
  ASSESSMENT_TYPES,
  ApiErrorSchema,
  AssessmentStateSchema,
  AssessmentStatusSchema,
  AssessmentTypeSchema,
  ContractValidationError,
  PaginationQuerySchema,
  ProvenanceSchema,
  RoleSchema,
  TimestampSchema,
  UnsupportedSchemaVersionError,
  UuidSchema,
  hashCanonicalJson,
  isContract,
  parseContract,
  parseVersionedContract,
  stableSerialize,
} from "../packages/contracts/dist/index.js";

const id = "018f47a2-7b31-7cc8-9f0d-2f3be39c40a8";
const hash = "a".repeat(64);

test("UUID, timestamp, role, and pagination schemas reject invalid values", () => {
  assert.equal(isContract(UuidSchema, id), true);
  assert.equal(isContract(UuidSchema, "patient-1"), false);
  assert.equal(isContract(TimestampSchema, "2024-02-29T10:20:30.123Z"), true);
  assert.equal(isContract(TimestampSchema, "2025-02-29T10:20:30Z"), false);
  assert.equal(isContract(TimestampSchema, "2025-01-01 10:20:30"), false);
  assert.equal(isContract(RoleSchema, "ADMINISTRATOR"), true);
  assert.equal(isContract(RoleSchema, "admin"), false);
  assert.equal(isContract(PaginationQuerySchema, { limit: 0 }), false);
  assert.equal(isContract(PaginationQuerySchema, { limit: 25, extra: true }), false);
});

test("shared assessment contract keeps every state and type explicit", () => {
  for (const type of ASSESSMENT_TYPES) assert.equal(isContract(AssessmentTypeSchema, type), true);
  for (const status of ASSESSMENT_STATUSES) {
    assert.equal(isContract(AssessmentStatusSchema, status), true);
    assert.equal(
      isContract(AssessmentStateSchema, {
        researchCaseId: id,
        assessmentType: "CSSRS_RECENT",
        status,
        updatedByUserId: id,
        updatedAt: "2026-08-22T10:20:30Z",
      }),
      true,
    );
  }
  assert.equal(isContract(AssessmentStatusSchema, "COMPLETE"), false);
  assert.equal(isContract(AssessmentTypeSchema, "SUICIDE_RISK"), false);
});

test("versioned contracts reject unknown versions before payload validation", () => {
  const error = {
    schemaVersion: "2",
    error: { status: 400, code: "BAD_REQUEST", message: "Bad request", requestId: id },
  };
  assert.throws(
    () => parseVersionedContract(ApiErrorSchema, error),
    (received) =>
      received instanceof UnsupportedSchemaVersionError &&
      received.received === "2" &&
      received.supported === "1",
  );
});

test("malformed API errors fail with stable validation issues", () => {
  const malformed = {
    schemaVersion: "1",
    error: { status: 200, code: "bad-code", message: "", requestId: "not-a-uuid", leaked: true },
  };
  assert.throws(
    () => parseVersionedContract(ApiErrorSchema, malformed),
    (received) => {
      assert.ok(received instanceof ContractValidationError);
      assert.deepEqual(
        received.issues.map(({ path }) => path),
        [
          "/error/code",
          "/error/leaked",
          "/error/message",
          "/error/requestId",
          "/error/requestId",
          "/error/status",
        ],
      );
      return true;
    },
  );
});

test("provenance schema accepts only complete versioned provenance", () => {
  const provenance = {
    schemaVersion: "1",
    executionId: id,
    source: "pharmacotherapy-bn",
    sourceVersion: "3",
    inputHash: hash,
    outputHash: hash,
    recordedAt: "2026-08-22T10:20:30+03:30",
  };
  assert.deepEqual(parseVersionedContract(ProvenanceSchema, provenance), provenance);
  assert.throws(
    () => parseContract(ProvenanceSchema, { ...provenance, outputHash: "ABC" }),
    ContractValidationError,
  );
});

test("canonical serialization and hashing are stable and browser compatible", async () => {
  const left = { z: [3, { b: true, a: null }], a: "text" };
  const right = { a: "text", z: [3, { a: null, b: true }] };
  const canonical = '{"a":"text","z":[3,{"a":null,"b":true}]}';
  assert.equal(stableSerialize(left), canonical);
  assert.equal(stableSerialize(right), canonical);
  assert.equal(await hashCanonicalJson(left), createHash("sha256").update(canonical).digest("hex"));
  assert.throws(() => stableSerialize({ value: Number.NaN }), TypeError);
  assert.throws(() => stableSerialize({ value: undefined }), TypeError);
});

test("contracts public source has no server, database, secret, or Node-only imports", async () => {
  const source = await readFile(
    new URL("../packages/contracts/src/index.ts", import.meta.url),
    "utf8",
  );
  const emitted = await readFile(
    new URL("../packages/contracts/dist/index.js", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(
    await readFile(new URL("../packages/contracts/package.json", import.meta.url), "utf8"),
  );
  const imports = [...`${source}\n${emitted}`.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(imports)].sort(), ["@sinclair/typebox", "@sinclair/typebox/value"]);
  assert.equal(
    imports.some((specifier) => specifier.startsWith("node:")),
    false,
  );
  assert.equal(/(?:secret|database|apps\/server)/i.test(imports.join("\n")), false);
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(Object.keys(manifest.dependencies), ["@sinclair/typebox"]);
});

test("published JSON schemas compile at the Fastify boundary", async () => {
  const app = Fastify();
  app.post("/provenance", { schema: { body: ProvenanceSchema } }, async () => ({ status: "ok" }));
  await app.ready();
  await app.close();
});

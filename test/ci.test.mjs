import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactPolicyViolations } from "./support/artifact-policy.mjs";
import { makeSyntheticPatientIdentity } from "./support/synthetic-data.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("CI exposes every required layer without Electron packaging", async () => {
  const manifest = await readJson("package.json");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const runner = await readFile("scripts/run-ci.mjs", "utf8");
  const requiredScripts = [
    "format",
    "lint",
    "typecheck",
    "test:unit",
    "test:integration",
    "api:check",
    "db:migrate",
    "build",
    "test:container",
    "test:e2e",
    "test:artifacts:scan",
  ];

  for (const script of requiredScripts) {
    assert.match(runner, new RegExp(`"${script}"`));
  }
  assert.equal(manifest.scripts.ci, "node scripts/run-local-only.mjs node scripts/run-ci.mjs");
  assert.deepEqual(manifest.workspaces, ["apps/*", "packages/*"]);
  assert.match(workflow, /postgres:16-alpine/);
  assert.match(workflow, /cache: npm/);
  assert.doesNotMatch(workflow, /actions\/cache|Bayesian-Engine|medical-documentation|BNs\//);
});

test("network guard rejects live model and medical-source traffic", async () => {
  assert.equal(process.env.INSIGHT_TEST_NETWORK, "local-only");
  await assert.rejects(fetch("https://api.openai.com/v1/models"), /local services only/);
  await assert.rejects(fetch("https://www.medscape.com"), /local services only/);
});

test("Patient identity factory is deterministic and unmistakably synthetic", () => {
  const identity = makeSyntheticPatientIdentity(42);
  assert.equal(identity.firstName, "Synthetic");
  assert.match(identity.lastName, /^Researcher\d{6}$/);
  assert.match(identity.officialIdentifier, /^SYNTHETIC-\d{6}$/);
  assert.match(identity.email, /@example\.invalid$/);
  assert.deepEqual(identity, makeSyntheticPatientIdentity(42));
  assert.throws(() => makeSyntheticPatientIdentity(0), RangeError);
});

test("artifact policy accepts synthetic data and rejects representative secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insight-artifact-policy-"));
  try {
    const safe = JSON.stringify(makeSyntheticPatientIdentity(7));
    await writeFile(join(directory, "safe.json"), safe);
    assert.deepEqual(artifactPolicyViolations(safe), []);
    assert.notDeepEqual(
      artifactPolicyViolations("DATABASE_URL=postgresql://user:real-password@db/insight"),
      [],
    );
    assert.notDeepEqual(artifactPolicyViolations("officialIdentifier: 1234567890"), []);
  } finally {
    await rm(directory, { recursive: true });
  }
});

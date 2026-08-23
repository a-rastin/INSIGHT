import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BnModelAuthorizationError,
  createBnModelCandidate,
  createUser,
  getBnModelHistory,
  getBnModelSource,
  importAndRegisterBnModel,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const source = (table) => `<BIF VERSION="0.3"><NETWORK><NAME>MedicationChoice</NAME>
  <VARIABLE TYPE="nature"><NAME>Input</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="nature"><NAME>Choice</NAME><OUTCOME>first</OUTCOME><OUTCOME>second</OUTCOME></VARIABLE>
  <DEFINITION><FOR>Input</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
  <DEFINITION><FOR>Choice</FOR><GIVEN>Input</GIVEN><TABLE>${table}</TABLE></DEFINITION>
</NETWORK></BIF>`;

function input(xml, fileName) {
  return {
    candidate: { pathwayIdentity: "PHARMACOTHERAPY", artifactPath: fileName, version: 99 },
    source: xml,
  };
}

test("BN registry assigns immutable valid and invalid versions with matching projections", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-bn-model-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "BnAdministrator",
          password: "bn-admin-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "BnPsychiatrist",
          password: "bn-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        const actor = { id: administrator.id, role: administrator.role };
        const valid = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.1 0.9 0.8 0.2"), "valid.xml"),
          { artifactRoot },
        );
        const duplicate = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.1 0.9 0.8 0.2"), "renamed.xml"),
          { artifactRoot },
        );
        const editedSource = source("0.1 0.9 0.8 0.2").replace(
          "</VARIABLE>",
          "<PROPERTY>position = (120, 80)</PROPERTY></VARIABLE>",
        );
        const formattingCandidate = await createBnModelCandidate(
          pool,
          actor,
          valid.id,
          `\n${source("0.1 0.9 0.8 0.2")}`,
          { artifactRoot },
        );
        const candidate = await createBnModelCandidate(pool, actor, valid.id, editedSource, {
          artifactRoot,
        });
        await assert.rejects(
          createBnModelCandidate(pool, actor, valid.id, source("0.2 0.2 0.8 0.2"), {
            artifactRoot,
          }),
          /must pass all software validation checks/,
        );
        const invalid = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.2 0.2 0.8 0.2"), "invalid.xml"),
          { artifactRoot },
        );

        assert.equal(valid.version, 1);
        assert.equal(valid.lifecycle, "ACTIVE");
        assert.equal(duplicate.id, valid.id);
        assert.equal(formattingCandidate.version, 2);
        assert.equal(formattingCandidate.source.semanticSha256, valid.source.semanticSha256);
        assert.equal(candidate.version, 3);
        assert.equal(candidate.lifecycle, "IMPORTED");
        assert.notEqual(candidate.source.contentSha256, valid.source.contentSha256);
        assert.equal(await getBnModelSource(pool, actor, candidate.id, artifactRoot), editedSource);
        const active = await pool.query(
          "SELECT model_version_id FROM insight.bn_active_models WHERE pathway_identity = $1",
          ["PHARMACOTHERAPY"],
        );
        assert.equal(active.rows[0].model_version_id, valid.id);
        assert.equal(invalid.version, 4);
        assert.equal(invalid.lifecycle, "REJECTED");
        assert.equal(invalid.validation.softwareCompatible, false);
        assert.ok(
          invalid.validation.diagnostics.some(
            ({ code }) => code === "CPT_DISTRIBUTION_NOT_NORMALIZED",
          ),
        );
        assert.deepEqual(invalid.networks[0].edges, [{ source: "Input", target: "Choice" }]);
        assert.equal(invalid.calibration.status, "UNCALIBRATED");
        assert.equal(invalid.validation.clinicalValidity, "NOT_ESTABLISHED");

        const history = await getBnModelHistory(pool, actor, artifactRoot);
        assert.deepEqual(
          history.map(({ version }) => version),
          [4, 3, 2, 1],
        );
        await assert.rejects(
          pool.query("UPDATE insight.bn_model_versions SET version = 4 WHERE id = $1", [valid.id]),
          /immutable/,
        );
        await assert.rejects(
          getBnModelHistory(pool, { id: psychiatrist.id, role: psychiatrist.role }, artifactRoot),
          BnModelAuthorizationError,
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BnModelAuthorizationError,
  createUser,
  getBnModelHistory,
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
        const invalid = await importAndRegisterBnModel(
          pool,
          actor,
          input(source("0.2 0.2 0.8 0.2"), "invalid.xml"),
          { artifactRoot },
        );

        assert.equal(valid.version, 1);
        assert.equal(valid.lifecycle, "ACTIVE");
        assert.equal(duplicate.id, valid.id);
        assert.equal(invalid.version, 2);
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
          [2, 1],
        );
        await assert.rejects(
          pool.query("UPDATE insight.bn_model_versions SET version = 3 WHERE id = $1", [valid.id]),
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

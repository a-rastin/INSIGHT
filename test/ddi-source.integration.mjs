import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  DDI_TRANSFORM_VERSION,
  MEDSCAPE_PARSER_VERSION,
  activateDdiSource,
  createUser,
  importDdiSource,
  reviewDdiSource,
  sha256,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const bytes = (suffix = "") =>
  new TextEncoder().encode(`clozapine (Rx)
Interactions
Serious (1)
• carbamazepine: Interaction evidence ${suffix || "v1"}.
Adverse Effects`);

function input(artifact, permissionStatus = "granted") {
  return {
    artifact,
    manifest: {
      drugIdentity: "RXNORM.2626",
      title: "Clozapine Drug Information",
      url: "https://reference.medscape.com/drug/clozapine-1",
      publisher: "Medscape",
      retrievedAt: "2026-08-20T10:00:00.000Z",
      contentDate: "2026-08-19",
      sha256: sha256(artifact),
      parserVersion: MEDSCAPE_PARSER_VERSION,
      transformVersion: DDI_TRANSFORM_VERSION,
      reviewerId: "reviewer-1",
      reviewedAt: "2026-08-21T10:00:00.000Z",
      reviewReference: "review://ddi/1",
      permission: {
        status: permissionStatus,
        basis: "Synthetic permission fixture",
        recordReference: "legal://permission/1",
        coversStorage: permissionStatus === "granted",
        coversTransformation: permissionStatus === "granted",
        coversResearchUse: permissionStatus === "granted",
      },
      lifecycle: "quarantined",
    },
  };
}

test("DDI import is idempotent, changed bytes version, and activation remains gated", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-ddi-source-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
      await migrateToHead(pool);
      const administrator = await createUser(pool, {
        username: "DdiSourceAdministrator",
        password: "ddi-source-admin-password",
        role: "ADMINISTRATOR",
      });
      const actor = { id: administrator.id, role: administrator.role };
      const first = await importDdiSource(pool, actor, input(bytes()), { artifactRoot });
      const duplicate = await importDdiSource(pool, actor, input(bytes()), { artifactRoot });
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.version, 1);
      assert.equal(duplicate.lifecycle, "quarantined");
      assert.equal(duplicate.manifest.contentDate, "2026-08-19");
      assert.equal(duplicate.manifest.retrievedAt, "2026-08-20T10:00:00.000Z");
      assert.equal(duplicate.manifest.reviewedAt, "2026-08-21T10:00:00.000Z");
      assert.equal(duplicate.manifest.parserVersion, MEDSCAPE_PARSER_VERSION);

      const changed = await importDdiSource(pool, actor, input(bytes("v2")), { artifactRoot });
      assert.notEqual(changed.id, first.id);
      assert.equal(changed.version, 2);

      const unlicensed = await importDdiSource(
        pool,
        actor,
        {
          ...input(bytes("unlicensed"), "not_granted"),
          manifest: {
            ...input(bytes("unlicensed"), "not_granted").manifest,
            drugIdentity: "RXNORM.9999",
          },
        },
        { artifactRoot },
      );
      const reviewedUnlicensed = await reviewDdiSource(
        pool,
        actor,
        unlicensed.id,
        "reviewed",
        "review://ddi/unlicensed",
      );
      await assert.rejects(
        activateDdiSource(pool, actor, reviewedUnlicensed.id, {
          legalApprovalReference: "legal://approval/1",
          clinicalApprovalReference: "clinical://approval/1",
        }),
        /permission/,
      );

      const reviewed = await reviewDdiSource(
        pool,
        actor,
        changed.id,
        "reviewed",
        "review://ddi/v2",
      );
      const active = await activateDdiSource(pool, actor, reviewed.id, {
        legalApprovalReference: "legal://approval/1",
        clinicalApprovalReference: "clinical://approval/1",
      });
      assert.equal(active.lifecycle, "active");
      assert.equal(active.legalApprovalReference, "legal://approval/1");
      assert.equal(active.clinicalApprovalReference, "clinical://approval/1");
      assert.equal(active.interactions[0].evidenceReference.sourceSha256, active.manifest.sha256);
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactAuthorizationError,
  ArtifactInputError,
  ArtifactIntegrityError,
  createUser,
  readArtifact,
  storeArtifact,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const admin = { id: "00000000-0000-4000-8000-000000000001", role: "ADMINISTRATOR" };
const owner = { id: "00000000-0000-4000-8000-000000000002", role: "PSYCHIATRIST" };

test("artifact storage boundary", async (suite) => {
  await suite.test(
    "writes UUID path before metadata and verifies authorized reads",
    { skip: !adminConnectionString && "TEST_DATABASE_URL is required" },
    () =>
      withArtifactDatabase(async (pool, root) => {
        const administrator = await createUser(pool, {
          username: "ArtifactAdministrator",
          password: "research-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "ArtifactPsychiatrist",
          password: "research-password",
          role: "PSYCHIATRIST",
        });
        const actor = { id: administrator.id, role: administrator.role };
        const bytes = Buffer.from('<BIF VERSION="0.3"></BIF>');
        const saved = await storeArtifact(
          pool,
          actor,
          {
            kind: "XMLBIF",
            ownerId: administrator.id,
            mediaType: "application/xml",
            bytes,
            accessClass: "ADMINISTRATOR",
            version: "1.0.0",
          },
          root,
        );

        assert.match(saved.relativePath, /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
        assert.deepEqual((await readArtifact(pool, actor, saved.id, root)).bytes, bytes);
        await assert.rejects(
          () =>
            readArtifact(pool, { id: psychiatrist.id, role: psychiatrist.role }, saved.id, root),
          ArtifactAuthorizationError,
        );

        await writeFile(join(root, saved.relativePath), "changed");
        await assert.rejects(
          () => readArtifact(pool, actor, saved.id, root),
          ArtifactIntegrityError,
        );
      }),
  );

  await suite.test("rejects media, size, traversal, and symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "insight-artifact-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "insight-artifact-outside-"));
    try {
      const noQueryPool = { query: async () => assert.fail("database must not be reached") };
      await assert.rejects(
        () =>
          storeArtifact(
            noQueryPool,
            admin,
            {
              kind: "XMLBIF",
              ownerId: admin.id,
              mediaType: "text/plain",
              bytes: Buffer.from("xml"),
              accessClass: "ADMINISTRATOR",
              version: "1",
            },
            root,
          ),
        ArtifactInputError,
      );
      await assert.rejects(
        () =>
          storeArtifact(
            noQueryPool,
            admin,
            {
              kind: "XMLBIF",
              ownerId: admin.id,
              mediaType: "application/xml",
              bytes: Buffer.alloc(0),
              accessClass: "ADMINISTRATOR",
              version: "1",
            },
            root,
          ),
        ArtifactInputError,
      );

      const artifactId = "00000000-0000-4000-8000-000000000003";
      const maliciousPool = fakeReadPool({
        id: artifactId,
        owner_id: owner.id,
        relative_path: "../../outside",
      });
      await assert.rejects(
        () => readArtifact(maliciousPool, owner, artifactId, root),
        ArtifactInputError,
      );

      await writeFile(join(outside, artifactId), "outside");
      await symlink(outside, join(root, owner.id));
      const symlinkPool = fakeReadPool({
        id: artifactId,
        owner_id: owner.id,
        relative_path: `${owner.id}/${artifactId}`,
      });
      await assert.rejects(
        () => readArtifact(symlinkPool, owner, artifactId, root),
        ArtifactIntegrityError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await suite.test(
    "file failure prevents metadata; metadata failure leaves one orphan",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "insight-artifact-failure-"));
      try {
        const blockedRoot = join(root, "file-not-directory");
        await writeFile(blockedRoot, "blocked");
        let metadataQueries = 0;
        const countingPool = {
          query: async (sql) => {
            if (sql.includes("INSERT INTO insight.artifacts")) metadataQueries += 1;
            return { rowCount: 1, rows: [{}] };
          },
        };
        await assert.rejects(() =>
          storeArtifact(countingPool, admin, xmlInput(admin.id), blockedRoot),
        );
        assert.equal(metadataQueries, 0);

        const failingPool = failingMetadataPool();
        await assert.rejects(
          () => storeArtifact(failingPool, admin, xmlInput(admin.id), root),
          /synthetic metadata failure/,
        );
        const ownerEntries = await readdir(join(root, admin.id));
        assert.equal(ownerEntries.length, 1);
        assert.equal((await readFile(join(root, admin.id, ownerEntries[0]))).length, 3);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function xmlInput(ownerId) {
  return {
    kind: "XMLBIF",
    ownerId,
    mediaType: "application/xml",
    bytes: Buffer.from("xml"),
    accessClass: "ADMINISTRATOR",
    version: "1",
  };
}

function fakeReadPool(overrides) {
  return {
    query: async (sql) =>
      sql.includes("FROM insight.users")
        ? { rowCount: 1, rows: [{}] }
        : {
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000003",
                kind: "PROVENANCE",
                owner_id: owner.id,
                relative_path: `${owner.id}/00000000-0000-4000-8000-000000000003`,
                media_type: "application/json",
                byte_length: "7",
                sha256: "00".repeat(32),
                access_class: "OWNER",
                artifact_version: "1",
                created_by_user_id: owner.id,
                created_at: new Date("2026-08-25T00:00:00.000Z"),
                ...overrides,
              },
            ],
          },
  };
}

function failingMetadataPool() {
  const client = {
    query: async (sql) => {
      if (sql.startsWith("INSERT INTO insight.artifacts")) {
        throw new Error("synthetic metadata failure");
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    query: async () => ({ rowCount: 1, rows: [{}] }),
    connect: async () => client,
  };
}

async function withArtifactDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    const root = await mkdtemp(join(tmpdir(), "insight-artifact-integration-"));
    try {
      await migrateToHead(pool);
      return await operation(pool, root);
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
}

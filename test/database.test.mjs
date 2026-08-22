import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  POSTGRES_MAJOR,
  databaseConfigFromEnv,
  prepareMigrations,
} from "../.tsbuild/server/database/index.js";
import { safeDatabaseDiagnostic } from "../.tsbuild/server/database/diagnostic.js";

test("database configuration and migration definitions fail closed", () => {
  assert.equal(POSTGRES_MAJOR, 16);
  assert.throws(() => databaseConfigFromEnv({}), /DATABASE_URL is required/);
  assert.throws(
    () => databaseConfigFromEnv({ DATABASE_URL: "https://db.example.test/insight" }),
    /postgres or postgresql/,
  );

  const migration = { version: 1, name: "one", sql: "SELECT 1" };
  assert.equal(prepareMigrations([migration])[0].checksum.length, 64);
  assert.equal(
    prepareMigrations([migration])[0].checksum,
    prepareMigrations([migration])[0].checksum,
  );
  assert.throws(
    () => prepareMigrations([{ ...migration, version: 2 }]),
    /consecutive positive integers/,
  );
});

test("database diagnostics and browser bundles do not expose credentials", async () => {
  const secret = "integration-only-password";
  const unsafe = new Error(`connect ECONNREFUSED postgresql://insight:${secret}@db/insight`);
  assert.equal(safeDatabaseDiagnostic(unsafe).includes(secret), false);
  assert.equal(safeDatabaseDiagnostic(unsafe).includes("postgresql://"), false);

  const browserFiles = await sourceFiles(["apps/web/src", "packages/contracts/src"]);
  const browserSource = (
    await Promise.all(browserFiles.map((file) => readFile(file, "utf8")))
  ).join("\n");
  assert.doesNotMatch(
    browserSource,
    /DATABASE_URL|PGPASSWORD|postgres(?:ql)?:\/\/|from\s+["']pg["']/,
  );
});

async function sourceFiles(directories) {
  const files = [];
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await sourceFiles([entryPath])));
      if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(entryPath);
    }
  }
  return files;
}

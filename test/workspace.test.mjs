import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("workspace production packages do not depend on Electron", async () => {
  const packagePaths = [
    "apps/web/package.json",
    "apps/server/package.json",
    "packages/contracts/package.json",
    "packages/bayes/package.json",
  ];

  for (const path of packagePaths) {
    const manifest = await readJson(path);
    assert.equal(manifest.dependencies?.electron, undefined, path);
    assert.equal(manifest.devDependencies?.electron, undefined, path);
  }
});

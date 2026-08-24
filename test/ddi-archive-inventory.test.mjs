import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDdiArchiveInventory,
  verifyDdiArchiveInventory,
} from "../scripts/ddi-archive-inventory.mjs";

test("Medscape archive inventory and blocked batches remain deterministic", async () => {
  const first = await buildDdiArchiveInventory();
  const second = await buildDdiArchiveInventory();
  assert.deepEqual(first, second);
  await verifyDdiArchiveInventory();

  const inventory = JSON.parse(first["inventory.snapshot.json"]);
  assert.deepEqual(inventory.counts, {
    repositoryFiles: 129,
    eligibleFiles: 129,
    textFiles: 121,
    pdfFiles: 8,
    blockedFiles: 129,
    approvedFiles: 0,
    activeRecordsCreated: 0,
  });
  assert.equal(new Set(inventory.records.map(({ path }) => path)).size, 129);
  assert.deepEqual(inventory.duplicatePaths, []);
  assert.deepEqual(inventory.unsupportedFiles, []);
  assert.ok(inventory.records.every(({ importStatus }) => importStatus === "blocked"));

  const batches = [1, 2, 3, 4].map((batch) => JSON.parse(first[`import-batch-${batch}.json`]));
  assert.deepEqual(
    batches.map(({ entries }) => entries.length),
    [32, 32, 32, 33],
  );
  assert.deepEqual(
    batches.flatMap(({ entries }) => entries.map(({ position }) => position)),
    Array.from({ length: 129 }, (_, index) => index + 1),
  );
});

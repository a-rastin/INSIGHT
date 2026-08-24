import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("batch 2 evaluates every frozen entry without fabricating governance records", async () => {
  const outputs = await buildDdiArchiveInventory();
  const expected = JSON.parse(
    await readFile(new URL("fixtures/ddi-import/batch-2.expected.json", import.meta.url), "utf8"),
  );
  const batch = JSON.parse(outputs["import-batch-2.json"]);
  const report = JSON.parse(outputs["batch-2-report.json"]);
  const review = JSON.parse(outputs["batch-2-review.json"]);

  assert.equal(batch.batchSha256, expected.batchSha256);
  assert.deepEqual(
    batch.entries.map(({ position }) => position),
    Array.from({ length: 32 }, (_, index) => index + 33),
  );
  assert.deepEqual(batch.entries[0], expected.firstEntry);
  assert.deepEqual(batch.entries.at(-1), expected.lastEntry);
  assert.deepEqual(report.evaluatedPositions, batch.entries.map(({ position }) => position));
  assert.equal(report.omissions.length, 32);
  assert.equal(new Set(report.omissions.map(({ path }) => path)).size, 32);
  assert.deepEqual(report.derivedRecords, []);
  assert.deepEqual(report.evidenceRecords, []);
  assert.deepEqual(report.conflictRecords, []);
  assert.deepEqual(report.lifecycleRecords, []);
  assert.equal(review.status, "blocked");
  assert.equal(review.reviewerRecord, null);
});

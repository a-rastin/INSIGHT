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
  assert.deepEqual(
    report.evaluatedPositions,
    batch.entries.map(({ position }) => position),
  );
  assert.equal(report.omissions.length, 32);
  assert.equal(new Set(report.omissions.map(({ path }) => path)).size, 32);
  assert.deepEqual(report.derivedRecords, []);
  assert.deepEqual(report.evidenceRecords, []);
  assert.deepEqual(report.conflictRecords, []);
  assert.deepEqual(report.lifecycleRecords, []);
  assert.equal(review.status, "blocked");
  assert.equal(review.reviewerRecord, null);
});

test("batch 3 evaluates every frozen entry without changing prior batches", async () => {
  const outputs = await buildDdiArchiveInventory();
  const expected = JSON.parse(
    await readFile(new URL("fixtures/ddi-import/batch-3.expected.json", import.meta.url), "utf8"),
  );
  const batch2 = JSON.parse(outputs["import-batch-2.json"]);
  const batch = JSON.parse(outputs["import-batch-3.json"]);
  const report = JSON.parse(outputs["batch-3-report.json"]);
  const review = JSON.parse(outputs["batch-3-review.json"]);

  assert.equal(
    batch2.batchSha256,
    "2dc6186425b20fe18dcea2e51008476639267ea892a2b2eed2f9d9c738e2312c",
  );
  assert.equal(batch.batchSha256, expected.batchSha256);
  assert.equal(report.reportSha256, expected.reportSha256);
  assert.equal(review.reviewSha256, expected.reviewSha256);
  assert.deepEqual(
    batch.entries.map(({ position }) => position),
    Array.from({ length: 32 }, (_, index) => index + 65),
  );
  assert.deepEqual(batch.entries[0], expected.firstEntry);
  assert.deepEqual(batch.entries.at(-1), expected.lastEntry);
  assert.deepEqual(
    report.evaluatedPositions,
    batch.entries.map(({ position }) => position),
  );
  assert.deepEqual(
    report.omissions,
    batch.entries.map(({ position, path, blockedReasons }) => ({
      position,
      path,
      reasons: blockedReasons,
    })),
  );
  assert.equal(new Set(report.omissions.map(({ path }) => path)).size, 32);
  assert.deepEqual(report.derivedRecords, []);
  assert.deepEqual(report.evidenceRecords, []);
  assert.deepEqual(report.conflictRecords, []);
  assert.deepEqual(report.lifecycleRecords, []);
  assert.equal(review.status, "blocked");
  assert.equal(review.reviewerRecord, null);
});

test("batch 4 reconciles final frozen entries without changing prior batches", async () => {
  const outputs = await buildDdiArchiveInventory();
  const expected = JSON.parse(
    await readFile(new URL("fixtures/ddi-import/batch-4.expected.json", import.meta.url), "utf8"),
  );
  const batch3 = JSON.parse(outputs["import-batch-3.json"]);
  const batch = JSON.parse(outputs["import-batch-4.json"]);
  const report = JSON.parse(outputs["batch-4-report.json"]);
  const review = JSON.parse(outputs["batch-4-review.json"]);

  assert.equal(
    batch3.batchSha256,
    "d6d85daca0139a7adf8a9d683f356f437d7197343dc4980e1af8be95e60489b3",
  );
  assert.equal(batch.batchSha256, expected.batchSha256);
  assert.equal(report.reportSha256, expected.reportSha256);
  assert.equal(review.reviewSha256, expected.reviewSha256);
  assert.deepEqual(
    batch.entries.map(({ position }) => position),
    Array.from({ length: 33 }, (_, index) => index + 97),
  );
  assert.deepEqual(batch.entries[0], expected.firstEntry);
  assert.deepEqual(batch.entries.at(-1), expected.lastEntry);
  assert.deepEqual(
    report.evaluatedPositions,
    batch.entries.map(({ position }) => position),
  );
  assert.deepEqual(
    report.omissions,
    batch.entries.map(({ position, path, blockedReasons }) => ({
      position,
      path,
      reasons: blockedReasons,
    })),
  );
  assert.equal(new Set(report.omissions.map(({ path }) => path)).size, 33);
  assert.deepEqual(report.derivedRecords, []);
  assert.deepEqual(report.evidenceRecords, []);
  assert.deepEqual(report.conflictRecords, []);
  assert.deepEqual(report.lifecycleRecords, []);
  assert.equal(review.status, "blocked");
  assert.equal(review.reviewerRecord, null);
});

test("final coverage report reconciles every gap and rebuild input", async () => {
  const first = await buildDdiArchiveInventory();
  const second = await buildDdiArchiveInventory();
  const report = JSON.parse(first["coverage-report.json"]);

  assert.equal(first["coverage-report.json"], second["coverage-report.json"]);
  assert.deepEqual(report.counts, {
    catalogCandidates: 129,
    catalogMappedDrugs: 0,
    sourceRecords: 0,
    activeSourceRecords: 0,
    reviewedEligibleVersions: 0,
    evaluablePairs: 0,
    noMatchRecords: 0,
    unknownOrUnmappedRecords: 129,
    conflictRecords: 0,
    rejectedRecords: 0,
    blockedRecords: 129,
  });
  assert.equal(report.omissions.length, 129);
  assert.equal(new Set(report.omissions.map(({ path }) => path)).size, 129);
  assert.ok(report.omissions.every(({ reasons }) => reasons.length === 5));
  assert.deepEqual(report.activeTraceability, []);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.rejectedRecords, []);
  assert.equal(report.lifecyclePolicy.ageAloneExpiresSource, false);
  assert.equal(report.lifecyclePolicy.permissionAndManifestRequired, true);
  assert.equal(report.reviewerSignOff.status, "blocked");
  assert.equal(report.reviewerSignOff.reviewerRecord, null);
  assert.match(report.rebuildSha256, /^[0-9a-f]{64}$/);
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/);
});

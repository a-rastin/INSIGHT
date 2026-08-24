import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = "medical-documentation/ddi-checker/Medscape";
const outputRoot = "docs/ddi-import";
const outputNames = [
  "inventory.snapshot.json",
  "import-batch-1.json",
  "import-batch-2.json",
  "import-batch-3.json",
  "import-batch-4.json",
  "batch-2-report.json",
  "batch-2-review.json",
  "gap-report.md",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const byteSort = (left, right) => Buffer.from(left).compare(Buffer.from(right));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function hashPayload(payload) {
  return sha256(JSON.stringify(payload));
}

export async function buildDdiArchiveInventory() {
  const archive = resolve(root, sourceRoot);
  const allFiles = await filesUnder(archive);
  const unsupportedFiles = allFiles
    .filter((path) => ![".txt", ".pdf"].includes(extname(path).toLowerCase()))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort(byteSort);
  const paths = allFiles
    .filter((path) => [".txt", ".pdf"].includes(extname(path).toLowerCase()))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort(byteSort);
  const records = await Promise.all(
    paths.map(async (path, index) => {
      const bytes = await readFile(resolve(root, path));
      const position = index + 1;
      return {
        position,
        batch: Math.min(Math.ceil(position / 32), 4),
        path,
        medicationName: path.slice(path.lastIndexOf("/") + 1, -extname(path).length),
        mediaType:
          extname(path).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        manifestStatus: "missing",
        permissionStatus: "missing",
        catalogMappingStatus: "missing",
        importStatus: "blocked",
        blockedReasons: [
          "missing_source_manifest",
          "missing_permission_record",
          "missing_legal_approval",
          "missing_clinical_review",
          "missing_canonical_medication_id",
        ],
      };
    }),
  );
  const duplicatePaths = paths.filter((path, index) => paths.indexOf(path) !== index);
  const hashes = Map.groupBy(records, (record) => record.sha256);
  const duplicateContent = [...hashes.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([hash, matches]) => ({ hash, paths: matches.map(({ path }) => path) }));
  const counts = {
    repositoryFiles: allFiles.length,
    eligibleFiles: records.length,
    textFiles: records.filter(({ mediaType }) => mediaType.startsWith("text/plain")).length,
    pdfFiles: records.filter(({ mediaType }) => mediaType === "application/pdf").length,
    blockedFiles: records.filter(({ importStatus }) => importStatus === "blocked").length,
    approvedFiles: records.filter(({ permissionStatus }) => permissionStatus === "granted").length,
    activeRecordsCreated: 0,
  };
  const inventoryPayload = {
    schemaVersion: "insight.ddi-archive-inventory.v1",
    sourceRoot,
    canonicalSort: "UTF-8 byte order of repository-relative POSIX paths",
    counts,
    unsupportedFiles,
    duplicatePaths,
    duplicateContent,
    records,
  };
  const inventory = {
    ...inventoryPayload,
    snapshotSha256: hashPayload(inventoryPayload),
  };
  const batches = [1, 2, 3, 4].map((batch) => {
    const entries = records.filter((record) => record.batch === batch);
    const payload = {
      schemaVersion: "insight.ddi-import-batch.v1",
      batch,
      range: batch < 4 ? `${(batch - 1) * 32 + 1}-${batch * 32}` : "97-end",
      inventorySnapshotSha256: inventory.snapshotSha256,
      immutable: true,
      entries,
    };
    return { ...payload, batchSha256: hashPayload(payload) };
  });
  const batch2 = batches[1];
  const batch2ReportPayload = {
    schemaVersion: "insight.ddi-import-report.v1",
    contract: "INS-054",
    batch: 2,
    batchSha256: batch2.batchSha256,
    inventorySnapshotSha256: inventory.snapshotSha256,
    evaluatedPositions: batch2.entries.map(({ position }) => position),
    approvedEntries: 0,
    importedEntries: 0,
    parserVersion: null,
    transformVersion: null,
    derivedRecords: [],
    evidenceRecords: [],
    conflictRecords: [],
    lifecycleRecords: [],
    omissions: batch2.entries.map(({ position, path, blockedReasons }) => ({
      position,
      path,
      reasons: blockedReasons,
    })),
    result: "blocked",
  };
  const batch2Report = {
    ...batch2ReportPayload,
    reportSha256: hashPayload(batch2ReportPayload),
  };
  const batch2ReviewPayload = {
    schemaVersion: "insight.ddi-import-review.v1",
    contract: "INS-054",
    batch: 2,
    reportSha256: batch2Report.reportSha256,
    status: "blocked",
    reviewerRecord: null,
    reasons: [
      "missing_permission_record",
      "missing_legal_approval",
      "missing_clinical_review",
    ],
    note: "No reviewer identity or approval is inferred or fabricated.",
  };
  const batch2Review = {
    ...batch2ReviewPayload,
    reviewSha256: hashPayload(batch2ReviewPayload),
  };
  const gapReport = `# DDI Archive Inventory and Import Gap Report

- Inventory snapshot: \`${inventory.snapshotSha256}\`
- Repository files: ${counts.repositoryFiles}
- Eligible text/PDF files: ${counts.eligibleFiles} (${counts.textFiles} text, ${counts.pdfFiles} PDF)
- Blocked files: ${counts.blockedFiles}
- Approved files: ${counts.approvedFiles}
- Active records created: ${counts.activeRecordsCreated}
- Duplicate paths: ${duplicatePaths.length}
- Duplicate byte groups: ${duplicateContent.length}
- Unsupported files: ${unsupportedFiles.length}

## Review

All ${counts.eligibleFiles} archive candidates lack repository source manifests, permission records, legal approval, clinical review, and canonical medication IDs. ADR-005 and ADR-022 therefore block import, extraction, transformation, and activation. ADR-006 does not waive these gates. No live source or LLM fallback was used.

Batch 1 contains sorted positions 1-32. Clinical sample review and lifecycle review cannot start until required evidence exists; entries remain \`blocked\`, not falsely marked \`reviewed\`, \`active\`, or \`rejected\`. No derived interaction pair exists.

## Frozen Batches

${batches.map(({ batch, range, entries, batchSha256 }) => `- Batch ${batch} (${range}): ${entries.length} entries, \`${batchSha256}\``).join("\n")}

## Required Inputs

- Per-source title, Medscape URL, retrieval timestamp, content date, and source revision
- Written permission covering storage, transformation, and research use
- Legal and clinical approval references with reviewer identity and timestamp
- Governed medication-catalog version and canonical ID for each source
- Approved deterministic text/PDF extraction version and reviewed regression expectations
`;
  return {
    "inventory.snapshot.json": json(inventory),
    ...Object.fromEntries(
      batches.map((batch) => [`import-batch-${batch.batch}.json`, json(batch)]),
    ),
    "batch-2-report.json": json(batch2Report),
    "batch-2-review.json": json(batch2Review),
    "gap-report.md": gapReport,
  };
}

export async function verifyDdiArchiveInventory({ write = false } = {}) {
  const outputs = await buildDdiArchiveInventory();
  if (write) await mkdir(resolve(root, outputRoot), { recursive: true });
  for (const name of outputNames) {
    const path = resolve(root, outputRoot, name);
    if (write) {
      const existing = await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing !== null && existing !== outputs[name]) {
        throw new Error(`Frozen DDI inventory exists with different bytes: ${path}`);
      }
      if (existing === null) await writeFile(path, outputs[name]);
      continue;
    }
    const existing = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Missing frozen DDI inventory: ${path}`);
      throw error;
    });
    if (existing !== outputs[name]) throw new Error(`DDI inventory drift: ${path}`);
  }
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyDdiArchiveInventory({ write: process.argv.includes("--write") });
  console.log(
    "DDI archive inventory verified: 129 files, 4 frozen batches, batch 2 blocked, 0 active records.",
  );
}

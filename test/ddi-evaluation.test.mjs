import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  enumerateDdiPairs,
  extractMedscapeInteractions,
  sha256,
} from "../.tsbuild/server/index.js";

const medication = (medicationEntryRef, kind, canonicalId) => ({
  medicationEntryRef,
  kind,
  normalizationState: canonicalId ? "NORMALIZED" : "UNKNOWN",
  ...(canonicalId ? { canonicalId } : {}),
});

test("DDI clinical extraction preserves structured evidence", () => {
  const artifact = new TextEncoder().encode(`Drug A
Interactions
Serious (1)
• DRUG-B: Mechanism: CYP inhibition; Effect: increased exposure; Action: monitor closely
Adverse Effects`);
  assert.deepEqual(extractMedscapeInteractions(artifact, sha256(artifact)), [
    {
      interactingDrugIdentity: "DRUG-B",
      severity: "serious",
      evidenceText:
        "• DRUG-B: Mechanism: CYP inhibition; Effect: increased exposure; Action: monitor closely",
      mechanism: "CYP inhibition",
      clinicalEffect: "increased exposure",
      recommendedAction: "monitor closely",
      evidenceReference: { sourceSha256: sha256(artifact), lineStart: 4, lineEnd: 4 },
    },
  ]);
});

test("DDI pair enumeration is complete, unique, deterministic, and purpose-bound", () => {
  const regimen = [
    medication("proposed-2", "PROPOSED", "DRUG-D"),
    medication("current-2", "CURRENT", "DRUG-B"),
    medication("unknown-current", "CURRENT"),
    medication("current-1", "CURRENT", "DRUG-A"),
    medication("proposed-1", "PROPOSED", "DRUG-C"),
    medication("unknown-proposed", "PROPOSED"),
    medication("duplicate-a", "PROPOSED", "drug-a"),
  ];
  const primary = enumerateDdiPairs("PRIMARY_FILTER", regimen);
  assert.deepEqual(primary.knownCanonicalIds, ["DRUG-A", "DRUG-B", "DRUG-C", "DRUG-D"]);
  assert.deepEqual(primary.pairs, [
    { leftCanonicalId: "DRUG-A", rightCanonicalId: "DRUG-B" },
    { leftCanonicalId: "DRUG-A", rightCanonicalId: "DRUG-C" },
    { leftCanonicalId: "DRUG-A", rightCanonicalId: "DRUG-D" },
    { leftCanonicalId: "DRUG-B", rightCanonicalId: "DRUG-C" },
    { leftCanonicalId: "DRUG-B", rightCanonicalId: "DRUG-D" },
  ]);
  assert.equal(primary.omittedPairCount, 7);

  const final = enumerateDdiPairs("FINAL_RECHECK", regimen);
  assert.equal(final.pairs.length, 6);
  assert.equal(new Set(final.pairs.map((pair) => JSON.stringify(pair))).size, 6);
  assert.equal(final.omittedPairCount, 9);
});

test("FINAL_RECHECK enumerates n choose 2 known pairs for every permutation", () => {
  for (let count = 1; count <= 20; count += 1) {
    const forward = Array.from({ length: count }, (_, index) =>
      medication(`entry-${index}`, "CURRENT", `DRUG-${String(index).padStart(2, "0")}`),
    );
    const expected = (count * (count - 1)) / 2;
    const normal = enumerateDdiPairs("FINAL_RECHECK", forward).pairs;
    const reversed = enumerateDdiPairs("FINAL_RECHECK", [...forward].reverse()).pairs;
    assert.equal(normal.length, expected);
    assert.deepEqual(reversed, normal);
  }
});

test("all-UNKNOWN regimen succeeds with deterministic omission count", () => {
  const result = enumerateDdiPairs("FINAL_RECHECK", [
    medication("unknown-2", "PROPOSED"),
    medication("unknown-1", "CURRENT"),
  ]);
  assert.deepEqual(result.knownCanonicalIds, []);
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.unknownMedicationEntryRefs, ["unknown-1", "unknown-2"]);
  assert.equal(result.omittedPairCount, 1);
});

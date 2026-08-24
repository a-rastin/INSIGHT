import assert from "node:assert/strict";
import test from "node:test";

import { regimenFingerprint } from "../.tsbuild/server/index.js";

test("final-regimen fingerprint ignores entry refs and order but not medication identity", () => {
  const first = [
    {
      medicationEntryRef: "current-1",
      kind: "CURRENT",
      normalizationState: "UNKNOWN",
    },
    {
      medicationEntryRef: "final-1",
      kind: "PROPOSED",
      normalizationState: "NORMALIZED",
      canonicalId: "rx-risperidone",
      regimenDetails: { dose: { value: 2, unit: "mg" }, route: "oral" },
    },
  ];
  const same = [
    { ...first[1], medicationEntryRef: "renumbered-9" },
    { ...first[0], medicationEntryRef: "renumbered-8" },
  ];
  const changed = [same[0], { ...same[1], normalizationState: "NORMALIZED", canonicalId: "rx-a" }];

  assert.equal(regimenFingerprint(first), regimenFingerprint(same));
  assert.notEqual(regimenFingerprint(first), regimenFingerprint(changed));
  assert.notEqual(
    regimenFingerprint(first),
    regimenFingerprint([
      first[0],
      { ...first[1], regimenDetails: { dose: { value: 3, unit: "mg" }, route: "oral" } },
    ]),
  );
});

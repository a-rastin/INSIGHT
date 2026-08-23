import assert from "node:assert/strict";
import test from "node:test";

import {
  MedicationAuthorizationError,
  getMedicationCatalogHistory,
  normalizeMedicationSearch,
  saveMedicationCatalog,
  validateMedicationCatalogInput,
} from "../.tsbuild/server/index.js";

test("medication search normalization golden cases are stable", () => {
  const golden = new Map([
    ["  RISPERDAL®  ", "risperdal"],
    ["Lévomépromazine", "levomepromazine"],
    ["haloperidol—decanoate", "haloperidol decanoate"],
    ["CLOZAPINE   100 mg", "clozapine 100 mg"],
  ]);
  for (const [raw, normalized] of golden) assert.equal(normalizeMedicationSearch(raw), normalized);
});

test("catalog validates stable IDs and normalized synonyms", () => {
  const entry = {
    canonicalId: "RX-RISPERIDONE",
    preferredName: "Risperidone",
    synonyms: ["Risperdal"],
  };
  assert.deepEqual(validateMedicationCatalogInput({ entries: [entry] }), { entries: [entry] });
  assert.throws(
    () => validateMedicationCatalogInput({ entries: [entry, entry] }),
    /Canonical IDs must be unique/,
  );
  assert.throws(
    () => validateMedicationCatalogInput({ entries: [{ ...entry, synonyms: ["risperidone"] }] }),
    /unique per entry/,
  );
});

test("catalog governance rejects Psychiatrist before database access", async () => {
  const actor = { id: "00000000-0000-4000-8000-000000000001", role: "PSYCHIATRIST" };
  await assert.rejects(
    () => saveMedicationCatalog({}, actor, { entries: [] }),
    MedicationAuthorizationError,
  );
  await assert.rejects(() => getMedicationCatalogHistory({}, actor), MedicationAuthorizationError);
});

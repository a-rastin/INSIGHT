import assert from "node:assert/strict";
import test from "node:test";

import {
  AdverseEffectCatalogAuthorizationError,
  getActiveAdverseEffectCatalog,
  saveAdverseEffectCatalog,
  validateAdverseEffectCatalogInput,
  validateMedicalHistoryInput,
} from "../.tsbuild/server/index.js";
import {
  AdverseEffectCatalogInputSchema,
  MedicalHistoryInputSchema,
  isContract,
} from "../packages/contracts/dist/index.js";

const terms = [
  { termId: "AKATHISIA", label: "Akathisia" },
  { termId: "OTHER", label: "Other" },
];

test("adverse-effect catalog requires stable unique IDs and one OTHER term", () => {
  assert.equal(isContract(AdverseEffectCatalogInputSchema, { terms }), true);
  assert.deepEqual(validateAdverseEffectCatalogInput({ terms }), { terms });
  assert.throws(
    () => validateAdverseEffectCatalogInput({ terms: [terms[0]] }),
    /exactly one OTHER/,
  );
  assert.throws(
    () => validateAdverseEffectCatalogInput({ terms: [terms[0], terms[0], terms[1]] }),
    /unique/,
  );
});

test("OTHER supports multiselect and an explicitly empty detail", () => {
  const history = {
    presentationStatus: "KNOWN_SCHIZOPHRENIA",
    previouslyTreated: true,
    priorTrials: [
      {
        medication: "haloperidol",
        adverseEffects: [
          { catalogVersionId: "version-1", termId: "AKATHISIA" },
          { catalogVersionId: "version-1", termId: "OTHER" },
        ],
        otherAdverseEffectDetail: "",
      },
    ],
    currentMedications: [],
    comorbidities: [],
    contraindications: [],
  };
  assert.equal(isContract(MedicalHistoryInputSchema, history), true);
  assert.equal(validateMedicalHistoryInput(history).priorTrials[0].otherAdverseEffectDetail, "");
});

test("catalog service enforces role separation before database access", async () => {
  await assert.rejects(
    () =>
      saveAdverseEffectCatalog(
        {},
        { id: "00000000-0000-4000-8000-000000000001", role: "PSYCHIATRIST" },
        { terms },
      ),
    AdverseEffectCatalogAuthorizationError,
  );
  await assert.rejects(
    () =>
      getActiveAdverseEffectCatalog(
        {},
        { id: "00000000-0000-4000-8000-000000000001", role: "ADMINISTRATOR" },
      ),
    AdverseEffectCatalogAuthorizationError,
  );
});

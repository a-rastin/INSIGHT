import assert from "node:assert/strict";
import test from "node:test";

import { MedicalHistoryInputError, validateMedicalHistoryInput } from "../.tsbuild/server/index.js";
import { isContract, MedicalHistoryInputSchema } from "../packages/contracts/dist/index.js";

const common = {
  currentMedications: [{ rawMedication: "metformin" }],
  comorbidities: [],
};

test("medical-history conditional domain matrix is server-authoritative", () => {
  const valid = [
    { presentationStatus: "FIRST_PRESENTATION", ...common },
    { presentationStatus: "KNOWN_SCHIZOPHRENIA", previouslyTreated: false, ...common },
    {
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: false,
      priorTrials: [],
      ...common,
    },
    {
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: true,
      priorTrials: [{ medication: "haloperidol" }],
      ...common,
    },
    {
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: true,
      priorTrials: [{ medication: "haloperidol", response: "UNKNOWN" }],
      ...common,
    },
  ];
  for (const history of valid) {
    assert.equal(isContract(MedicalHistoryInputSchema, history), true);
    assert.doesNotThrow(() => validateMedicalHistoryInput(history));
  }

  const invalid = [
    { presentationStatus: "FIRST_PRESENTATION", previouslyTreated: false, ...common },
    { presentationStatus: "FIRST_PRESENTATION", priorTrials: [], ...common },
    { presentationStatus: "KNOWN_SCHIZOPHRENIA", ...common },
    { presentationStatus: "KNOWN_SCHIZOPHRENIA", previouslyTreated: true, ...common },
    {
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: true,
      priorTrials: [],
      ...common,
    },
    {
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: false,
      priorTrials: [{ medication: "haloperidol" }],
      ...common,
    },
  ];
  for (const history of invalid) {
    assert.throws(() => validateMedicalHistoryInput(history), MedicalHistoryInputError);
  }
});

test("trial omissions remain distinct from explicit UNKNOWN and current medicines stay separate", () => {
  const omitted = validateMedicalHistoryInput({
    presentationStatus: "KNOWN_SCHIZOPHRENIA",
    previouslyTreated: true,
    priorTrials: [{ medication: " haloperidol " }],
    ...common,
  });
  const unknown = validateMedicalHistoryInput({
    ...omitted,
    priorTrials: [{ medication: "haloperidol", response: "UNKNOWN" }],
  });
  assert.equal(Object.hasOwn(omitted.priorTrials[0], "response"), false);
  assert.equal(unknown.priorTrials[0].response, "UNKNOWN");
  assert.deepEqual(omitted.currentMedications, [{ rawMedication: "metformin" }]);
  assert.equal(omitted.priorTrials[0].medication, "haloperidol");
});

test("client normalization fields are discarded and catalog duplicates fail", () => {
  const validated = validateMedicalHistoryInput({
    presentationStatus: "FIRST_PRESENTATION",
    currentMedications: [
      {
        rawMedication: "haloperidol",
        normalizationState: "NORMALIZED",
        canonicalMedicationId: "forged-id",
      },
    ],
    comorbidities: [],
  });
  assert.deepEqual(validated.currentMedications, [{ rawMedication: "haloperidol" }]);
  assert.throws(
    () =>
      validateMedicalHistoryInput({
        presentationStatus: "FIRST_PRESENTATION",
        currentMedications: [],
        comorbidities: [
          { catalogVersionId: "v1", termId: "diabetes" },
          { catalogVersionId: "v1", termId: "diabetes" },
        ],
      }),
    MedicalHistoryInputError,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DSM5TR_INSTRUMENT_PIN,
  Dsm5trAnswersSchema,
  calculateDsm5tr,
  isContract,
} from "../packages/contracts/dist/index.js";

const positive = {
  criterionA: {
    delusions: true,
    hallucinations: true,
    disorganizedSpeech: false,
    disorganizedOrCatatonicBehavior: false,
    negativeSymptoms: false,
  },
  criterionBFunctionalDecline: true,
  criterionCDuration: true,
  criterionDMoodDisorderExclusion: true,
  criterionESubstanceOrMedicalExclusion: true,
  criterionFDevelopmentalHistory: false,
};

const goldenVectors = [
  ["all requirements met", positive, "CRITERIA_MET"],
  [
    "only one criterion-A symptom",
    { ...positive, criterionA: { ...positive.criterionA, hallucinations: false } },
    "CRITERIA_NOT_MET",
  ],
  [
    "two criterion-A symptoms without a required core symptom",
    {
      ...positive,
      criterionA: {
        delusions: false,
        hallucinations: false,
        disorganizedSpeech: false,
        disorganizedOrCatatonicBehavior: true,
        negativeSymptoms: true,
      },
    },
    "CRITERIA_NOT_MET",
  ],
  [
    "functional criterion not met",
    { ...positive, criterionBFunctionalDecline: false },
    "CRITERIA_NOT_MET",
  ],
  [
    "developmental history requires conditional response",
    { ...positive, criterionFDevelopmentalHistory: true },
    "INCOMPLETE",
  ],
  [
    "developmental conditional requirement not met",
    {
      ...positive,
      criterionFDevelopmentalHistory: true,
      criterionFProminentDelusionsOrHallucinations: false,
    },
    "CRITERIA_NOT_MET",
  ],
  [
    "developmental conditional requirement met",
    {
      ...positive,
      criterionFDevelopmentalHistory: true,
      criterionFProminentDelusionsOrHallucinations: true,
    },
    "CRITERIA_MET",
  ],
  ["missing answer stays incomplete", { ...positive, criterionCDuration: undefined }, "INCOMPLETE"],
];

test("engineering golden vectors pin DSM-5-TR calculation v1", () => {
  for (const [name, answers, disposition] of goldenVectors) {
    assert.equal(calculateDsm5tr(answers).disposition, disposition, name);
  }
  assert.equal(DSM5TR_INSTRUMENT_PIN.schemaVersion, "1.0.0");
  assert.equal(DSM5TR_INSTRUMENT_PIN.calculationVersion, "1.0.0");
});

test("all complete boolean combinations match independent criteria properties", () => {
  for (let mask = 0; mask < 2 ** 11; mask += 1) {
    const bit = (index) => Boolean(mask & (1 << index));
    const answers = {
      criterionA: {
        delusions: bit(0),
        hallucinations: bit(1),
        disorganizedSpeech: bit(2),
        disorganizedOrCatatonicBehavior: bit(3),
        negativeSymptoms: bit(4),
      },
      criterionBFunctionalDecline: bit(5),
      criterionCDuration: bit(6),
      criterionDMoodDisorderExclusion: bit(7),
      criterionESubstanceOrMedicalExclusion: bit(8),
      criterionFDevelopmentalHistory: bit(9),
      criterionFProminentDelusionsOrHallucinations: bit(10),
    };
    const symptomCount = Object.values(answers.criterionA).filter(Boolean).length;
    const core =
      answers.criterionA.delusions ||
      answers.criterionA.hallucinations ||
      answers.criterionA.disorganizedSpeech;
    const expected =
      symptomCount >= 2 &&
      core &&
      answers.criterionBFunctionalDecline &&
      answers.criterionCDuration &&
      answers.criterionDMoodDisorderExclusion &&
      answers.criterionESubstanceOrMedicalExclusion &&
      (!answers.criterionFDevelopmentalHistory ||
        answers.criterionFProminentDelusionsOrHallucinations)
        ? "CRITERIA_MET"
        : "CRITERIA_NOT_MET";
    assert.equal(calculateDsm5tr(answers).disposition, expected, `mask ${mask}`);
  }
});

test("answer schema rejects missing root and ungoverned fields", () => {
  assert.equal(isContract(Dsm5trAnswersSchema, positive), true);
  assert.equal(isContract(Dsm5trAnswersSchema, {}), false);
  assert.equal(isContract(Dsm5trAnswersSchema, { ...positive, score: 1 }), false);
});

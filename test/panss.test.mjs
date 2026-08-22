import assert from "node:assert/strict";
import test from "node:test";

import {
  PANSS_ANCHORS,
  PANSS_INSTRUMENT_PIN,
  PANSS_ITEMS,
  PanssAnswersSchema,
  calculatePanss,
  isContract,
} from "../packages/contracts/dist/index.js";

const vector = (score) => Object.fromEntries(PANSS_ITEMS.map(({ id }) => [id, score]));

test("PANSS definition pins all items, anchors, and original subscale membership", () => {
  assert.equal(PANSS_ITEMS.length, 30);
  assert.deepEqual(
    PANSS_ITEMS.map(({ id, text }) => [id, text]),
    [
      ["P1", "Delusions"],
      ["P2", "Conceptual disorganization"],
      ["P3", "Hallucinatory behavior"],
      ["P4", "Excitement"],
      ["P5", "Grandiosity"],
      ["P6", "Suspiciousness/persecution"],
      ["P7", "Hostility"],
      ["N1", "Blunted affect"],
      ["N2", "Emotional withdrawal"],
      ["N3", "Poor rapport"],
      ["N4", "Passive/apathetic social withdrawal"],
      ["N5", "Difficulty in abstract thinking"],
      ["N6", "Lack of spontaneity and flow of conversation"],
      ["N7", "Stereotyped thinking"],
      ["G1", "Somatic concern"],
      ["G2", "Anxiety"],
      ["G3", "Guilt feelings"],
      ["G4", "Tension"],
      ["G5", "Mannerisms and posturing"],
      ["G6", "Depression"],
      ["G7", "Motor retardation"],
      ["G8", "Uncooperativeness"],
      ["G9", "Unusual thought content"],
      ["G10", "Disorientation"],
      ["G11", "Poor attention"],
      ["G12", "Lack of judgment and insight"],
      ["G13", "Disturbance of volition"],
      ["G14", "Poor impulse control"],
      ["G15", "Preoccupation"],
      ["G16", "Active social avoidance"],
    ],
  );
  assert.deepEqual(
    PANSS_ANCHORS.map(({ score, label }) => [score, label]),
    [
      [1, "Absent"],
      [2, "Minimal"],
      [3, "Mild"],
      [4, "Moderate"],
      [5, "Moderate severe"],
      [6, "Severe"],
      [7, "Extreme"],
    ],
  );
  assert.deepEqual(
    PANSS_ITEMS.filter(({ subscale }) => subscale === "POSITIVE").map(({ id }) => id),
    ["P1", "P2", "P3", "P4", "P5", "P6", "P7"],
  );
  assert.deepEqual(
    PANSS_ITEMS.filter(({ subscale }) => subscale === "NEGATIVE").map(({ id }) => id),
    ["N1", "N2", "N3", "N4", "N5", "N6", "N7"],
  );
  assert.deepEqual(
    PANSS_ITEMS.filter(({ subscale }) => subscale === "GENERAL").map(({ id }) => id),
    [
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8",
      "G9",
      "G10",
      "G11",
      "G12",
      "G13",
      "G14",
      "G15",
      "G16",
    ],
  );
  assert.equal(PANSS_INSTRUMENT_PIN.schemaVersion, "1.0.0");
  assert.equal(PANSS_INSTRUMENT_PIN.calculationVersion, "1.0.0");
  assert.match(PANSS_INSTRUMENT_PIN.reviewReference, /PENDING-CLINICAL-REVIEW/);
});

test("minimum, maximum, and mixed PANSS golden vectors are deterministic", () => {
  assert.deepEqual(calculatePanss(vector(1)).scores, {
    positive: 7,
    negative: 7,
    general: 16,
    total: 30,
  });
  assert.deepEqual(calculatePanss(vector(7)).scores, {
    positive: 49,
    negative: 49,
    general: 112,
    total: 210,
  });
  const mixed = Object.fromEntries(PANSS_ITEMS.map(({ id }, index) => [id, (index % 7) + 1]));
  assert.deepEqual(calculatePanss(mixed).scores, {
    positive: 28,
    negative: 28,
    general: 59,
    total: 115,
  });
});

test("every item boundary is additive and every missing item suppresses all totals", () => {
  const minimum = vector(1);
  for (const { id } of PANSS_ITEMS) {
    const raised = calculatePanss({ ...minimum, [id]: 7 });
    assert.equal(raised.status, "COMPLETE", id);
    assert.equal(raised.scores.total, 36, id);

    const incomplete = { ...minimum };
    delete incomplete[id];
    assert.deepEqual(
      calculatePanss(incomplete),
      {
        calculationVersion: "1.0.0",
        status: "INCOMPLETE",
        answeredCount: 29,
        scores: null,
      },
      id,
    );
  }
});

test("invalid PANSS values and unknown items fail", () => {
  const valid = vector(1);
  assert.equal(isContract(PanssAnswersSchema, valid), true);
  for (const invalid of [0, 8, 1.5, "1", null]) {
    assert.equal(isContract(PanssAnswersSchema, { ...valid, P1: invalid }), false);
  }
  assert.equal(isContract(PanssAnswersSchema, { ...valid, X1: 1 }), false);
  assert.throws(() => calculatePanss({ ...valid, P1: 0 }), /P1 must be an integer from 1 to 7/);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CSSRS_ACTIVATION_GATE,
  CSSRS_BANDS,
  CSSRS_DEFINITION,
  CSSRS_INSTRUMENT_PIN,
  CSSRS_SOURCE_SHA256,
  calculateCssrs,
} from "../packages/contracts/dist/index.js";

const booleans = [false, true];

function expectedBand(answers) {
  if (answers.q4Intent || answers.q5Plan || (answers.q6Behavior && answers.q6WithinThreeMonths)) {
    return "HIGH";
  }
  if (answers.q3Method || (answers.q6Behavior && !answers.q6WithinThreeMonths)) {
    return "MODERATE";
  }
  if (answers.q1WishDead || answers.q2SuicidalThoughts) return "LOW";
  return "NO_POSITIVE_RESPONSE";
}

function completeVectors() {
  const vectors = [];
  for (const q1WishDead of booleans) {
    for (const q6Behavior of booleans) {
      const recencies = q6Behavior ? booleans : [undefined];
      for (const q6WithinThreeMonths of recencies) {
        vectors.push({
          q1WishDead,
          q2SuicidalThoughts: false,
          q6Behavior,
          ...(q6Behavior ? { q6WithinThreeMonths } : {}),
        });
        for (const q3Method of booleans) {
          for (const q4Intent of booleans) {
            for (const q5Plan of booleans) {
              vectors.push({
                q1WishDead,
                q2SuicidalThoughts: true,
                q3Method,
                q4Intent,
                q5Plan,
                q6Behavior,
                ...(q6Behavior ? { q6WithinThreeMonths } : {}),
              });
            }
          }
        }
      }
    }
  }
  return vectors;
}

test("C-SSRS definition pins six questions and required timeframes", () => {
  assert.equal(CSSRS_DEFINITION.questions.length, 6);
  assert.deepEqual(
    CSSRS_DEFINITION.questions.slice(0, 5).map(({ timeframe }) => timeframe),
    Array(5).fill("PAST_MONTH"),
  );
  assert.equal(CSSRS_DEFINITION.questions[5].timeframe, "LIFETIME");
  assert.equal(CSSRS_DEFINITION.recencyFollowUp.timeframe, "PAST_THREE_MONTHS");
  assert.equal(CSSRS_INSTRUMENT_PIN.sourceSha256, CSSRS_SOURCE_SHA256);
  assert.equal(CSSRS_ACTIVATION_GATE.status, "INACTIVE");
  assert.equal(Object.values(CSSRS_ACTIVATION_GATE).filter((value) => value === true).length, 0);
  assert.deepEqual(Object.keys(CSSRS_BANDS), ["LOW", "MODERATE", "HIGH", "NO_POSITIVE_RESPONSE"]);
});

test("all 54 complete branch and band-precedence vectors pass", () => {
  const vectors = completeVectors();
  assert.equal(vectors.length, 54);

  for (const answers of vectors) {
    const result = calculateCssrs(answers);
    assert.equal(result.status, "COMPLETE", JSON.stringify(answers));
    assert.equal(result.band, expectedBand(answers), JSON.stringify(answers));
    assert.deepEqual(
      result.traversedQuestions,
      answers.q2SuicidalThoughts
        ? ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", ...(answers.q6Behavior ? ["Q6_RECENCY"] : [])]
        : ["Q1", "Q2", "Q6", ...(answers.q6Behavior ? ["Q6_RECENCY"] : [])],
      JSON.stringify(answers),
    );
    assert.equal(
      result.traversedBranch,
      answers.q2SuicidalThoughts ? "Q2_YES_ASK_Q3_TO_Q5" : "Q2_NO_SKIP_TO_Q6",
      JSON.stringify(answers),
    );
  }
});

test("incomplete and non-traversed answer combinations cannot produce a band", () => {
  assert.deepEqual(calculateCssrs({}), {
    calculationVersion: "1.0.0",
    status: "INCOMPLETE",
    band: null,
    traversedBranch: "Q2_UNANSWERED",
    traversedQuestions: ["Q1", "Q2", "Q6"],
  });
  assert.throws(
    () => calculateCssrs({ q2SuicidalThoughts: false, q3Method: true }),
    /questions 3 through 5 require/,
  );
  assert.throws(
    () => calculateCssrs({ q6Behavior: false, q6WithinThreeMonths: false }),
    /question 6 recency requires/,
  );
});

test("source hash and pending clinical-review record remain pinned", async () => {
  const source = await readFile("medical-documentation/suicide-risk/CSSRS_ScreenVersion.pdf");
  assert.equal(createHash("sha256").update(source).digest("hex"), CSSRS_SOURCE_SHA256);

  const review = await readFile("docs/reviews/cssrs-schema-and-validation.md", "utf8");
  assert.match(review, new RegExp(CSSRS_INSTRUMENT_PIN.reviewReference));
  assert.match(review, /Status: Pending clinical approval/);
  assert.match(review, /Research activation: Inactive/);
});

test("C-SSRS contract never introduces a no-risk label", async () => {
  const files = [
    "packages/contracts/src/index.ts",
    "apps/server/src/assessment/cssrs.ts",
    "apps/web/src/CssrsAssessment.tsx",
    "docs/reviews/cssrs-schema-and-validation.md",
  ];
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(["NO", "RISK"].join("_")));
  }
});

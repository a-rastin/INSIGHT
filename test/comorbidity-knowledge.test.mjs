import assert from "node:assert/strict";
import test from "node:test";

import {
  ComorbidityKnowledgeInputError,
  evaluateComorbidityRules,
  validateComorbidityKnowledgeInput,
} from "../.tsbuild/server/index.js";

const version = {
  id: "00000000-0000-4000-8000-000000000017",
  version: 1,
  sourceReference: "synthetic://golden-vectors",
  reviewerRecord: {
    reviewerId: "synthetic-reviewer",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    recordReference: "synthetic://review/17",
  },
  terms: [
    { termId: "TERM_A", label: "Synthetic A" },
    { termId: "TERM_B", label: "Synthetic B" },
  ],
  rules: [
    {
      ruleId: "RULE_ALL_OUTPUTS",
      allOfTermIds: ["TERM_B", "TERM_A"],
      results: [
        output("BN_ROUTING_FACT", "PATHWAY_X", "ELIGIBLE"),
        output("MONITORING_REQUIREMENT", "MONITOR_X", "REQUIRED"),
        output("CAUTION", "OPTION_Y", "USE_CAUTION"),
        output("CONTRAINDICATION", "OPTION_X", "EXCLUDE"),
      ],
    },
  ],
  createdByUserId: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-01-01T00:00:00.000Z",
  active: true,
};

function output(kind, targetId, value) {
  return { kind, targetId, value, explanation: `Synthetic ${kind}` };
}

function input(rules = version.rules) {
  return {
    sourceReference: version.sourceReference,
    reviewerRecord: version.reviewerRecord,
    terms: version.terms,
    rules,
  };
}

test("clinical golden vector yields all result kinds with deterministic provenance", () => {
  const left = evaluateComorbidityRules(version, [
    { termId: "TERM_B", supplementalText: "TERM_A" },
    { termId: "TERM_A" },
  ]);
  const right = evaluateComorbidityRules({ ...version, rules: [...version.rules].reverse() }, [
    { termId: "TERM_A" },
    { termId: "TERM_B" },
  ]);
  assert.deepEqual(left, right);
  assert.deepEqual(
    left.results.map(({ kind }) => kind),
    ["BN_ROUTING_FACT", "CAUTION", "CONTRAINDICATION", "MONITORING_REQUIREMENT"],
  );
  assert.ok(
    left.results.every(
      ({ knowledgeVersionId, knowledgeVersion, ruleId, matchedTermIds }) =>
        knowledgeVersionId === version.id &&
        knowledgeVersion === 1 &&
        ruleId === "RULE_ALL_OUTPUTS" &&
        matchedTermIds.join() === "TERM_A,TERM_B",
    ),
  );
});

test("supplemental free text cannot satisfy a governed rule", () => {
  const result = evaluateComorbidityRules(version, [
    { termId: "TERM_A", supplementalText: "TERM_B" },
  ]);
  assert.deepEqual(result.results, []);
});

test("ambiguous and conflicting rule sets fail validation", () => {
  const sameCondition = [
    { ruleId: "R1", allOfTermIds: ["TERM_A"], results: [output("CAUTION", "X", "A")] },
    { ruleId: "R2", allOfTermIds: ["TERM_A"], results: [output("CAUTION", "Y", "B")] },
  ];
  assert.throws(() => validateComorbidityKnowledgeInput(input(sameCondition)), /ambiguous/);

  const sameTarget = [
    { ruleId: "R1", allOfTermIds: ["TERM_A"], results: [output("CAUTION", "X", "A")] },
    { ruleId: "R2", allOfTermIds: ["TERM_B"], results: [output("CAUTION", "X", "B")] },
  ];
  assert.throws(
    () => validateComorbidityKnowledgeInput(input(sameTarget)),
    ComorbidityKnowledgeInputError,
  );
  assert.throws(
    () =>
      validateComorbidityKnowledgeInput(
        input([
          { ruleId: "R1", allOfTermIds: ["MISSING"], results: [output("CAUTION", "X", "A")] },
        ]),
      ),
    /must exist/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCptAttempt,
  fingerprintCptDependencies,
  validateGeneratedCptTables,
} from "../.tsbuild/server/index.js";

const contract = {
  routeRuleRef: "route-1",
  modelRef: "model-1",
  modelVersion: "1",
  modelHash: "a".repeat(64),
  nodes: [
    { nodeRef: "A", outcomes: ["yes", "no"], orderedParentRefs: [], requiredTableLength: 2 },
    { nodeRef: "B", outcomes: ["on", "off"], orderedParentRefs: ["A"], requiredTableLength: 4 },
  ],
};

const validTables = [
  { nodeRef: "A", probabilities: [0.25, 0.75] },
  { nodeRef: "B", probabilities: [0.1, 0.9, 0.8, 0.2] },
];

test("generated CPT validator rejects malformed-table matrix without repairing values", () => {
  const matrix = [
    {
      name: "missing table",
      tables: [validTables[0]],
      codes: ["CPT_NODE_MISSING", "CPT_NODE_ORDER"],
    },
    {
      name: "unexpected table",
      tables: [...validTables, { nodeRef: "C", probabilities: [0.5, 0.5] }],
      codes: ["CPT_NODE_UNEXPECTED", "CPT_NODE_ORDER"],
    },
    {
      name: "wrong order",
      tables: [...validTables].reverse(),
      codes: ["CPT_NODE_ORDER"],
    },
    {
      name: "duplicate table",
      tables: [validTables[0], validTables[0], validTables[1]],
      codes: ["CPT_NODE_DUPLICATE", "CPT_NODE_ORDER"],
    },
    {
      name: "wrong dimensions",
      tables: [validTables[0], { nodeRef: "B", probabilities: [0.5, 0.5] }],
      codes: ["CPT_TABLE_DIMENSION"],
    },
    {
      name: "non-number",
      tables: [{ nodeRef: "A", probabilities: ["0.5", 0.5] }, validTables[1]],
      codes: ["CPT_VALUE_NOT_NUMBER"],
    },
    {
      name: "non-finite",
      tables: [{ nodeRef: "A", probabilities: [Number.NaN, 1] }, validTables[1]],
      codes: ["CPT_VALUE_NON_FINITE"],
    },
    {
      name: "negative",
      tables: [{ nodeRef: "A", probabilities: [-0.1, 1.1] }, validTables[1]],
      codes: ["CPT_VALUE_NEGATIVE"],
    },
    {
      name: "row sum",
      tables: [validTables[0], { nodeRef: "B", probabilities: [0.2, 0.2, 0.8, 0.2] }],
      codes: ["CPT_ROW_SUM"],
    },
  ];

  assert.deepEqual(validateGeneratedCptTables(contract, validTables), []);
  for (const entry of matrix) {
    const diagnostics = validateGeneratedCptTables(contract, entry.tables);
    for (const code of entry.codes) {
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === code),
        `${entry.name}: ${code}`,
      );
    }
  }
  assert.deepEqual(validTables[1].probabilities, [0.1, 0.9, 0.8, 0.2]);
});

test("dependency fingerprint is stable only when every generation dependency is unchanged", () => {
  const dependencies = {
    canonicalResearchCaseInput: '{"age":40}',
    models: [{ modelRef: "model-1", modelVersion: "1", modelHash: "a".repeat(64) }],
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
    endpointFingerprint: "b".repeat(64),
    requestedModel: "llm-1",
    generationSettings: { temperature: 0, topP: 1 },
    imputationSnapshotRef: null,
  };
  const fingerprint = fingerprintCptDependencies(dependencies);
  assert.equal(
    fingerprintCptDependencies({
      ...dependencies,
      generationSettings: { topP: 1, temperature: 0 },
    }),
    fingerprint,
  );

  const changed = [
    { ...dependencies, canonicalResearchCaseInput: '{"age":41}' },
    { ...dependencies, models: [{ ...dependencies.models[0], modelHash: "c".repeat(64) }] },
    { ...dependencies, promptVersion: "prompt-2" },
    { ...dependencies, schemaVersion: "schema-2" },
    { ...dependencies, endpointFingerprint: "d".repeat(64) },
    { ...dependencies, requestedModel: "llm-2" },
    { ...dependencies, generationSettings: { temperature: 0.1, topP: 1 } },
    { ...dependencies, imputationSnapshotRef: "imputation-snapshot-1" },
  ];
  for (const candidate of changed) {
    assert.notEqual(fingerprintCptDependencies(candidate), fingerprint);
  }
});

test("third invalid CPT attempt is terminal", () => {
  const invalid = [{ nodeRef: "A", probabilities: [0.2, 0.2] }, validTables[1]];
  assert.deepEqual(
    [0, 1, 2].map((count) => {
      const result = evaluateCptAttempt(contract, invalid, count);
      return [result.attemptNumber, result.retryable, result.attemptsRemaining];
    }),
    [
      [1, true, 2],
      [2, true, 1],
      [3, false, 0],
    ],
  );
  const blocked = evaluateCptAttempt(contract, validTables, 3);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.retryable, false);
  assert.equal(blocked.diagnostics[0].code, "CPT_ATTEMPT_LIMIT");
});

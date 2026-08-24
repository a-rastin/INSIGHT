import assert from "node:assert/strict";
import test from "node:test";

import {
  BnRoutingAuthorizationError,
  BnRoutingError,
  INITIAL_BN_ROUTING_ARTIFACT,
  evaluateBnRouting,
  routeAndRecordBnModels,
} from "../.tsbuild/server/index.js";

const facts = {
  demographics: { age: 36, sex: "FEMALE" },
  presentationStatus: "KNOWN_SCHIZOPHRENIA",
  assessments: [
    { type: "DSM5TR", state: "COMPLETED", result: "SCHIZOPHRENIA_CONFIRMED" },
    { type: "PANSS", state: "COMPLETED", result: "TOTAL_82" },
    { type: "CSSRS_RECENT", state: "BYPASSED" },
  ],
  comorbidityTermIds: ["DIABETES", "HYPERTENSION"],
  medicationHistory: [{ canonicalMedicationId: "RX-RISPERIDONE", response: "PARTIAL_RESPONSE" }],
  currentRegimen: [{ canonicalMedicationId: "RX-ARIPIPRAZOLE" }],
};

const pharmacotherapy = {
  modelId: "model-pharmacotherapy-v3",
  pathwayIdentity: "PHARMACOTHERAPY",
  version: 3,
  contentSha256: "a".repeat(64),
  semanticSha256: "b".repeat(64),
  sourceReference: "BN-Pharmacotherapy.xml",
};

const treatmentSetting = {
  modelId: "model-treatment-setting-v1",
  pathwayIdentity: "TREATMENT_SETTING",
  version: 1,
  contentSha256: "2208cadaf8938ab1bb82b8f985296f3f75241002b8ca0958ce27a7b89010be91",
  semanticSha256: "c".repeat(64),
  sourceReference: "BN-Treatment-Setting.xml",
};

const clozapineTrs = {
  modelId: "model-clozapine-trs-v1",
  pathwayIdentity: "CLOZAPINE_TREATMENT_RESISTANCE",
  version: 1,
  contentSha256: "faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb",
  semanticSha256: "d".repeat(64),
  sourceReference: "gemini-code-1783422447172.xml",
};

test("route golden table selects only reviewed required pathway fixtures", () => {
  const golden = [
    ["FIRST_PRESENTATION", ["BN-Pharmacotherapy.xml", "BN-Treatment-Setting.xml"]],
    ["KNOWN_SCHIZOPHRENIA", ["BN-Pharmacotherapy.xml", "BN-Treatment-Setting.xml"]],
    [null, "MISSING_REQUIRED_ROUTE"],
  ];
  for (const [presentationStatus, expected] of golden) {
    const run = () =>
      evaluateBnRouting({ ...facts, presentationStatus }, INITIAL_BN_ROUTING_ARTIFACT, [
        pharmacotherapy,
        treatmentSetting,
      ]);
    if (Array.isArray(expected)) {
      assert.deepEqual(
        run().selectedModels.map(({ sourceReference }) => sourceReference),
        expected,
      );
    } else {
      assert.throws(run, (error) => error instanceof BnRoutingError && error.code === expected);
    }
  }
});

test("routing is order-independent and deterministic for pinned inputs", () => {
  const noise = {
    ...pharmacotherapy,
    modelId: "model-noise",
    pathwayIdentity: "TREATMENT_SETTING",
  };
  const propertyArtifact = {
    ...INITIAL_BN_ROUTING_ARTIFACT,
    requiredRouteGroups: ["PRIMARY_TREATMENT"],
    optionalRouteGroups: [],
    rules: [
      {
        ...INITIAL_BN_ROUTING_ARTIFACT.rules[0],
        all: [
          ...INITIAL_BN_ROUTING_ARTIFACT.rules[0].all,
          { fact: "AGE_BETWEEN", minimum: 18, maximum: 99 },
          { fact: "SEX_IN", values: ["FEMALE"] },
          { fact: "ASSESSMENT_STATE_IN", assessmentType: "DSM5TR", values: ["COMPLETED"] },
          {
            fact: "ASSESSMENT_RESULT_IN",
            assessmentType: "DSM5TR",
            values: ["SCHIZOPHRENIA_CONFIRMED"],
          },
          { fact: "COMORBIDITY_ANY", values: ["DIABETES"] },
          { fact: "PRIOR_MEDICATION_ANY", values: ["RX-RISPERIDONE"] },
          { fact: "PRIOR_RESPONSE_IN", values: ["PARTIAL_RESPONSE"] },
          { fact: "CURRENT_MEDICATION_ANY", values: ["RX-ARIPIPRAZOLE"] },
        ],
      },
      {
        ...INITIAL_BN_ROUTING_ARTIFACT.rules[0],
        ref: "BN-ROUTE-UNMATCHED-001",
        all: [{ fact: "COMORBIDITY_ANY", values: ["NOT_PRESENT"] }],
      },
    ],
  };
  const expected = evaluateBnRouting(facts, propertyArtifact, [
    pharmacotherapy,
    treatmentSetting,
    noise,
  ]);
  for (let index = 0; index < 20; index += 1) {
    const shuffledFacts = {
      ...facts,
      assessments: [...facts.assessments].reverse(),
      comorbidityTermIds: [...facts.comorbidityTermIds].reverse(),
      medicationHistory: [...facts.medicationHistory].reverse(),
      currentRegimen: [...facts.currentRegimen].reverse(),
    };
    const shuffledArtifact = { ...propertyArtifact, rules: [...propertyArtifact.rules].reverse() };
    assert.deepEqual(
      evaluateBnRouting(shuffledFacts, shuffledArtifact, [
        noise,
        treatmentSetting,
        pharmacotherapy,
      ]),
      expected,
    );
  }
});

test("ambiguous rules and missing active models fail closed", () => {
  const ambiguous = {
    ...INITIAL_BN_ROUTING_ARTIFACT,
    rules: [
      ...INITIAL_BN_ROUTING_ARTIFACT.rules,
      { ...INITIAL_BN_ROUTING_ARTIFACT.rules[0], ref: "BN-ROUTE-OTHER-001" },
    ],
  };
  assert.throws(
    () => evaluateBnRouting(facts, ambiguous, [pharmacotherapy, treatmentSetting]),
    (error) => error instanceof BnRoutingError && error.code === "AMBIGUOUS_ROUTE",
  );
  assert.throws(
    () => evaluateBnRouting(facts, INITIAL_BN_ROUTING_ARTIFACT, []),
    (error) => error instanceof BnRoutingError && error.code === "MISSING_ACTIVE_MODEL",
  );
});

test("clozapine TRS route requires two distinct adequate adherent poor-response trials", () => {
  const adequateTrial = (canonicalMedicationId) => ({
    canonicalMedicationId,
    response: "NO_RESPONSE",
    adequateDose: true,
    adequateDuration: true,
    adequateAdherence: true,
  });
  const active = [pharmacotherapy, treatmentSetting, clozapineTrs];
  const routed = evaluateBnRouting(
    {
      ...facts,
      medicationHistory: [adequateTrial("RX-RISPERIDONE"), adequateTrial("RX-OLANZAPINE")],
    },
    INITIAL_BN_ROUTING_ARTIFACT,
    active,
  );
  assert.deepEqual(routed.matchedRuleRefs, [
    "BN-ROUTE-CLOZAPINE-TRS-001",
    "BN-ROUTE-PHARMACOTHERAPY-001",
    "BN-ROUTE-TREATMENT-SETTING-001",
  ]);
  assert.deepEqual(
    routed.selectedModels.map(({ pathwayIdentity }) => pathwayIdentity),
    ["CLOZAPINE_TREATMENT_RESISTANCE", "PHARMACOTHERAPY", "TREATMENT_SETTING"],
  );

  for (const medicationHistory of [
    [adequateTrial("RX-RISPERIDONE")],
    [adequateTrial("RX-RISPERIDONE"), adequateTrial("RX-RISPERIDONE")],
    [adequateTrial("RX-RISPERIDONE"), { ...adequateTrial("RX-OLANZAPINE"), adequateDose: false }],
  ]) {
    assert.equal(
      evaluateBnRouting(
        { ...facts, medicationHistory },
        INITIAL_BN_ROUTING_ARTIFACT,
        active,
      ).selectedModels.some(
        ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_TREATMENT_RESISTANCE",
      ),
      false,
    );
  }
});

test("inactive, quarantined, or hash-mismatched reviewed models are never selected", () => {
  const medicationHistory = [
    {
      canonicalMedicationId: "RX-RISPERIDONE",
      response: "NO_RESPONSE",
      adequateDose: true,
      adequateDuration: true,
      adequateAdherence: true,
    },
    {
      canonicalMedicationId: "RX-OLANZAPINE",
      response: "PARTIAL_RESPONSE",
      adequateDose: true,
      adequateDuration: true,
      adequateAdherence: true,
    },
  ];
  for (const clozapineModel of [undefined, { ...clozapineTrs, contentSha256: "e".repeat(64) }]) {
    assert.throws(
      () =>
        evaluateBnRouting({ ...facts, medicationHistory }, INITIAL_BN_ROUTING_ARTIFACT, [
          pharmacotherapy,
          treatmentSetting,
          ...(clozapineModel ? [clozapineModel] : []),
        ]),
      (error) => error instanceof BnRoutingError && error.code === "MISSING_ACTIVE_MODEL",
    );
  }
});

test("unapproved or incomplete structured facts fail closed", () => {
  assert.throws(
    () =>
      evaluateBnRouting(
        { ...facts, assessments: facts.assessments.slice(1) },
        INITIAL_BN_ROUTING_ARTIFACT,
        [pharmacotherapy],
      ),
    (error) => error instanceof BnRoutingError && error.code === "INVALID_ROUTING_FACTS",
  );
  assert.throws(
    () =>
      evaluateBnRouting(
        facts,
        {
          ...INITIAL_BN_ROUTING_ARTIFACT,
          rules: [
            {
              ...INITIAL_BN_ROUTING_ARTIFACT.rules[0],
              all: [{ fact: "UNSUPPORTED_CLINICAL_SEMANTIC" }],
            },
            ...INITIAL_BN_ROUTING_ARTIFACT.rules.slice(1),
          ],
        },
        [pharmacotherapy, treatmentSetting],
      ),
    (error) => error instanceof BnRoutingError && error.code === "INVALID_ROUTING_ARTIFACT",
  );
});

test("only psychiatrists can persist routing evaluations", async () => {
  let queried = false;
  const pool = {
    query: () => {
      queried = true;
    },
  };
  await assert.rejects(
    routeAndRecordBnModels(
      pool,
      { id: "administrator-1", role: "ADMINISTRATOR" },
      { researchCaseId: "case-1", researchCaseRevision: 1, facts },
    ),
    BnRoutingAuthorizationError,
  );
  assert.equal(queried, false);
});

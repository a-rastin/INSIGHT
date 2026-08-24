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

const continuingMedication = {
  modelId: "model-continuing-medication-v1",
  pathwayIdentity: "CONTINUING_MEDICATION",
  version: 1,
  contentSha256: "9527c9c7c0efdfa2caf748fb7ebceaad8715ff79b89180305ba9d0aef3e8b355",
  semanticSha256: "9".repeat(64),
  sourceReference: "gemini-code-1783421787562.xml",
};

const clozapineTrs = {
  modelId: "model-clozapine-trs-v1",
  pathwayIdentity: "CLOZAPINE_TREATMENT_RESISTANCE",
  version: 1,
  contentSha256: "faf3214184fce801690bc5438c13b1e3c18ce51f917b8bdf646c69aa0b5e5eeb",
  semanticSha256: "e".repeat(64),
  sourceReference: "gemini-code-1783422447172.xml",
};

const clozapineAggressiveBehavior = {
  modelId: "model-clozapine-aggressive-behavior-v1",
  pathwayIdentity: "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
  version: 1,
  contentSha256: "424562a955ef0def89e93f8fede10e87b7bd65b6b9e95182634baecfa1786416",
  semanticSha256: "f".repeat(64),
  sourceReference: "gemini-code-1783422744909.xml",
};

const clozapineSuicideRisk = {
  modelId: "model-clozapine-suicide-risk-v1",
  pathwayIdentity: "CLOZAPINE_SUICIDE_RISK",
  version: 1,
  contentSha256: "90f633bee7da1625ca4d44d35ace5acace5ca51ee7d597541ee7a5d0089acf3a",
  semanticSha256: "d".repeat(64),
  sourceReference: "BN-Clozapine-in-Suicide-Risk.xml",
};

test("route golden table selects only reviewed required pathway fixtures", () => {
  const golden = [
    ["FIRST_PRESENTATION", ["BN-Pharmacotherapy.xml", "BN-Treatment-Setting.xml"]],
    [
      "KNOWN_SCHIZOPHRENIA",
      ["BN-Clozapine-in-Suicide-Risk.xml", "BN-Pharmacotherapy.xml", "BN-Treatment-Setting.xml"],
    ],
    [null, "MISSING_REQUIRED_ROUTE"],
  ];
  for (const [presentationStatus, expected] of golden) {
    const run = () =>
      evaluateBnRouting({ ...facts, presentationStatus }, INITIAL_BN_ROUTING_ARTIFACT, [
        pharmacotherapy,
        treatmentSetting,
        clozapineSuicideRisk,
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
      { ...INITIAL_BN_ROUTING_ARTIFACT.rules[1], ref: "BN-ROUTE-TREATMENT-SETTING-OTHER-001" },
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

test("Treatment Setting requires reviewed completed confirmed diagnosis trigger", () => {
  for (const dsm5tr of [
    { type: "DSM5TR", state: "IN_PROGRESS" },
    { type: "DSM5TR", state: "COMPLETED", result: "SCHIZOPHRENIA_NOT_CONFIRMED" },
  ]) {
    assert.throws(
      () =>
        evaluateBnRouting(
          { ...facts, assessments: [dsm5tr, ...facts.assessments.slice(1)] },
          INITIAL_BN_ROUTING_ARTIFACT,
          [pharmacotherapy, treatmentSetting, clozapineSuicideRisk],
        ),
      (error) => error instanceof BnRoutingError && error.code === "MISSING_REQUIRED_ROUTE",
    );
  }
});

test("continuing-medication route golden vectors require pinned medication and plan revisions", () => {
  const planRevision = {
    sourcePlanRef: "plan-synthetic-v2",
    sourcePlanRevision: 2,
    targetPlanRevision: 3,
    relationship: "REVISES",
  };
  const active = [pharmacotherapy, treatmentSetting, continuingMedication, clozapineSuicideRisk];
  const route = (overrides) =>
    evaluateBnRouting({ ...facts, ...overrides }, INITIAL_BN_ROUTING_ARTIFACT, active);
  const golden = [
    [
      {
        medicationHistory: [{ canonicalMedicationId: "RX-ARIPIPRAZOLE", response: "IMPROVED" }],
        medicationPlanRevision: planRevision,
      },
      true,
    ],
    [{ medicationPlanRevision: planRevision }, false],
    [
      {
        medicationHistory: [{ canonicalMedicationId: "RX-RISPERIDONE", response: "IMPROVED" }],
        medicationPlanRevision: planRevision,
      },
      false,
    ],
    [
      {
        medicationHistory: [
          { canonicalMedicationId: "RX-ARIPIPRAZOLE", response: "PARTIAL_RESPONSE" },
        ],
        medicationPlanRevision: planRevision,
      },
      false,
    ],
    [{ medicationPlanRevision: undefined }, false],
  ];
  for (const [overrides, expected] of golden) {
    assert.equal(
      route(overrides).selectedModels.some(
        ({ pathwayIdentity }) => pathwayIdentity === "CONTINUING_MEDICATION",
      ),
      expected,
    );
  }
  assert.throws(
    () =>
      route({
        medicationHistory: [{ canonicalMedicationId: "RX-ARIPIPRAZOLE", response: "IMPROVED" }],
        medicationPlanRevision: { ...planRevision, relationship: "LLM_INFERRED_REVISION" },
      }),
    (error) => error instanceof BnRoutingError && error.code === "INVALID_ROUTING_FACTS",
  );
});

test("continuing-medication route fails closed on ambiguity and pinned hash mismatch", () => {
  const continuingFacts = {
    ...facts,
    medicationHistory: [{ canonicalMedicationId: "RX-ARIPIPRAZOLE", response: "IMPROVED" }],
    medicationPlanRevision: {
      sourcePlanRef: "plan-synthetic-v2",
      sourcePlanRevision: 2,
      targetPlanRevision: 3,
      relationship: "REVISES",
    },
  };
  const duplicateRule = INITIAL_BN_ROUTING_ARTIFACT.rules.find(
    ({ pathwayIdentity }) => pathwayIdentity === "CONTINUING_MEDICATION",
  );
  assert.throws(
    () =>
      evaluateBnRouting(
        continuingFacts,
        {
          ...INITIAL_BN_ROUTING_ARTIFACT,
          rules: [
            ...INITIAL_BN_ROUTING_ARTIFACT.rules,
            { ...duplicateRule, ref: "BN-ROUTE-CONTINUING-MEDICATION-OTHER-001" },
          ],
        },
        [pharmacotherapy, treatmentSetting, continuingMedication, clozapineSuicideRisk],
      ),
    (error) => error instanceof BnRoutingError && error.code === "AMBIGUOUS_ROUTE",
  );
  assert.throws(
    () =>
      evaluateBnRouting(continuingFacts, INITIAL_BN_ROUTING_ARTIFACT, [
        pharmacotherapy,
        treatmentSetting,
        { ...continuingMedication, contentSha256: "8".repeat(64) },
        clozapineSuicideRisk,
      ]),
    (error) => error instanceof BnRoutingError && error.code === "MISSING_ACTIVE_MODEL",
  );
});

test("clozapine suicide-risk route uses terminal source state without a risk-band gate", () => {
  const active = [pharmacotherapy, treatmentSetting, clozapineSuicideRisk];
  for (const cssrs of [
    { type: "CSSRS_RECENT", state: "COMPLETED", result: "HIGH" },
    { type: "CSSRS_RECENT", state: "BYPASSED" },
    { type: "CSSRS_RECENT", state: "IMPUTED", result: "HIGH" },
  ]) {
    const routed = evaluateBnRouting(
      { ...facts, assessments: [...facts.assessments.slice(0, 2), cssrs] },
      INITIAL_BN_ROUTING_ARTIFACT,
      active,
    );
    assert.deepEqual(routed.matchedRuleRefs, [
      "BN-ROUTE-CLOZAPINE-SUICIDE-RISK-001",
      "BN-ROUTE-PHARMACOTHERAPY-001",
      "BN-ROUTE-TREATMENT-SETTING-001",
    ]);
    assert.deepEqual(
      routed.selectedModels.map(({ pathwayIdentity }) => pathwayIdentity),
      ["CLOZAPINE_SUICIDE_RISK", "PHARMACOTHERAPY", "TREATMENT_SETTING"],
    );
  }

  for (const state of ["NOT_STARTED", "IN_PROGRESS"]) {
    const routed = evaluateBnRouting(
      {
        ...facts,
        assessments: [
          ...facts.assessments.slice(0, 2),
          { type: "CSSRS_RECENT", state, result: "HIGH" },
        ],
      },
      INITIAL_BN_ROUTING_ARTIFACT,
      active,
    );
    assert.equal(
      routed.selectedModels.some(
        ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_SUICIDE_RISK",
      ),
      false,
    );
  }
});

test("clozapine TRS route requires two distinct adequate adherent poor-response trials", () => {
  const adequateTrial = (canonicalMedicationId, response = "NO_RESPONSE") => ({
    canonicalMedicationId,
    response,
    adequateDose: true,
    adequateDuration: true,
    adequateAdherence: true,
  });
  const active = [pharmacotherapy, treatmentSetting, clozapineTrs, clozapineSuicideRisk];
  const qualifying = [
    adequateTrial("RX-RISPERIDONE"),
    adequateTrial("RX-OLANZAPINE", "PARTIAL_RESPONSE"),
  ];
  const routed = evaluateBnRouting(
    { ...facts, medicationHistory: qualifying },
    INITIAL_BN_ROUTING_ARTIFACT,
    active,
  );
  assert.equal(
    routed.selectedModels.some(
      ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_TREATMENT_RESISTANCE",
    ),
    true,
  );

  for (const medicationHistory of [
    qualifying.slice(0, 1),
    [adequateTrial("RX-RISPERIDONE"), adequateTrial("RX-RISPERIDONE")],
    [adequateTrial("RX-RISPERIDONE"), { ...adequateTrial("RX-OLANZAPINE"), adequateDose: false }],
    [adequateTrial("RX-RISPERIDONE"), adequateTrial("RX-OLANZAPINE", "GOOD_RESPONSE")],
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

test("clozapine aggressive-behavior route accepts only reviewed structured trigger vectors", () => {
  const active = [
    pharmacotherapy,
    treatmentSetting,
    clozapineAggressiveBehavior,
    clozapineSuicideRisk,
  ];
  const route = (aggressiveBehavior) =>
    evaluateBnRouting({ ...facts, aggressiveBehavior }, INITIAL_BN_ROUTING_ARTIFACT, active);

  assert.equal(
    route({ riskAfterOtherTreatments: "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS" }).selectedModels.some(
      ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
    ),
    true,
  );
  for (const riskAfterOtherTreatments of [
    "NOT_SUBSTANTIAL_OR_CONTROLLED",
    "INSUFFICIENT_OTHER_TREATMENT_OR_ADHERENCE_ASSESSMENT",
  ]) {
    assert.equal(
      route({ riskAfterOtherTreatments }).selectedModels.some(
        ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
      ),
      false,
    );
  }
  assert.equal(
    route(undefined).selectedModels.some(
      ({ pathwayIdentity }) => pathwayIdentity === "CLOZAPINE_AGGRESSIVE_BEHAVIOR",
    ),
    false,
  );
  for (const aggressiveBehavior of [
    { notes: "persistent aggression" },
    { riskAfterOtherTreatments: "LLM_INFERRED_SUBSTANTIAL" },
    {
      riskAfterOtherTreatments: "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS",
      notes: "free text must not participate",
    },
  ]) {
    assert.throws(
      () => route(aggressiveBehavior),
      (error) => error instanceof BnRoutingError && error.code === "INVALID_ROUTING_FACTS",
    );
  }
});

test("inactive, quarantined, or hash-mismatched reviewed models are never selected", () => {
  for (const clozapineModel of [
    undefined,
    { ...clozapineSuicideRisk, contentSha256: "e".repeat(64) },
  ]) {
    assert.throws(
      () =>
        evaluateBnRouting(facts, INITIAL_BN_ROUTING_ARTIFACT, [
          pharmacotherapy,
          treatmentSetting,
          ...(clozapineModel ? [clozapineModel] : []),
        ]),
      (error) => error instanceof BnRoutingError && error.code === "MISSING_ACTIVE_MODEL",
    );
  }
  const qualifying = {
    ...facts,
    medicationHistory: [
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
    ],
  };
  for (const model of [undefined, { ...clozapineTrs, contentSha256: "f".repeat(64) }]) {
    assert.throws(
      () =>
        evaluateBnRouting(qualifying, INITIAL_BN_ROUTING_ARTIFACT, [
          pharmacotherapy,
          treatmentSetting,
          clozapineSuicideRisk,
          ...(model ? [model] : []),
        ]),
      (error) => error instanceof BnRoutingError && error.code === "MISSING_ACTIVE_MODEL",
    );
  }
  for (const model of [
    undefined,
    { ...clozapineAggressiveBehavior, contentSha256: "f".repeat(64) },
  ]) {
    assert.throws(
      () =>
        evaluateBnRouting(
          {
            ...facts,
            aggressiveBehavior: {
              riskAfterOtherTreatments: "SUBSTANTIAL_DESPITE_OTHER_TREATMENTS",
            },
          },
          INITIAL_BN_ROUTING_ARTIFACT,
          [pharmacotherapy, treatmentSetting, clozapineSuicideRisk, ...(model ? [model] : [])],
        ),
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
  assert.throws(
    () =>
      evaluateBnRouting(
        {
          ...facts,
          assessments: [
            { type: "DSM5TR", state: "IMPUTED", result: "SCHIZOPHRENIA_CONFIRMED" },
            ...facts.assessments.slice(1),
          ],
        },
        INITIAL_BN_ROUTING_ARTIFACT,
        [pharmacotherapy, treatmentSetting, clozapineSuicideRisk],
      ),
    (error) => error instanceof BnRoutingError && error.code === "INVALID_ROUTING_FACTS",
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

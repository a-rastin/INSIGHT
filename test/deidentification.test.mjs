import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProjectionInput,
  createProjection,
  DeidentificationError,
  filterModelVisibleToolResult,
  GET_CONTEXT_INPUT_SCHEMA,
  MODEL_VISIBLE_PROJECTION_SCHEMA,
  OMITTED_FIELD_CLASSES,
  PROJECTION_VERSION,
} from "../.tsbuild/server/index.js";
import { isContract } from "../packages/contracts/dist/index.js";

const subjectRef = "abcdefghijklmnopqrstuvwx";

function source(overrides = {}) {
  const emptyAssessment = (assessmentType) => ({
    researchCaseId: "22222222-2222-4222-8222-222222222222",
    assessmentType,
    status: "BYPASSED",
    answers: null,
    calculation: null,
  });
  return {
    patient: {
      id: "11111111-1111-4111-8111-111111111111",
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-07",
      sex: "FEMALE",
      officialIdentifier: {
        type: "SYNTHETIC_CODE",
        issuingAuthority: "Synthetic Authority",
        value: "9988776655",
      },
      profileAge: 41,
      researchCase: {
        id: "22222222-2222-4222-8222-222222222222",
        startedAt: "2025-03-01T00:00:00.000Z",
        ageAtStart: 40,
      },
      createdAt: "2025-03-01T00:00:00.000Z",
      updatedAt: "2025-03-01T00:00:00.000Z",
    },
    dsm5tr: {
      ...emptyAssessment("DSM5TR"),
      psychiatristDecision: null,
    },
    panss: emptyAssessment("PANSS"),
    cssrs: emptyAssessment("CSSRS_RECENT"),
    medicalHistory: {
      researchCaseId: "22222222-2222-4222-8222-222222222222",
      presentationStatus: "KNOWN_SCHIZOPHRENIA",
      previouslyTreated: true,
      priorTrials: [
        {
          medication: "risperidone",
          normalizationState: "NORMALIZED",
          canonicalMedicationId: "rx-risperidone",
          response: "PARTIAL_RESPONSE",
          notes: "Excluded free text",
        },
      ],
      currentMedications: [
        {
          rawMedication: "clozapine 100 mg",
          normalizationState: "NORMALIZED",
          canonicalMedicationId: "rx-clozapine",
          dose: "100",
          doseUnit: "mg",
          route: "oral",
          frequency: "daily",
        },
      ],
      comorbidities: [
        {
          catalogVersionId: "33333333-3333-4333-8333-333333333333",
          termId: "diabetes",
          label: "Diabetes mellitus",
          supplementalText: "Excluded free text",
        },
      ],
      ruleEvaluation: {
        knowledgeVersionId: "33333333-3333-4333-8333-333333333333",
        knowledgeVersion: 2,
        results: [
          {
            knowledgeVersionId: "33333333-3333-4333-8333-333333333333",
            knowledgeVersion: 2,
            ruleId: "diabetes-monitoring",
            kind: "MONITORING_REQUIREMENT",
            targetId: "glucose",
            value: "Monitor glucose",
            explanation: "Excluded free text",
            matchedTermIds: ["diabetes"],
          },
        ],
      },
      supplementalNotes: "Excluded free text",
      revision: 1,
      createdByUserId: "44444444-4444-4444-8444-444444444444",
      updatedByUserId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2025-03-01T00:00:00.000Z",
      updatedAt: "2025-03-01T00:00:00.000Z",
    },
    availableDomainResults: new Set(["ASSESSMENT_IMPUTATION", "BN_INFERENCE", "PRIMARY_DDI"]),
    ...overrides,
  };
}

test("privacy golden: every workflow state has one exact versioned reproducible projection", () => {
  const expected = [
    ["NORMALIZING_MEDICATIONS", "MEDICATION_NORMALIZATION"],
    ["IMPUTING_BYPASSED_ASSESSMENTS", "ASSESSMENT_IMPUTATION"],
    ["GENERATING_CPTS", "CPT_GENERATION"],
    ["GENERATING_PRIMARY_PLAN", "PLAN_DRAFT"],
  ];
  for (const [state, projectionType] of expected) {
    const first = createProjection(subjectRef, state, source());
    const second = createProjection("zyxwvutsrqponmlkjihgfedc", state, source());
    assert.equal(first.projectionType, projectionType);
    assert.equal(first.projectionVersion, PROJECTION_VERSION);
    assert.equal(first.inputFingerprint, second.inputFingerprint);
    assert.equal(canonicalProjectionInput(first), canonicalProjectionInput(second));
    assert.deepEqual(
      first.omittedFieldClasses.slice(0, OMITTED_FIELD_CLASSES.length).sort(),
      [...OMITTED_FIELD_CLASSES].sort(),
    );
    assert.match(first.inputFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(isContract(MODEL_VISIBLE_PROJECTION_SCHEMA, first), true);
    assert.equal(isContract(MODEL_VISIBLE_PROJECTION_SCHEMA, { ...first, arbitrary: true }), false);
  }
});

test("model cannot choose arbitrary fields, projection, or subject reference", () => {
  assert.equal(isContract(GET_CONTEXT_INPUT_SCHEMA, {}), true);
  assert.equal(isContract(GET_CONTEXT_INPUT_SCHEMA, { projectionType: "PLAN_DRAFT" }), false);
  assert.equal(isContract(GET_CONTEXT_INPUT_SCHEMA, { fields: ["firstName"] }), false);
  assert.throws(() => createProjection(subjectRef, "RUNNING_BN", source()), DeidentificationError);
  assert.throws(
    () => createProjection("11111111-1111-4111-8111-111111111111", "GENERATING_CPTS", source()),
    DeidentificationError,
  );
});

test("adversarial identifiers in structured and free-text fields never enter projection", () => {
  const dangerous = [
    "Jane Doe",
    "9988776655",
    "11111111-1111-4111-8111-111111111111",
    "jane@example.test",
    "+1 (555) 123-4567",
    "12 Main Street",
    "1984-06-07",
    "patient id 123456",
  ];
  for (const identifier of dangerous) {
    const fixture = source();
    fixture.medicalHistory.currentMedications[0].rawMedication = `clozapine ${identifier}`;
    fixture.medicalHistory.currentMedications[0].canonicalMedicationId = identifier;
    fixture.medicalHistory.priorTrials[0].medication = identifier;
    fixture.medicalHistory.comorbidities[0].termId = identifier;
    fixture.medicalHistory.ruleEvaluation.results[0].targetId = identifier;
    fixture.medicalHistory.ruleEvaluation.results[0].value = identifier;
    fixture.medicalHistory.supplementalNotes = identifier;
    const projection = createProjection(subjectRef, "GENERATING_CPTS", fixture);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(identifier), false, identifier);
    assert.ok(projection.omittedFieldClasses.includes("UNSAFE_MEDICATION_TEXT"));
  }
});

test("property sweep rejects random identifier-shaped medication text", () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed;
  };
  for (let index = 0; index < 500; index += 1) {
    const fixture = source();
    const identifier = `${String(random()).padStart(10, "0")}@example.test`;
    fixture.medicalHistory.currentMedications[0].rawMedication = identifier;
    const projection = createProjection(subjectRef, "NORMALIZING_MEDICATIONS", fixture);
    assert.equal(JSON.stringify(projection).includes(identifier), false);
  }
});

test("tool results and errors are filtered before model visibility", () => {
  const leaked = filterModelVisibleToolResult(
    {
      ok: true,
      data: { diagnostic: "Jane Doe 9988776655" },
      provenance: {
        toolName: "unsafe.tool",
        toolVersion: "1.0.0",
        inputHash: "a".repeat(64),
        outputHash: "b".repeat(64),
        knowledgeVersions: [],
        executedAt: "2025-03-01T00:00:00.000Z",
      },
      warnings: [],
    },
    ["Jane Doe", "9988776655"],
  );
  assert.deepEqual(leaked, {
    ok: false,
    error: {
      code: "PRIVACY_FILTER_FAILED",
      retryable: false,
      safeMessage: "Tool result was blocked by the privacy filter.",
    },
  });

  const error = filterModelVisibleToolResult(
    {
      ok: false,
      error: {
        code: "INVALID_TOOL_INPUT",
        retryable: false,
        safeMessage: "Jane Doe at 12 Main Street",
      },
    },
    ["Jane Doe"],
  );
  assert.equal(JSON.stringify(error).includes("Jane"), false);
  assert.equal(Object.hasOwn(error.error, "diagnostics"), false);
});

import { expect, test } from "@playwright/test";

const patientId = "20000000-0000-4000-8000-000000000009";
const researchCaseId = "30000000-0000-4000-8000-000000000009";
const userId = "10000000-0000-4000-8000-000000000002";
const adverseVersionId = "40000000-0000-4000-8000-000000000009";
const knowledgeVersionId = "50000000-0000-4000-8000-000000000009";

test("first-presentation medical history persists at narrow width", async ({ page }) => {
  const state = await installMedicalHistoryApi(page, null);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/patients/${patientId}`);

  const firstPresentation = page.getByLabel("First presentation");
  await firstPresentation.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("group", { name: /Previously treated/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Add current medicine" }).click();
  await page.getByLabel("Medication (required)").fill("Metformin");
  await page.getByRole("button", { name: "Save medical history" }).press("Enter");
  await expect(page.getByText("Medical history saved.")).toBeVisible();
  expect(state.history.presentationStatus).toBe("FIRST_PRESENTATION");
  expect(state.history).not.toHaveProperty("previouslyTreated");
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.reload();
  await expect(page.getByLabel("First presentation")).toBeChecked();
  await expect(page.getByLabel("Medication (required)")).toHaveValue("Metformin");
});

test("known-treated medical history supports keyboard trial editing and sourced cautions", async ({
  page,
}) => {
  const state = await installMedicalHistoryApi(page, null);
  await page.goto(`/patients/${patientId}`);

  await page.getByLabel("Known schizophrenia").focus();
  await page.keyboard.press("Space");
  await page.getByRole("radio", { name: "Yes", exact: true }).focus();
  await page.keyboard.press("Space");
  const medication = page.getByLabel("Medication (required)");
  await medication.focus();
  await page.keyboard.type("Clozapine");
  const response = page.getByLabel("Response (optional)");
  await response.focus();
  await page.keyboard.press("ArrowDown");
  await expect(response).toHaveValue("FULL_RESPONSE");
  await page.getByText("Other", { exact: true }).click();
  await expect(page.getByLabel("OTHER detail (optional)")).toBeVisible();
  await page.getByText("Diabetes", { exact: true }).click();
  await page.getByRole("button", { name: "Save medical history" }).click();

  await expect(page.getByText("CAUTION", { exact: true })).toBeVisible();
  await expect(page.getByText(/knowledge version 1; rule DIABETES_CAUTION/)).toBeVisible();
  expect(state.history.priorTrials[0]).toMatchObject({
    medication: "Clozapine",
    response: "FULL_RESPONSE",
  });
  expect(state.history.priorTrials[0]).not.toHaveProperty("otherAdverseEffectDetail");

  await page.reload();
  await expect(page.getByLabel("Known schizophrenia")).toBeChecked();
  await expect(page.getByRole("radio", { name: "Yes", exact: true })).toBeChecked();
  await expect(page.getByLabel("Medication (required)")).toHaveValue("Clozapine");
});

test("known-untreated persisted choice keeps prior trials absent", async ({ page }) => {
  const initial = historyRecord({
    presentationStatus: "KNOWN_SCHIZOPHRENIA",
    previouslyTreated: false,
    priorTrials: [],
  });
  const state = await installMedicalHistoryApi(page, initial);
  await page.goto(`/patients/${patientId}`);

  await expect(page.getByLabel("Known schizophrenia")).toBeChecked();
  await expect(page.getByRole("radio", { name: "No", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Prior antipsychotic trials" })).toHaveCount(0);
  await expect(page.getByText("Ready to save.")).toBeVisible();
  await page.getByRole("button", { name: "Save medical history" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Medical history saved.")).toBeVisible();
  expect(state.history).toMatchObject({
    presentationStatus: "KNOWN_SCHIZOPHRENIA",
    previouslyTreated: false,
  });
  expect(state.lastInput).not.toHaveProperty("priorTrials");
});

test("normalization progress survives refresh and resumes without candidate confirmation", async ({
  page,
}) => {
  const initial = historyRecord({
    currentMedications: [{ rawMedication: "Haldol", normalizationState: undefined }],
  });
  const state = await installMedicalHistoryApi(page, initial);
  state.workflowState = "NORMALIZING_MEDICATIONS";
  state.normalizationJob = job("RUNNING");
  await page.goto(`/patients/${patientId}`);

  await expect(
    page.getByText("Canonical identities are being selected and committed automatically."),
  ).toBeVisible();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(page.getByText(/candidate/i)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();

  state.history = historyRecord({
    currentMedications: [
      {
        rawMedication: "Haldol",
        normalizationState: "NORMALIZED",
        canonicalMedicationId: "RX-HALOPERIDOL",
      },
    ],
  });
  state.normalizationJob = job("SUCCEEDED");
  await expect(page.getByText("Canonical identity: RX-HALOPERIDOL")).toBeVisible({ timeout: 3000 });
  await expect(page.getByText("SUCCEEDED", { exact: true })).toBeVisible();
});

async function installMedicalHistoryApi(page, initialHistory) {
  const state = {
    history: initialHistory,
    lastInput: null,
    workflowRevision: 1,
    workflowState: "DATA_COLLECTION",
    normalizationJob: null,
  };
  await page.addInitScript(
    ({ id }) => globalThis.localStorage.setItem(`insight.research-use.${id}.v1`, "acknowledged"),
    { id: userId },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/session") {
      await route.fulfill({ json: session() });
      return;
    }
    if (path === `/api/v1/patients/${patientId}`) {
      await route.fulfill({ json: { schemaVersion: "1", patient: patient() } });
      return;
    }
    if (path === `/api/v1/patients/${patientId}/research-case`) {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          researchCase: { revision: state.workflowRevision, state: state.workflowState },
        },
      });
      return;
    }
    if (path.endsWith("/medication-normalization")) {
      if (request.method() === "POST") state.normalizationJob = job("QUEUED");
      await route.fulfill({
        status: request.method() === "POST" ? 202 : 200,
        json: { schemaVersion: "1", job: state.normalizationJob },
      });
      return;
    }
    if (path === `/api/v1/jobs/${state.normalizationJob?.id}`) {
      await route.fulfill({ json: { schemaVersion: "1", job: state.normalizationJob } });
      return;
    }
    if (path.endsWith("/medical-history")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        state.workflowRevision += 1;
        state.lastInput = body.history;
        state.history = historyRecord({
          ...body.history,
          priorTrials: body.history.priorTrials?.map((trial) => ({
            ...trial,
            adverseEffects: trial.adverseEffects?.map((effect) => ({
              ...effect,
              label: effect.termId === "OTHER" ? "Other" : effect.termId,
            })),
          })),
          ruleEvaluation: body.history.comorbidities.length
            ? {
                knowledgeVersionId,
                knowledgeVersion: 1,
                results: [
                  {
                    knowledgeVersionId,
                    knowledgeVersion: 1,
                    ruleId: "DIABETES_CAUTION",
                    kind: "CAUTION",
                    targetId: "METABOLIC_MONITORING",
                    value: "Review",
                    explanation: "Review metabolic monitoring needs.",
                    matchedTermIds: ["DIABETES"],
                  },
                ],
              }
            : null,
        });
      }
      await route.fulfill({ json: { schemaVersion: "1", medicalHistory: state.history } });
      return;
    }
    if (path === "/api/v1/adverse-effect-catalog") {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          catalog: {
            id: adverseVersionId,
            version: 1,
            terms: [
              { termId: "AKATHISIA", label: "Akathisia" },
              { termId: "OTHER", label: "Other" },
            ],
            createdByUserId: userId,
            createdAt: "2026-08-22T10:00:00.000Z",
            active: true,
          },
        },
      });
      return;
    }
    if (path === "/api/v1/comorbidity-knowledge") {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          knowledge: {
            id: knowledgeVersionId,
            version: 1,
            sourceReference: "Governed source",
            reviewerRecord: {
              reviewerId: "reviewer",
              reviewedAt: "2026-08-22T10:00:00.000Z",
              recordReference: "review-1",
            },
            terms: [{ termId: "DIABETES", label: "Diabetes" }],
            rules: [],
            createdByUserId: userId,
            createdAt: "2026-08-22T10:00:00.000Z",
            active: true,
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { schemaVersion: "1", error: {} } });
  });
  return state;
}

function job(status) {
  return {
    id: "60000000-0000-4000-8000-000000000009",
    jobType: "MEDICATION_NORMALIZATION",
    researchCaseId,
    status,
    attemptCount: 1,
    maxAttempts: 3,
    resultReference: status === "SUCCEEDED" ? "domain-result:normalized" : null,
    provenanceReference: status === "SUCCEEDED" ? "model-execution:normalized" : null,
    error: null,
    createdAt: "2026-08-22T10:00:00.000Z",
    startedAt: "2026-08-22T10:00:01.000Z",
    completedAt: status === "SUCCEEDED" ? "2026-08-22T10:00:02.000Z" : null,
    updatedAt: "2026-08-22T10:00:02.000Z",
  };
}

function historyRecord(overrides) {
  return {
    presentationStatus: "FIRST_PRESENTATION",
    currentMedications: [],
    comorbidities: [],
    ruleEvaluation: null,
    researchCaseId,
    revision: 1,
    createdByUserId: userId,
    updatedByUserId: userId,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function session() {
  return {
    schemaVersion: "1",
    user: { id: userId, username: "psychiatrist", role: "PSYCHIATRIST", status: "ENABLED" },
    csrfToken: "csrf-token",
    expiresAt: "2026-08-22T12:00:00.000Z",
  };
}

function patient() {
  return {
    id: patientId,
    officialIdentifier: {
      type: "RESEARCH_ID",
      issuingAuthority: "INSIGHT_TEST",
      value: "SYNTHETIC-000009",
    },
    firstName: "Synthetic",
    lastName: "History",
    dateOfBirth: "1990-08-22",
    sex: "FEMALE",
    profileAge: 36,
    researchCase: { id: researchCaseId, startedAt: "2026-08-22T10:00:00.000Z", ageAtStart: 36 },
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
  };
}

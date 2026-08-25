import { expect, test } from "@playwright/test";

const patientId = "20000000-0000-4000-8000-000000000039";
const researchCaseId = "30000000-0000-4000-8000-000000000039";
const userId = "10000000-0000-4000-8000-000000000039";

for (const scenario of [
  { name: "successful", status: "SUCCEEDED", heading: "Ready for psychiatrist review" },
  {
    name: "bypassed",
    status: "SUCCEEDED",
    heading: "Ready for psychiatrist review",
    imputed: true,
  },
  { name: "failure", status: "FAILED", heading: "Primary plan generation failed" },
  {
    name: "final DDI warning",
    status: "SUCCEEDED",
    heading: "Final regimen DDI recheck complete",
    readiness: "READY",
  },
  {
    name: "final DDI failure",
    status: "SUCCEEDED",
    heading: "Finalization blocked",
    readiness: "BLOCKED",
  },
]) {
  test(`Primary Treatment Plan ${scenario.name} state`, async ({ page }) => {
    await installApi(page, planState(scenario));
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`/patients/${patientId}`);

    await expect(page.getByRole("heading", { name: scenario.heading })).toBeVisible();
    if (scenario.status === "SUCCEEDED") {
      await expect(page.getByRole("heading", { name: "rx-synthetic-e2e" })).toBeVisible();
      await expect(page.getByText(/Psychiatrist must review every field/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Authorized pathway result" })).toHaveAttribute(
        "href",
        "#primary-plan-source-0",
      );
      await expect(page.locator("#primary-plan-source-0")).toBeVisible();
      await expect(
        page.getByText(/unknown medication|interaction coverage is incomplete/i),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(360);
    }
    if (scenario.imputed) {
      await expect(page.getByText(/AI imputation was used/)).toHaveCount(1);
      await expect(page.getByText(/imputed answer|imputed score|high risk/i)).toHaveCount(0);
    }
    if (scenario.status === "FAILED") {
      await expect(
        page.getByRole("heading", { name: "Ready for psychiatrist review" }),
      ).toHaveCount(0);
    }
  });
}

test("Final Treatment Plan history prints immutable structured snapshots", async ({ page }) => {
  await installApi(page, planState({ status: "SUCCEEDED" }), {
    finalPlans: [finalPlan(2, "ACTIVE", "final-plan-v1"), finalPlan(1, "SUPERSEDED", null)],
  });
  await page.goto(`/patients/${patientId}`);

  await expect(page.getByRole("heading", { name: "Final Treatment Plan history" })).toBeVisible();
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  await expect(page.getByText("SUPERSEDED", { exact: true })).toBeVisible();
  await expect(page.getByText("S******* P*****", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("2 mg", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Export SHA-256/).first()).toBeVisible();
  await expect(page.getByText(/AI imputation|UNKNOWN|must stay hidden/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /revision|save|finalize/i })).toHaveCount(0);

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Plan States" })).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Exact structured regimen" }).first(),
  ).toBeVisible();
  await expect(page.locator(".final-plan__provenance pre").first()).toContainText("bn-safe");
  expect((await page.pdf()).byteLength).toBeGreaterThan(10_000);
});

function planState({ status, imputed = false, readiness }) {
  return {
    schemaVersion: "1",
    status,
    progress: null,
    failure:
      status === "FAILED"
        ? { code: "DEPENDENCY_FAILED", message: "Required dependency failed." }
        : null,
    draft:
      status === "SUCCEEDED"
        ? {
            draftRef: "primary-plan-draft-e2e",
            draftRevision: 1,
            aiImputationNoticeVisible: imputed,
            regimen: [
              {
                canonicalMedicationId: "rx-synthetic-e2e",
                dose: { value: 2, unit: "mg" },
                route: "oral",
                frequency: "once daily",
                titration: "Reassess before any change.",
                monitoring: ["Review tolerability."],
                rationale: [
                  {
                    kind: "BN_INFERENCE",
                    sourceRef: "bn-e2e",
                    text: "Accepted output supports this item.",
                  },
                ],
                warningRefs: [],
              },
            ],
            generalMonitoring: ["Review response."],
            explanation: "Structured research draft.",
            baseline: { draftRef: "primary-plan-draft-e2e", revision: 1, changedFields: [] },
            provenance: {
              schemaVersion: "1.0.0",
              modelExecutionRef: "model-e2e",
              primaryDdiExecutionRef: "ddi-e2e",
              generatedAt: "2026-08-24T12:00:00.000Z",
            },
            authorizedSources: [
              {
                sourceRef: "bn-e2e",
                label: "Authorized pathway result",
                category: "BN_INFERENCE",
                summary: "Accepted Research Case record.",
              },
            ],
            ...(readiness
              ? {
                  readiness:
                    readiness === "READY"
                      ? {
                          status: "READY",
                          reason: null,
                          executionRef: "ddi-final-e2e",
                          findings: [
                            {
                              leftCanonicalId: "rx-synthetic-e2e",
                              rightCanonicalId: "rx-current-e2e",
                              severity: "contraindicated",
                            },
                          ],
                        }
                      : {
                          status: "BLOCKED",
                          reason: "FAILED",
                          executionRef: null,
                          findings: [],
                        },
                }
              : {}),
          }
        : null,
  };
}

async function installApi(page, plan, finalPlanOptions = { finalPlans: [] }) {
  await page.addInitScript(
    ({ id }) => globalThis.localStorage.setItem(`insight.research-use.${id}.v1`, "acknowledged"),
    { id: userId },
  );
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/session") return route.fulfill({ json: session() });
    if (path === `/api/v1/patients/${patientId}`) {
      return route.fulfill({ json: { schemaVersion: "1", patient: patient() } });
    }
    if (path === `/api/v1/patients/${patientId}/research-case/primary-plan`) {
      return route.fulfill({ json: plan });
    }
    if (path === `/api/v1/patients/${patientId}/research-case/final-plans`) {
      return route.fulfill({
        json: { schemaVersion: "1", finalPlans: finalPlanOptions.finalPlans },
      });
    }
    return route.fulfill({ status: 404, json: { schemaVersion: "1", error: {} } });
  });
}

function finalPlan(sequence, status, predecessorId) {
  return {
    id: `final-plan-v${sequence}`,
    researchCaseId,
    sequence,
    status,
    predecessorId,
    schemaVersion: "1.0.0",
    plan: {
      schemaVersion: "1.0.0",
      subject: {
        maskedName: "S******* P*****",
        identifier: {
          type: "SYNTHETIC",
          issuingAuthority: "E2E",
          maskedValue: "*****-E2E",
        },
        ageAtResearchCaseStart: 36,
        sex: "FEMALE",
        researchCaseStartedAt: "2026-08-24T10:00:00.000Z",
      },
      generatedPlan: {
        generalMonitoring: ["Review response."],
        explanation: "Immutable generated explanation.",
      },
      finalRegimen: [
        {
          canonicalMedicationId: "rx-synthetic-e2e",
          dose: { value: 2, unit: "mg" },
          route: "oral",
          frequency: "once daily",
          monitoring: ["Review tolerability."],
        },
      ],
    },
    planHash: "a".repeat(64),
    sourceDraftRef: "primary-plan-draft-e2e",
    sourceDraftRevision: sequence,
    finalDdiExecutionRef: `ddi-final-${sequence}`,
    provenance: {
      domainResults: [
        { result_type: "BN_INFERENCE", result_reference: "bn-safe" },
        { result_type: "ASSESSMENT_IMPUTATION", details: "must stay hidden" },
      ],
    },
    finalizedByUserId: userId,
    finalizedAt: `2026-08-2${sequence}T12:00:00.000Z`,
    idempotencyKey: `final-${sequence}`,
    exportArtifact: {
      id: `export-artifact-${sequence}`,
      mediaType: "application/json",
      byteLength: 1024,
      contentHash: "b".repeat(64),
      schemaVersion: "1",
      createdAt: `2026-08-2${sequence}T12:00:01.000Z`,
    },
  };
}

function patient() {
  return {
    id: patientId,
    officialIdentifier: { type: "SYNTHETIC", issuingAuthority: "E2E", value: "PLAN-E2E" },
    firstName: "Plan",
    lastName: "States",
    dateOfBirth: "1990-01-01",
    sex: "FEMALE",
    profileAge: 36,
    researchCase: { id: researchCaseId, startedAt: "2026-08-24T10:00:00.000Z", ageAtStart: 36 },
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
}

function session() {
  return {
    schemaVersion: "1",
    user: { id: userId, username: "psychiatrist", role: "PSYCHIATRIST", status: "ENABLED" },
    csrfToken: "csrf-token",
    expiresAt: "2026-08-24T14:00:00.000Z",
  };
}

import { expect, test } from "@playwright/test";

const patientId = "20000000-0000-4000-8000-000000000038";
const researchCaseId = "30000000-0000-4000-8000-000000000038";
const userId = "10000000-0000-4000-8000-000000000038";

for (const scenario of [
  { name: "none", status: "SUCCEEDED", text: "No interactions were found in evaluated pairs." },
  { name: "finding", status: "SUCCEEDED", text: "contraindicated warning", finding: true },
  {
    name: "unknown",
    status: "SUCCEEDED",
    text: "Interaction coverage is incomplete",
    unknown: true,
  },
  { name: "failure", status: "FAILED", text: "DDI check failed" },
  { name: "stale", status: "STALE", text: "DDI result is stale", final: true },
]) {
  test(`DDI ${scenario.name} state is explicit`, async ({ page }) => {
    const state = await installApi(page, ddiState(scenario));
    await page.goto(`/patients/${patientId}`);
    await expect(page.getByText(scenario.text, { exact: false }).first()).toBeVisible();

    if (scenario.finding) {
      await expect(page.locator(".ddi-finding-icon")).toHaveText("!");
      await expect(page.getByText(/Findings remain warnings only/)).toBeVisible();
    }
    if (scenario.unknown) {
      await expect(page.getByText(/coverage is incomplete/i)).toHaveCount(1);
      await expect(page.getByText(/sensitive-medication-entry|omitted pair/i)).toHaveCount(0);
    }
    if (scenario.final) {
      await expect(page.getByRole("heading", { name: "Final-regimen recheck" })).toBeVisible();
    }
    if (scenario.status === "FAILED" || scenario.status === "STALE") {
      await expect(page.getByText(/Next workflow state is blocked/)).toBeVisible();
      await page.getByRole("button", { name: "Rerun DDI check" }).click();
      await expect(page.getByRole("heading", { name: "DDI check queued" })).toBeVisible();
      expect(state.reruns).toBe(1);
    }
  });
}

test("DDI progress resumes after browser refresh", async ({ page }) => {
  const state = await installApi(page, ddiState({ status: "RUNNING" }));
  await page.goto(`/patients/${patientId}`);
  await expect(page.getByRole("heading", { name: "DDI check in progress" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "DDI check progress" })).toHaveAttribute(
    "value",
    "1",
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: "DDI check in progress" })).toBeVisible();
  state.ddi = ddiState({ status: "SUCCEEDED" });
  await expect(page.getByRole("heading", { name: "DDI check completed" })).toBeVisible({
    timeout: 3000,
  });
});

function ddiState({ status, finding = false, unknown = false, final = false }) {
  const succeeded = status === "SUCCEEDED" || status === "STALE";
  return {
    schemaVersion: "1",
    status,
    mode: final ? "FINAL_RECHECK" : "PRIMARY_FILTER",
    canRerun: ["NOT_STARTED", "FAILED", "STALE"].includes(status),
    progress:
      status === "RUNNING" ? { code: "EVALUATING_PAIRS", completedUnits: 1, totalUnits: 2 } : null,
    failure:
      status === "FAILED"
        ? { code: "DEPENDENCY_UNAVAILABLE", message: "Required DDI source is unavailable." }
        : null,
    execution: succeeded
      ? {
          executionRef: "ddi-execution-e2e",
          sourceVersion: "ddi-source-set-e2e",
          exactRegimen: unknown
            ? [
                {
                  medicationEntryRef: "sensitive-medication-entry",
                  kind: "CURRENT",
                  normalizationState: "UNKNOWN",
                },
              ]
            : [
                {
                  medicationEntryRef: "current-1",
                  kind: "CURRENT",
                  normalizationState: "NORMALIZED",
                  canonicalId: "DRUG-A",
                },
                {
                  medicationEntryRef: "current-2",
                  kind: "CURRENT",
                  normalizationState: "NORMALIZED",
                  canonicalId: "DRUG-B",
                },
              ],
          findings: finding
            ? [
                {
                  leftCanonicalId: "DRUG-A",
                  rightCanonicalId: "DRUG-B",
                  severity: "contraindicated",
                  mechanism: "CYP inhibition",
                  clinicalEffect: "Increased exposure",
                  recommendedAction: "Monitor closely",
                  sourceRecordRef: "ddi-record-e2e-L42",
                },
              ]
            : [],
          hasUnknownMedication: unknown,
          executedAt: "2026-08-23T12:00:00.000Z",
        }
      : null,
  };
}

async function installApi(page, initialDdi) {
  const state = { ddi: initialDdi, reruns: 0 };
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
    if (path === `/api/v1/patients/${patientId}/research-case/ddi`) {
      if (request.method() === "POST") {
        state.reruns += 1;
        state.ddi = ddiState({ status: "QUEUED" });
      }
      await route.fulfill({ status: request.method() === "POST" ? 202 : 200, json: state.ddi });
      return;
    }
    await route.fulfill({ status: 404, json: { schemaVersion: "1", error: {} } });
  });
  return state;
}

function patient() {
  return {
    id: patientId,
    officialIdentifier: { type: "SYNTHETIC", issuingAuthority: "E2E", value: "DDI-E2E" },
    firstName: "Ddi",
    lastName: "States",
    dateOfBirth: "1990-01-01",
    sex: "FEMALE",
    profileAge: 36,
    researchCase: { id: researchCaseId, startedAt: "2026-08-23T10:00:00.000Z", ageAtStart: 36 },
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
  };
}

function session() {
  return {
    schemaVersion: "1",
    user: { id: userId, username: "psychiatrist", role: "PSYCHIATRIST", status: "ENABLED" },
    csrfToken: "csrf-token",
    expiresAt: "2026-08-23T14:00:00.000Z",
  };
}

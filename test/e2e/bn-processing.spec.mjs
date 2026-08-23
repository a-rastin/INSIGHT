import { expect, test } from "@playwright/test";

const patientId = "20000000-0000-4000-8000-000000000044";
const researchCaseId = "30000000-0000-4000-8000-000000000044";
const userId = "10000000-0000-4000-8000-000000000044";

for (const scenario of [
  { name: "valid", status: "SUCCEEDED", text: "LLM-generated patient-specific research values" },
  { name: "invalid", status: "FAILED", text: "Bayesian processing failed (CPT_GENERATION_FAILED)" },
  { name: "stale", status: "STALE", text: "Bayesian snapshot is stale" },
]) {
  test(`Bayesian ${scenario.name} state is explicit`, async ({ page }) => {
    const state = await installApi(page, bnState(scenario.status));
    await page.goto(`/patients/${patientId}`);
    await expect(page.getByText(scenario.text, { exact: false }).first()).toBeVisible();

    if (scenario.status === "SUCCEEDED") {
      await expect(page.getByText("sha256-model-e2e")).toBeVisible();
      await expect(page.getByText(/does not establish Bayesian calibration/i)).toBeVisible();
      await expect(page.getByText("0.62 research score")).toBeVisible();
      await expect(page.getByText(/chain-of-thought-payload|patient-internal-id/i)).toHaveCount(0);
    } else {
      await expect(
        page.getByText(/progression is blocked|progression remains blocked/i).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Rerun Bayesian processing" }).click();
      await expect(page.getByRole("heading", { name: "Bayesian processing queued" })).toBeVisible();
      expect(state.reruns).toBe(1);
    }
  });
}

test("Bayesian job progress survives refresh", async ({ page }) => {
  const state = await installApi(page, bnState("RUNNING"));
  await page.goto(`/patients/${patientId}`);
  await expect(
    page.getByRole("heading", { name: "Bayesian processing in progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Bayesian processing progress" }),
  ).toHaveAttribute("value", "2");

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Bayesian processing in progress" }),
  ).toBeVisible();
  state.bn = bnState("SUCCEEDED");
  await expect(
    page.getByRole("heading", { name: "LLM-generated patient-specific research values" }),
  ).toBeVisible({ timeout: 3000 });
});

function bnState(status) {
  const hasSnapshot = status === "SUCCEEDED" || status === "STALE";
  return {
    schemaVersion: "1",
    status,
    canRerun: ["NOT_STARTED", "FAILED", "STALE"].includes(status),
    route: {
      status: "ACTIVE",
      routingVersion: "bn-routing-1.0.0",
      matchedRules: ["Initial pharmacotherapy"],
      pathways: [
        {
          pathway: "Pharmacotherapy",
          modelVersion: "7",
          modelHash: "sha256-model-e2e",
          source: { label: "Governed pharmacotherapy XMLBIF", version: "2026.08" },
          evidenceStatus: "DOCUMENTED",
          calibrationStatus: "NOT_DOCUMENTED",
          clinicalReviewStatus: "PENDING",
        },
      ],
    },
    progress:
      status === "RUNNING" ? { code: "VALIDATING_CPTS", completedUnits: 2, totalUnits: 4 } : null,
    failure:
      status === "FAILED"
        ? {
            code: "CPT_GENERATION_FAILED",
            message: "Generated CPTs remained invalid after three attempts.",
            retryable: true,
          }
        : null,
    snapshot: hasSnapshot
      ? {
          snapshotHash: "sha256-snapshot-e2e",
          promptVersion: "cpt-prompt-1.0.0",
          schemaVersion: "cpt-schema-1.0.0",
          generatedAt: "2026-08-24T10:00:00.000Z",
          validationStatus: "MATHEMATICALLY_VALID",
          outputs: [
            {
              label: "Candidate A suitability",
              value: "0.62 research score",
              evidence: ["Model source section 4"],
            },
          ],
        }
      : null,
  };
}

async function installApi(page, initialBn) {
  const state = { bn: initialBn, reruns: 0 };
  await page.addInitScript(
    ({ id }) => globalThis.localStorage.setItem(`insight.research-use.${id}.v1`, "acknowledged"),
    { id: userId },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/session") return route.fulfill({ json: session() });
    if (path === `/api/v1/patients/${patientId}`) {
      return route.fulfill({ json: { schemaVersion: "1", patient: patient() } });
    }
    if (path === `/api/v1/patients/${patientId}/research-case/bn-processing`) {
      if (request.method() === "POST") {
        state.reruns += 1;
        state.bn = bnState("QUEUED");
      }
      return route.fulfill({ status: request.method() === "POST" ? 202 : 200, json: state.bn });
    }
    return route.fulfill({ status: 404, json: { schemaVersion: "1", error: {} } });
  });
  return state;
}

function patient() {
  return {
    id: patientId,
    officialIdentifier: { type: "SYNTHETIC", issuingAuthority: "E2E", value: "BN-E2E" },
    firstName: "Bayesian",
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

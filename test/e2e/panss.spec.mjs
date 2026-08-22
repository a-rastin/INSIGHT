import { expect, test } from "@playwright/test";

import {
  DSM5TR_DEFINITION,
  DSM5TR_INSTRUMENT_PIN,
  PANSS_DEFINITION,
  PANSS_INSTRUMENT_PIN,
  calculatePanss,
} from "../../packages/contracts/dist/index.js";

test("Psychiatrist completes PANSS with keyboard and sees totals only when complete", async ({
  page,
}) => {
  const patientId = "20000000-0000-4000-8000-000000000001";
  const researchCaseId = "30000000-0000-4000-8000-000000000001";
  const userId = "10000000-0000-4000-8000-000000000002";
  const writes = [];
  const patient = {
    id: patientId,
    officialIdentifier: {
      type: "RESEARCH_ID",
      issuingAuthority: "INSIGHT_TEST",
      value: "SYNTHETIC-000001",
    },
    firstName: "Synthetic",
    lastName: "Panss",
    dateOfBirth: "1990-08-22",
    sex: "FEMALE",
    profileAge: 36,
    researchCase: {
      id: researchCaseId,
      startedAt: "2026-08-22T10:00:00.000Z",
      ageAtStart: 36,
    },
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
  };

  await page.addInitScript(
    ({ id }) => globalThis.localStorage.setItem(`insight.research-use.${id}.v1`, "acknowledged"),
    { id: userId },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/session") {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          user: {
            id: userId,
            username: "psychiatrist",
            role: "PSYCHIATRIST",
            status: "ENABLED",
          },
          csrfToken: "csrf-token",
          expiresAt: "2026-08-22T12:00:00.000Z",
        },
      });
      return;
    }
    if (url.pathname === `/api/v1/patients/${patientId}`) {
      await route.fulfill({ json: { schemaVersion: "1", patient } });
      return;
    }
    if (url.pathname.endsWith("/research-case")) {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          researchCase: {
            id: researchCaseId,
            state: "DATA_COLLECTION",
            revision: 1,
            inputRevision: 1,
            currentStep: { ordinal: 1, label: "Data collection" },
            allowedCommands: [],
            modelAllowedTools: [],
            lastInputInvalidation: null,
          },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/dsm5tr")) {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          definition: DSM5TR_DEFINITION,
          assessment: emptyAssessment(DSM5TR_INSTRUMENT_PIN),
        },
      });
      return;
    }
    if (url.pathname.endsWith("/panss") && request.method() === "GET") {
      await route.fulfill({
        json: {
          schemaVersion: "1",
          definition: PANSS_DEFINITION,
          assessment: emptyAssessment(PANSS_INSTRUMENT_PIN),
        },
      });
      return;
    }
    if (url.pathname.endsWith("/panss") && request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push(body);
      await route.fulfill({
        json: {
          schemaVersion: "1",
          definition: PANSS_DEFINITION,
          assessment: {
            ...emptyAssessment(PANSS_INSTRUMENT_PIN),
            status:
              body.mode === "BYPASS"
                ? "BYPASSED"
                : body.mode === "COMPLETE"
                  ? "COMPLETED"
                  : "IN_PROGRESS",
            answers: body.mode === "BYPASS" ? null : body.answers,
            calculation: body.mode === "BYPASS" ? null : calculatePanss(body.answers),
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto(`/patients/${patientId}`);
  await expect(page.getByRole("heading", { name: PANSS_DEFINITION.title })).toBeVisible();
  await expect(page.getByText("Incomplete: 0 of 30 items rated")).toBeVisible();
  await expect(page.getByText("Total", { exact: true })).toHaveCount(0);

  for (const item of PANSS_DEFINITION.items) {
    const input = page.getByLabel(`${item.id} ${item.text}`);
    await input.focus();
    await page.keyboard.press("ArrowDown");
  }
  await expect(page.getByText("Total", { exact: true })).toBeVisible();
  await expect(page.getByText("30", { exact: true })).toBeVisible();

  const complete = page.getByRole("button", { name: "Complete PANSS assessment" });
  await complete.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => writes.some(({ mode }) => mode === "COMPLETE")).toBe(true);
});

function emptyAssessment(instrumentPin) {
  return {
    researchCaseId: "30000000-0000-4000-8000-000000000001",
    status: "NOT_STARTED",
    answers: null,
    calculation: null,
    psychiatristDecision: null,
    instrumentPin,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: null,
    updatedAt: null,
  };
}

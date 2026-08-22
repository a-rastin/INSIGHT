import { expect, test } from "@playwright/test";

import {
  CSSRS_ACTIVATION_GATE,
  CSSRS_DEFINITION,
  CSSRS_INSTRUMENT_PIN,
  DSM5TR_DEFINITION,
  DSM5TR_INSTRUMENT_PIN,
  PANSS_DEFINITION,
  PANSS_INSTRUMENT_PIN,
  calculateCssrs,
  calculateDsm5tr,
  calculatePanss,
} from "../../packages/contracts/dist/index.js";

test("three assessments resume autosave after refresh and keep bypass explicit", async ({
  page,
}) => {
  const patientId = "20000000-0000-4000-8000-000000000003";
  const researchCaseId = "30000000-0000-4000-8000-000000000003";
  const userId = "10000000-0000-4000-8000-000000000002";
  const states = {
    dsm5tr: assessment("DSM5TR", DSM5TR_INSTRUMENT_PIN, { psychiatristDecision: "UNDECIDED" }),
    panss: assessment("PANSS", PANSS_INSTRUMENT_PIN),
    "cssrs-recent": assessment("CSSRS_RECENT", CSSRS_INSTRUMENT_PIN, {
      activationGate: CSSRS_ACTIVATION_GATE,
    }),
  };

  await page.addInitScript(
    ({ id }) => globalThis.localStorage.setItem(`insight.research-use.${id}.v1`, "acknowledged"),
    { id: userId },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/session") {
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
    if (path === `/api/v1/patients/${patientId}`) {
      await route.fulfill({
        json: { schemaVersion: "1", patient: patient(patientId, researchCaseId) },
      });
      return;
    }
    if (path.endsWith("/research-case")) {
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

    const key = Object.keys(states).find((candidate) => path.endsWith(`/${candidate}`));
    if (!key) {
      await route.fulfill({ status: 404 });
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      states[key] = savedState(states[key], key, body);
    }
    await route.fulfill({
      json: {
        schemaVersion: "1",
        definition:
          key === "dsm5tr"
            ? DSM5TR_DEFINITION
            : key === "panss"
              ? PANSS_DEFINITION
              : CSSRS_DEFINITION,
        assessment: states[key],
      },
    });
  });

  await page.goto(`/patients/${patientId}`);
  await page.getByRole("group", { name: "Delusions" }).getByLabel("Yes").check();
  await page.getByLabel("P1 Delusions").selectOption("7");
  await page
    .getByRole("group", { name: /2\. Have you actually had/ })
    .getByLabel("Yes")
    .check();
  await page
    .getByRole("group", { name: /4\. Have you had these thoughts/ })
    .getByLabel("Yes")
    .check();
  await expect.poll(() => states.dsm5tr.answers?.criterionA.delusions).toBe(true);
  await expect.poll(() => states.panss.answers?.P1).toBe(7);
  await expect.poll(() => states["cssrs-recent"].answers?.q4Intent).toBe(true);

  await page.reload();
  await expect(page.getByRole("group", { name: "Delusions" }).getByLabel("Yes")).toBeChecked();
  await expect(page.getByLabel("P1 Delusions")).toHaveValue("7");
  await expect(
    page.getByRole("group", { name: /4\. Have you had these thoughts/ }).getByLabel("Yes"),
  ).toBeChecked();

  await page.getByRole("button", { name: "Bypass assessment", exact: true }).click();
  await page.getByRole("button", { name: "Bypass PANSS assessment" }).click();
  await page.getByRole("button", { name: "Bypass C-SSRS screen" }).click();
  await expect(page.getByText("Bypassed: no result")).toHaveCount(2);
  await expect(page.getByText("Bypassed: no score")).toBeVisible();
  await expect(page.getByText(/0 of 30 items rated/)).toHaveCount(0);
  await expect(page.getByText("High", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("BYPASSED", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("group", { name: "Delusions" }).getByLabel("Yes")).not.toBeChecked();
  await expect(page.getByLabel("P1 Delusions")).toHaveValue("");
});

function assessment(assessmentType, instrumentPin, extra = {}) {
  return {
    researchCaseId: "30000000-0000-4000-8000-000000000003",
    assessmentType,
    status: "NOT_STARTED",
    answers: null,
    calculation: null,
    instrumentPin,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

function savedState(previous, key, body) {
  if (body.mode === "BYPASS") {
    return {
      ...previous,
      status: "BYPASSED",
      answers: null,
      calculation: null,
      ...(key === "dsm5tr" ? { psychiatristDecision: null } : {}),
    };
  }
  const calculation =
    key === "dsm5tr"
      ? calculateDsm5tr(body.answers)
      : key === "panss"
        ? calculatePanss(body.answers)
        : calculateCssrs(body.answers);
  return {
    ...previous,
    status: body.mode === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS",
    answers: body.answers,
    calculation,
    ...(key === "dsm5tr" ? { psychiatristDecision: body.psychiatristDecision } : {}),
  };
}

function patient(patientId, researchCaseId) {
  return {
    id: patientId,
    officialIdentifier: {
      type: "RESEARCH_ID",
      issuingAuthority: "INSIGHT_TEST",
      value: "SYNTHETIC-000003",
    },
    firstName: "Synthetic",
    lastName: "Assessment",
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
}

import { expect, test } from "@playwright/test";

const session = (role) => ({
  schemaVersion: "1",
  user: {
    id: `10000000-0000-4000-8000-00000000000${role === "ADMINISTRATOR" ? "1" : "2"}`,
    username: role === "ADMINISTRATOR" ? "admin" : "psychiatrist",
    role,
    status: "ENABLED",
  },
  csrfToken: "csrf-token",
  expiresAt: "2026-08-22T12:00:00.000Z",
});

async function mockSession(page, role) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/session") {
      await route.fulfill({ json: session(role) });
      return;
    }
    if (url.pathname === "/api/v1/admin/users") {
      await route.fulfill({ json: { schemaVersion: "1", users: [] } });
      return;
    }
    await route.fulfill({ status: 204 });
  });
}

test("Administrator session exposes only operational navigation", async ({ page }) => {
  await mockSession(page, "ADMINISTRATOR");
  await page.goto("/patients");

  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByText("No patient selected")).toHaveCount(0);
  for (const name of [
    "Users",
    "Model Endpoint",
    "Medication and Comorbidity Knowledge",
    "DDI Sources",
    "Adverse-Effect Catalog",
    "BN Manager",
    "Operational Audit",
    "Backup and Restore",
  ]) {
    await expect(page.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Patient Registry" })).toHaveCount(0);
});

test("Psychiatrist acknowledges research use once and keeps safe navigation after refresh", async ({
  page,
}) => {
  await mockSession(page, "PSYCHIATRIST");
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Research use notice" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Acknowledge and enter workspace" }).click();
  for (const name of [
    "Patient Registry",
    "Create Patient",
    "Research Case Workflow",
    "Final Plan History",
    "Clinical Audit History",
  ]) {
    await expect(page.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Decision support workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Research use notice" })).toHaveCount(0);
});

test("two Psychiatrists share keyboard-accessible registry while Administrator is denied", async ({
  browser,
}) => {
  const patientId = "20000000-0000-4000-8000-000000000001";
  const researchCaseId = "30000000-0000-4000-8000-000000000001";
  const patients = [];
  const seenUrls = [];
  const consoleErrors = [];

  async function newRolePage(role, suffix) {
    const context = await browser.newContext();
    const user = {
      ...session(role),
      user: {
        ...session(role).user,
        id: `10000000-0000-4000-8000-00000000000${suffix}`,
        username: role === "ADMINISTRATOR" ? "admin" : `psychiatrist-${suffix}`,
      },
    };
    await context.addInitScript(
      ({ userId }) => {
        globalThis.localStorage.setItem(`insight.research-use.${userId}.v1`, "acknowledged");
      },
      { userId: user.user.id },
    );
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      seenUrls.push(url.href);
      if (url.pathname === "/api/v1/session") {
        await route.fulfill({ json: user });
        return;
      }
      if (url.pathname.startsWith("/api/v1/patients") && role === "ADMINISTRATOR") {
        await route.fulfill({
          status: 403,
          json: { schemaVersion: "1", error: { code: "FORBIDDEN" } },
        });
        return;
      }
      if (url.pathname === "/api/v1/patients" && request.method() === "GET") {
        await route.fulfill({ json: { schemaVersion: "1", patients } });
        return;
      }
      if (url.pathname === "/api/v1/patients" && request.method() === "POST") {
        const input = request.postDataJSON();
        const existing = patients.find(
          (patient) => patient.officialIdentifier.value === input.officialIdentifier.value,
        );
        const record = {
          id: existing?.id ?? patientId,
          officialIdentifier: input.officialIdentifier,
          firstName: input.firstName,
          lastName: input.lastName,
          dateOfBirth: input.dateOfBirth,
          sex: input.sex,
          profileAge: 36,
          researchCase: {
            id: existing?.researchCase.id ?? researchCaseId,
            startedAt: "2026-08-22T10:00:00.000Z",
            ageAtStart: 36,
          },
          createdAt: existing?.createdAt ?? "2026-08-22T10:00:00.000Z",
          updatedAt: "2026-08-22T10:00:00.000Z",
        };
        if (existing) patients.splice(patients.indexOf(existing), 1, record);
        else patients.push(record);
        await route.fulfill({
          status: existing ? 200 : 201,
          json: { schemaVersion: "1", patient: record },
        });
        return;
      }
      if (url.pathname === `/api/v1/patients/${patientId}`) {
        await route.fulfill({ json: { schemaVersion: "1", patient: patients[0] } });
        return;
      }
      await route.fulfill({ status: 404 });
    });
    return { context, page };
  }

  async function fillPatient(page, firstName) {
    await page.getByLabel(/^First name/).fill(firstName);
    await page.getByLabel(/^Last name/).fill("Lovelace");
    await page.getByLabel(/^Date of birth/).fill("1990-08-22");
    await page.getByLabel(/^Sex/).selectOption("FEMALE");
    await page.getByLabel(/^Official identifier type/).fill("CONFIGURED_OFFICIAL_ID");
    await page.getByLabel(/^Issuing authority/).fill("CONFIGURED_ISSUER");
    await page.getByLabel(/^Official identifier value/).fill("SYNTHETIC-000001");
    await page.getByLabel(/^Official identifier value/).press("Enter");
  }

  const psychiatristOne = await newRolePage("PSYCHIATRIST", "2");
  await psychiatristOne.page.goto("/patients/new");
  await fillPatient(psychiatristOne.page, "Ada");
  await expect(psychiatristOne.page).toHaveURL(`/patients/${patientId}`);
  await expect(psychiatristOne.page.getByRole("heading", { name: "Ada Lovelace" })).toBeVisible();

  const psychiatristTwo = await newRolePage("PSYCHIATRIST", "3");
  await psychiatristTwo.page.goto("/patients");
  await expect(psychiatristTwo.page.getByText("Ada Lovelace")).toBeVisible();
  await psychiatristTwo.page.getByLabel("Search patients").fill("SYNTHETIC-000001");
  await psychiatristTwo.page.getByLabel("Search patients").press("Enter");
  await expect(psychiatristTwo.page).toHaveURL("/patients");
  await expect(psychiatristTwo.page.getByText("Ada Lovelace")).toBeVisible();

  await psychiatristTwo.page.goto("/patients/new");
  await fillPatient(psychiatristTwo.page, "Grace");
  await expect(psychiatristTwo.page).toHaveURL(`/patients/${patientId}`);
  await expect(psychiatristTwo.page.getByRole("heading", { name: "Grace Lovelace" })).toBeVisible();
  expect(patients).toHaveLength(1);

  const administrator = await newRolePage("ADMINISTRATOR", "1");
  await administrator.page.goto("/patients");
  await expect(
    administrator.page.getByRole("heading", { level: 1, name: "Page not found" }),
  ).toBeVisible();
  expect(
    await administrator.page.evaluate(() =>
      fetch("/api/v1/patients").then((response) => response.status),
    ),
  ).toBe(403);

  expect(seenUrls.some((url) => url.includes("SYNTHETIC-000001") || url.includes("Lovelace"))).toBe(
    false,
  );
  expect(consoleErrors.some((message) => /SYNTHETIC-000001|Ada|Grace|Lovelace/.test(message))).toBe(
    false,
  );
  await Promise.all([
    psychiatristOne.context.close(),
    psychiatristTwo.context.close(),
    administrator.context.close(),
  ]);
});

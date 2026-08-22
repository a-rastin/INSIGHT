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

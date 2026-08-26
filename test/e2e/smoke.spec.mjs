import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("backend roles own gateway navigation and refresh restores safe state", async ({
  context,
  page,
}) => {
  const blockedOrigins = [];
  const consoleErrors = [];
  let createdPassword;

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const local = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    if (local || ["about:", "blob:", "data:"].includes(url.protocol)) {
      await route.continue();
      return;
    }
    blockedOrigins.push(url.origin);
    await route.abort("blockedbyclient");
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 401 \(Unauthorized\)/.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/admin/users")) {
      createdPassword = request.postDataJSON().password;
    }
  });

  await page.goto("/");
  await expect(page).toHaveTitle("INSIGHT");
  await page.getByRole("textbox", { name: "Username" }).fill("admin");
  await page.getByRole("textbox", { name: /^Password/ }).fill("admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Administration workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("INSIGHT");
  await expect(page.getByRole("region", { name: "Workspace services" })).toBeVisible();

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

  await page.getByRole("link", { name: "Users" }).click();
  const username = `E2EUser-${Date.now()}`;
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByLabel("Initial password").fill("initial-password");
  await expect(page.getByLabel("Initial password")).toHaveValue("initial-password");
  await page.getByRole("button", { name: "Create user" }).click();
  expect(createdPassword).toBe("initial-password");
  const row = page.getByRole("row", { name: new RegExp(username) });
  await expect(row).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByRole("textbox", { name: /^Password/ }).fill("initial-password");
  await page.getByRole("button", { name: "Sign in" }).click();
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
  await page.goto("/administration/users");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create user" })).toHaveCount(0);

  expect(blockedOrigins).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("Administrator signs in and manages a temporary password without external traffic", async ({
  context,
  page,
}) => {
  const blockedOrigins = [];
  const consoleErrors = [];

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

  await page.getByRole("link", { name: "User management" }).click();
  const username = `E2EUser-${Date.now()}`;
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByLabel("Initial password").fill("initial-password");
  await page.getByRole("button", { name: "Create user" }).click();
  const row = page.getByRole("row", { name: new RegExp(username) });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: "Temporary reset" }).click();
  await page.getByRole("textbox", { name: /^Temporary password/ }).fill("temporary-password");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText(`Temporary password set for ${username}.`);

  expect(blockedOrigins).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

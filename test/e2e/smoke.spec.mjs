import { expect, test } from "@playwright/test";

test("production browser shell loads without external traffic", async ({ context, page }) => {
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
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page).toHaveTitle("INSIGHT");
  await expect(
    page.getByRole("heading", { level: 1, name: "Decision support workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("INSIGHT");
  await expect(page.getByRole("region", { name: "Workspace services" })).toBeVisible();

  expect(blockedOrigins).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

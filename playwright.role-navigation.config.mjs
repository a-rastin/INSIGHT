import { defineConfig } from "@playwright/test";
import process from "node:process";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: /(?:role-navigation|panss|ddi-results)\.spec\.mjs/,
  outputDir: "test-artifacts/playwright/role-navigation",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm exec vite --workspace @insight/web -- preview --host 127.0.0.1 --port 4174",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:4174",
  },
});

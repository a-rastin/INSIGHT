import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  workers: 1,
  outputDir: "test-artifacts/playwright/results",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: "node .tsbuild/server/index.js",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: "4173",
      INSIGHT_OFFICIAL_IDENTIFIER_TYPE: "RESEARCH_ID",
      INSIGHT_OFFICIAL_IDENTIFIER_ISSUER: "INSIGHT_TEST",
      INSIGHT_OFFICIAL_IDENTIFIER_PATTERN: "^SYNTHETIC-[0-9]{6}$",
      INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION: "NFKC_UPPERCASE",
      INSIGHT_WORKER_READY_FILE: "package.json",
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:4173/api/v1/ready",
  },
});

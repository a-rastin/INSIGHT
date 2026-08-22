import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-artifacts/playwright/results",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
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
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:4173/api/v1/ready",
  },
});

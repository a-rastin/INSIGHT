import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: ["tests/e2e/**", "node_modules/**"],
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: ["./tests/setup.ts"],
  },
});

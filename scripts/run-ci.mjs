import { spawnSync } from "node:child_process";

const checks = [
  "format",
  "lint",
  "typecheck",
  "test:unit",
  "test:integration",
  "api:check",
  "db:migrate",
  "build",
  "test:container",
  "test:e2e",
  "test:artifacts:scan",
];

for (const check of checks) {
  const result = spawnSync("npm", ["run", check], { env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

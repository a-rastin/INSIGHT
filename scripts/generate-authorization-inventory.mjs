import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { AUTHORIZATION_MATRIX } from "../.tsbuild/server/index.js";

const output = resolve("docs/security/authorization-inventory.md");
const rows = [...AUTHORIZATION_MATRIX].sort((left, right) =>
  `${left.surface}:${left.id}`.localeCompare(`${right.surface}:${right.id}`),
);
const content = `${[
  "# Server Authorization Inventory",
  "",
  "Generated from `apps/server/src/authorization.ts`. Do not edit manually.",
  "",
  "| Surface | Command | Allow | Deny | Object access | Data | Workflow states |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${row.surface} | \`${row.id}\` | ${row.allowed.join(", ")} | ${row.denied.join(", ")} | ${row.objectAccess} | ${row.dataClass} | ${row.workflowStates.join(", ") || "N/A"} |`,
  ),
  "",
].join("\n")}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(output, "utf8").catch(() => "");
  if (existing !== content) {
    console.error("Authorization inventory is stale. Run npm run authorization:generate.");
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
}

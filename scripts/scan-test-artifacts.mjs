import { readdir, readFile } from "node:fs/promises";

import { artifactPolicyViolations } from "../test/support/artifact-policy.mjs";

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push("test-artifacts", "coverage");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const failures = [];
for (const root of roots) {
  for (const path of await filesUnder(root)) {
    const content = await readFile(path).catch(() => null);
    if (!content || content.includes(0)) continue;
    const violations = artifactPolicyViolations(content.toString("utf8"));
    if (violations.length > 0) failures.push(`${path}: ${violations.join(", ")}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Unsafe test artifacts detected:\n${failures.join("\n")}`);
}

console.log("Test artifacts contain no recognized Patient identity or secret patterns.");

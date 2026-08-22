import { mkdir, readFile, writeFile } from "node:fs/promises";

import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { format, resolveConfig } from "prettier";

import { buildApp } from "../.tsbuild/server/app.js";

const CHECK = process.argv.includes("--check");
const OPENAPI_PATH = new URL("../docs/api/openapi.v1.json", import.meta.url);
const TYPES_PATH = new URL("../apps/web/src/generated/api-types.ts", import.meta.url);
const CLIENT_PATH = new URL("../apps/web/src/generated/api-client.ts", import.meta.url);
const prettierOptions = (await resolveConfig("prettier.config.mjs")) ?? {};

const app = buildApp({
  authentication: { pool: {} },
  patient: {
    officialIdentifier: {
      type: "CONFIGURED_OFFICIAL_ID",
      issuingAuthority: "CONFIGURED_ISSUER",
      pattern: "^[A-Z0-9-]{1,64}$",
      normalization: "NFKC_UPPERCASE",
    },
  },
});
await app.ready();
const document = app.swagger();
await app.close();

const openapi = await format(JSON.stringify(document), { ...prettierOptions, parser: "json" });
const types = await format(`${COMMENT_HEADER}${astToString(await openapiTS(document))}`, {
  ...prettierOptions,
  parser: "typescript",
});
const client = await format(
  `/** Auto-generated from docs/api/openapi.v1.json. Do not edit. */
import createClient from "openapi-fetch";

import type { paths } from "./api-types";

export const apiClient = createClient<paths>({
  baseUrl: window.location.origin,
  fetch: (request) => fetch(request),
});
`,
  { ...prettierOptions, parser: "typescript" },
);

const outputs = [
  [OPENAPI_PATH, openapi],
  [TYPES_PATH, types],
  [CLIENT_PATH, client],
];

for (const [path, content] of outputs) {
  if (CHECK) {
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing !== content) {
      throw new Error(`${path.pathname} is stale; run npm run api:generate`);
    }
  } else {
    await mkdir(new URL(".", path), { recursive: true });
    await writeFile(path, content);
  }
}

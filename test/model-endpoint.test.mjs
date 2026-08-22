import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ModelEndpointInputError,
  modelChatCompletionsUrl,
  normalizeModelBaseUrl,
} from "../.tsbuild/server/model-endpoint/index.js";

const cases = [
  [" https://model.example/v1/ ", false, "https://model.example/v1"],
  ["https://model.example/openai/v1///", false, "https://model.example/openai/v1"],
  ["https://model.example", false, "https://model.example"],
  ["http://127.0.0.1:8080/v1/", true, "http://127.0.0.1:8080/v1"],
  ["http://localhost:8080/custom/v1", true, "http://localhost:8080/custom/v1"],
  ["http://[::1]:8080/v1", true, "http://[::1]:8080/v1"],
];

test("model base URL normalization preserves provider paths", () => {
  for (const [input, development, expected] of cases) {
    const normalized = normalizeModelBaseUrl(input, development);
    assert.equal(normalized, expected);
    assert.equal(modelChatCompletionsUrl(normalized), `${expected}/chat/completions`);
  }
});

test("model endpoint response contracts expose no credential field", async () => {
  const openapi = JSON.parse(await readFile("docs/api/openapi.v1.json", "utf8"));
  for (const [path, method] of [
    ["/api/v1/admin/model-endpoint", "get"],
    ["/api/v1/admin/model-endpoint", "put"],
    ["/api/v1/admin/model-endpoint/credential", "delete"],
    ["/api/v1/admin/model-endpoint/check", "post"],
  ]) {
    const responses = JSON.stringify(openapi.paths[path][method].responses);
    assert.doesNotMatch(responses, /\"credential\"\s*:/i);
    assert.doesNotMatch(responses, /api.?key|bearer/i);
  }
});

test("model base URL rejects unsafe or completed endpoint forms", () => {
  const rejected = [
    "http://model.example/v1",
    "http://127.0.0.1:8080/v1",
    "ftp://model.example/v1",
    "//model.example/v1",
    "https://user:password@model.example/v1",
    "https://model.example/v1?region=test",
    "https://model.example/v1?",
    "https://model.example/v1#fragment",
    "https://model.example/v1#",
    "https://model.example/v1/chat/completions",
    "https://model.example/v1/CHAT/COMPLETIONS/",
    "http://192.168.1.2/v1",
    "not a URL",
  ];
  for (const input of rejected) {
    assert.throws(() => normalizeModelBaseUrl(input), ModelEndpointInputError, input);
  }
  assert.throws(
    () => normalizeModelBaseUrl("http://192.168.1.2/v1", true),
    ModelEndpointInputError,
  );
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ModelEndpointInputError,
  modelChatCompletionsUrl,
  normalizeModelBaseUrl,
  runModelEndpointCompatibilityProbe,
} from "../.tsbuild/server/model-endpoint/index.js";

const cases = [
  [" https://model.example/v1/ ", false, "https://model.example/v1"],
  ["https://model.example/openai/v1///", false, "https://model.example/openai/v1"],
  ["https://model.example", false, "https://model.example"],
  ["http://127.0.0.1:8080/v1/", true, "http://127.0.0.1:8080/v1"],
  ["http://localhost:8080/custom/v1", true, "http://localhost:8080/custom/v1"],
  ["http://[::1]:8080/v1", true, "http://[::1]:8080/v1"],
];

const secret = "synthetic-native-transport-secret";

async function withMockServer(handler, operation) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await operation(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function expectedArguments(body) {
  const properties = body.tools[0].function.parameters.properties;
  return {
    nonce: properties.nonce.const,
    roundTrip: {
      sequence: properties.roundTrip.properties.sequence.const,
      acknowledged: true,
    },
    checks: [{ name: "native-chat-completions", passed: true }],
  };
}

function toolResponse(body, index, argumentsValue, model = "safe-provider-model") {
  return {
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${index}`,
              type: "function",
              function: { name: body.tool_choice.function.name, arguments: argumentsValue },
            },
          ],
        },
      },
    ],
  };
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("model base URL normalization preserves provider paths", () => {
  for (const [input, development, expected] of cases) {
    const normalized = normalizeModelBaseUrl(input, development);
    assert.equal(normalized, expected);
    assert.equal(modelChatCompletionsUrl(normalized), `${expected}/chat/completions`);
  }
});

test("native transport performs exact forced-tool round trip with string arguments", async () => {
  const requests = [];
  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      sendJson(
        response,
        toolResponse(body, requests.length, JSON.stringify(expectedArguments(body))),
      );
    },
    async (root) => {
      const baseUrl = normalizeModelBaseUrl(`${root}/nested/provider/v1///`, true);
      const result = await runModelEndpointCompatibilityProbe(baseUrl, "requested-model", secret);
      assert.deepEqual(result, {
        compatible: true,
        failureCategory: null,
        returnedModel: "safe-provider-model",
      });
    },
  );

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "/nested/provider/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.authorization, `Bearer ${secret}`);
    assert.match(request.contentType, /^application\/json/);
    assert.deepEqual(Object.keys(request.body).sort(), [
      "messages",
      "model",
      "tool_choice",
      "tools",
    ]);
    assert.equal(request.body.model, "requested-model");
    assert.equal(request.body.tool_choice.type, "function");
    assert.equal(request.body.tool_choice.function.name, request.body.tools[0].function.name);
  }
  const firstAssistant = toolResponse(
    requests[0].body,
    1,
    JSON.stringify(expectedArguments(requests[0].body)),
  ).choices[0].message;
  assert.deepEqual(requests[1].body.messages[1], firstAssistant);
  assert.equal(requests[1].body.messages[2].role, "tool");
  assert.equal(requests[1].body.messages[2].tool_call_id, firstAssistant.tool_calls[0].id);
  assert.deepEqual(JSON.parse(requests[1].body.messages[2].content), {
    accepted: expectedArguments(requests[0].body),
    next: expectedArguments(requests[1].body),
  });
});

test("probe accepts decoded object arguments and randomizes nonce", async () => {
  const nonces = [];
  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      const argumentsValue = expectedArguments(body);
      if (body.tool_choice.function.name === "insight_probe_echo")
        nonces.push(argumentsValue.nonce);
      sendJson(response, toolResponse(body, nonces.length, argumentsValue));
    },
    async (root) => {
      const baseUrl = `${root}/v1`;
      assert.equal(
        (await runModelEndpointCompatibilityProbe(baseUrl, "model", secret)).compatible,
        true,
      );
      assert.equal(
        (await runModelEndpointCompatibilityProbe(baseUrl, "model", secret)).compatible,
        true,
      );
    },
  );
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
  assert.match(nonces[0], /^[A-Za-z0-9_-]{24}$/);
});

test("probe maps HTTP compatibility failures", async (suite) => {
  for (const [status, failureCategory] of [
    [401, "AUTHENTICATION"],
    [404, "ENDPOINT"],
    [408, "TIMEOUT"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER"],
    [503, "PROVIDER"],
  ]) {
    await suite.test(String(status), async () => {
      await withMockServer(
        (_request, response) => sendJson(response, { error: secret }, status),
        async (root) => {
          assert.deepEqual(await runModelEndpointCompatibilityProbe(root, "model", secret), {
            compatible: false,
            failureCategory,
            returnedModel: null,
          });
        },
      );
    });
  }
});

test("probe fails closed on timeout, malformed JSON, and missing tool calls", async (suite) => {
  await suite.test("timeout", async () => {
    await withMockServer(
      () => undefined,
      async (root) => {
        const result = await runModelEndpointCompatibilityProbe(root, "model", secret, 20);
        assert.equal(result.failureCategory, "TIMEOUT");
      },
    );
  });
  await suite.test("malformed JSON", async () => {
    await withMockServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
      },
      async (root) => {
        const result = await runModelEndpointCompatibilityProbe(root, "model", secret);
        assert.equal(result.failureCategory, "MALFORMED_RESPONSE");
      },
    );
  });
  await suite.test("missing tool call", async () => {
    await withMockServer(
      (_request, response) => sendJson(response, { choices: [{ message: { role: "assistant" } }] }),
      async (root) => {
        const result = await runModelEndpointCompatibilityProbe(root, "model", secret);
        assert.equal(result.failureCategory, "TOOL_CALL");
      },
    );
  });
});

test("complete local schema rejects malformed, nested-extra, and second-call arguments", async (suite) => {
  for (const [name, mutate, failureCategory] of [
    ["malformed argument JSON", () => "{", "TOOL_CALL"],
    [
      "nested additional property",
      (body) => ({
        ...expectedArguments(body),
        roundTrip: { ...expectedArguments(body).roundTrip, unexpected: true },
      }),
      "TOOL_CALL",
    ],
    [
      "second call mismatch",
      (body) =>
        body.tool_choice.function.name === "insight_probe_complete"
          ? { ...expectedArguments(body), nonce: "wrong" }
          : expectedArguments(body),
      "TOOL_ROUND_TRIP",
    ],
  ]) {
    await suite.test(name, async () => {
      await withMockServer(
        async (request, response) => {
          const body = await readRequest(request);
          sendJson(response, toolResponse(body, 1, mutate(body)));
        },
        async (root) => {
          const result = await runModelEndpointCompatibilityProbe(root, "model", secret);
          assert.equal(result.failureCategory, failureCategory);
        },
      );
    });
  }
});

test("returned model metadata cannot reflect credential", async () => {
  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      sendJson(
        response,
        toolResponse(body, 1, expectedArguments(body), `provider-${secret}-metadata`),
      );
    },
    async (root) => {
      const result = await runModelEndpointCompatibilityProbe(root, "model", secret);
      assert.equal(result.compatible, true);
      assert.equal(result.returnedModel, null);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    },
  );
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
    assert.doesNotMatch(responses, /"credential"\s*:/i);
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

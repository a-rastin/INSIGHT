import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ModelEndpointAuthorizationError,
  checkModelEndpointCompatibility,
  clearModelEndpointCredential,
  createUser,
  getModelEndpointConfiguration,
  replaceModelEndpointConfiguration,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const secret = "synthetic-model-key-never-returned";

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function argumentsFromSchema(body) {
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

test("Administrator-only versioned model endpoint configuration", async (suite) => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readRequest(request);
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    const name = body.tool_choice.function.name;
    const argumentsValue = argumentsFromSchema(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "provider-model-build-1",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${requests.length}`,
                  type: "function",
                  function: {
                    name,
                    arguments:
                      requests.length === 1 ? JSON.stringify(argumentsValue) : argumentsValue,
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/nested/provider/v1`;

  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = (
          await pool.query("SELECT id, role FROM insight.users WHERE username_normalized='admin'")
        ).rows[0];
        const psychiatrist = await createUser(pool, {
          username: "ModelEndpointPsychiatrist",
          password: "synthetic-password",
          role: "PSYCHIATRIST",
        });

        await suite.test("Psychiatrist and forged Administrator role are denied", async () => {
          await assert.rejects(
            () =>
              getModelEndpointConfiguration(pool, { id: psychiatrist.id, role: psychiatrist.role }),
            ModelEndpointAuthorizationError,
          );
          await assert.rejects(
            () =>
              getModelEndpointConfiguration(pool, { id: psychiatrist.id, role: "ADMINISTRATOR" }),
            ModelEndpointAuthorizationError,
          );
        });

        let configuration;
        await suite.test(
          "replace creates PENDING version without exposing credential",
          async () => {
            configuration = await replaceModelEndpointConfiguration(
              pool,
              administrator,
              { baseUrl: ` ${baseUrl}/ `, model: " model-a ", credential: ` ${secret} ` },
              true,
            );
            assert.equal(configuration.version, 1);
            assert.equal(configuration.baseUrl, baseUrl);
            assert.equal(configuration.model, "model-a");
            assert.equal(configuration.status, "PENDING");
            assert.equal(configuration.aiEligible, false);
            assert.equal(configuration.credentialConfigured, true);
            assert.doesNotMatch(JSON.stringify(configuration), new RegExp(secret));

            const storage = await pool.query(
              `SELECT credential_ciphertext, base_url, model FROM insight.model_endpoint_configurations`,
            );
            assert.equal(storage.rows.length, 1);
            assert.notEqual(storage.rows[0].credential_ciphertext.toString("utf8"), secret);
            const audits = await pool.query("SELECT * FROM insight.model_endpoint_audit_events");
            assert.doesNotMatch(JSON.stringify(audits.rows), new RegExp(secret));
          },
        );

        await suite.test("native two-request probe enables exact configuration", async () => {
          configuration = await checkModelEndpointCompatibility(pool, administrator);
          assert.equal(configuration.status, "COMPATIBLE");
          assert.equal(configuration.aiEligible, true);
          assert.equal(configuration.returnedModel, "provider-model-build-1");
          assert.equal(requests.length, 2);
          assert.equal(requests[0].url, "/nested/provider/v1/chat/completions");
          assert.equal(requests[0].authorization, `Bearer ${secret}`);
          assert.equal(requests[1].body.messages[2].tool_call_id, "call-1");
          assert.deepEqual(requests[1].body.messages[1], {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "insight_probe_echo",
                  arguments: JSON.stringify(argumentsFromSchema(requests[0].body)),
                },
              },
            ],
          });
          assert.doesNotMatch(JSON.stringify(configuration), new RegExp(secret));
        });

        await suite.test(
          "every configuration input invalidates fingerprint eligibility",
          async () => {
            const compatibleFingerprint = configuration.configurationFingerprint;
            const changedModel = await replaceModelEndpointConfiguration(
              pool,
              administrator,
              { baseUrl, model: "model-b", credential: secret },
              true,
            );
            assert.equal(changedModel.status, "PENDING");
            assert.equal(changedModel.aiEligible, false);
            assert.notEqual(changedModel.configurationFingerprint, compatibleFingerprint);

            const changedUrl = await replaceModelEndpointConfiguration(
              pool,
              administrator,
              {
                baseUrl: `${baseUrl}/alternate-root`,
                model: "model-b",
                credential: secret,
              },
              true,
            );
            assert.equal(changedUrl.status, "PENDING");
            assert.equal(changedUrl.aiEligible, false);
            assert.notEqual(
              changedUrl.configurationFingerprint,
              changedModel.configurationFingerprint,
            );

            const changedCredential = await replaceModelEndpointConfiguration(
              pool,
              administrator,
              {
                baseUrl: changedUrl.baseUrl,
                model: changedUrl.model,
                credential: "rotated-synthetic-key",
              },
              true,
            );
            assert.equal(changedCredential.status, "PENDING");
            assert.equal(changedCredential.aiEligible, false);
            assert.notEqual(
              changedCredential.configurationFingerprint,
              changedUrl.configurationFingerprint,
            );

            const cleared = await clearModelEndpointCredential(pool, administrator);
            assert.equal(cleared.credentialConfigured, false);
            assert.equal(cleared.status, "PENDING");
            assert.equal(cleared.aiEligible, false);
            assert.notEqual(
              cleared.configurationFingerprint,
              changedCredential.configurationFingerprint,
            );
            assert.doesNotMatch(
              JSON.stringify(await getModelEndpointConfiguration(pool, administrator)),
              /rotated-synthetic-key/,
            );
          },
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

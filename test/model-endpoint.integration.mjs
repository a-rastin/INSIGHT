import assert from "node:assert/strict";
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

test("Administrator-only versioned model endpoint configuration", async (suite) => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
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
          () => getModelEndpointConfiguration(pool, { id: psychiatrist.id, role: "ADMINISTRATOR" }),
          ModelEndpointAuthorizationError,
        );
      });

      let configuration;
      await suite.test("replace creates PENDING version without exposing credential", async () => {
        configuration = await replaceModelEndpointConfiguration(pool, administrator, {
          baseUrl: " https://provider.example/custom/v1/ ",
          model: " model-a ",
          credential: ` ${secret} `,
        });
        assert.equal(configuration.version, 1);
        assert.equal(configuration.baseUrl, "https://provider.example/custom/v1");
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
      });

      await suite.test("two-request tool probe enables exact configuration", async () => {
        const requests = [];
        const fetcher = async (url, options) => {
          requests.push({ url, authorization: options.headers.authorization, body: options.body });
          const request = JSON.parse(options.body);
          const name = request.tool_choice.function.name;
          const nonce = request.tools[0].function.parameters.properties.nonce.const;
          return {
            ok: true,
            status: 200,
            json: async () => ({
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
                        function: { name, arguments: JSON.stringify({ nonce }) },
                      },
                    ],
                  },
                },
              ],
            }),
          };
        };
        configuration = await checkModelEndpointCompatibility(pool, administrator, fetcher);
        assert.equal(configuration.status, "COMPATIBLE");
        assert.equal(configuration.aiEligible, true);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].url, "https://provider.example/custom/v1/chat/completions");
        assert.equal(requests[0].authorization, `Bearer ${secret}`);
        assert.doesNotMatch(JSON.stringify(configuration), new RegExp(secret));
      });

      await suite.test(
        "rotation and clear create versions and invalidate eligibility",
        async () => {
          const compatibleFingerprint = configuration.configurationFingerprint;
          const rotated = await replaceModelEndpointConfiguration(pool, administrator, {
            baseUrl: configuration.baseUrl,
            model: configuration.model,
            credential: "rotated-synthetic-key",
          });
          assert.equal(rotated.version, 2);
          assert.equal(rotated.status, "PENDING");
          assert.equal(rotated.aiEligible, false);
          assert.notEqual(rotated.configurationFingerprint, compatibleFingerprint);

          const cleared = await clearModelEndpointCredential(pool, administrator);
          assert.equal(cleared.version, 3);
          assert.equal(cleared.credentialConfigured, false);
          assert.equal(cleared.status, "PENDING");
          assert.equal(cleared.aiEligible, false);
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
});

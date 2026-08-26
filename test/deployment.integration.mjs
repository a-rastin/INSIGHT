import assert from "node:assert/strict";
import test from "node:test";

import {
  IdentifiedResearchModeDisabledError,
  activateIdentifiedResearchMode,
  assertIdentifiedPatientCreationAllowed,
  buildApp,
  createUser,
  getDeploymentGateStatus,
  recordDeploymentEvidence,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const allControls = {
  participantConsentOrWaiver: true,
  administratorSeparation: true,
  encryptionInTransit: true,
  encryptionAtRest: true,
  auditControls: true,
  dataGovernanceRules: true,
  modelDisclosureControls: true,
  environmentSeparation: true,
};

test("EXT-01 deployment evidence gate", async (suite) => {
  assert.ok(
    adminConnectionString,
    "TEST_DATABASE_URL must target a PostgreSQL 16 database whose role can create databases.",
  );

  await suite.test("transition, evidence change, expiry, and Patient creation fail closed", () =>
    withDeploymentDatabase(async (pool) => {
      const administrator = (
        await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
      ).rows[0];
      const effectiveAt = new Date("2030-01-01T00:00:00.000Z");
      const expiresAt = new Date("2031-01-01T00:00:00.000Z");
      const input = evidenceInput(effectiveAt, expiresAt);

      assert.deepEqual(await getDeploymentGateStatus(pool, effectiveAt), {
        identifiedMode: "DISABLED",
        reason: "NO_EVIDENCE",
        evidence: null,
      });
      await assert.rejects(
        () => assertIdentifiedPatientCreationAllowed(pool, effectiveAt),
        IdentifiedResearchModeDisabledError,
      );

      const versionOne = await recordDeploymentEvidence(pool, administrator.id, input);
      assert.equal(versionOne.version, 1);
      assert.equal((await getDeploymentGateStatus(pool, effectiveAt)).reason, "EVIDENCE_CHANGED");
      assert.equal(
        (await activateIdentifiedResearchMode(pool, administrator.id, 1, undefined, effectiveAt))
          .identifiedMode,
        "ENABLED",
      );
      await assertIdentifiedPatientCreationAllowed(pool, effectiveAt);

      const versionTwo = await recordDeploymentEvidence(pool, administrator.id, {
        ...input,
        approvalReference: "EXT-01-REVISION-2",
      });
      assert.equal(versionTwo.version, 2);
      assert.equal((await getDeploymentGateStatus(pool, effectiveAt)).identifiedMode, "DISABLED");
      await assert.rejects(
        () => assertIdentifiedPatientCreationAllowed(pool, effectiveAt),
        IdentifiedResearchModeDisabledError,
      );

      await activateIdentifiedResearchMode(pool, administrator.id, 2, undefined, effectiveAt);
      const expired = await getDeploymentGateStatus(pool, expiresAt);
      assert.equal(expired.identifiedMode, "DISABLED");
      assert.equal(expired.reason, "APPROVAL_EXPIRED");
      await assert.rejects(
        () => assertIdentifiedPatientCreationAllowed(pool, expiresAt),
        IdentifiedResearchModeDisabledError,
      );

      const evidenceRows = await pool.query(
        "SELECT version, approval_reference FROM insight.deployment_evidence_versions ORDER BY version",
      );
      assert.deepEqual(evidenceRows.rows, [
        { version: 1, approval_reference: "EXT-01-REFERENCE" },
        { version: 2, approval_reference: "EXT-01-REVISION-2" },
      ]);
      await assert.rejects(
        () =>
          pool.query(
            "UPDATE insight.deployment_evidence_versions SET approval_reference = 'changed' WHERE version = 1",
          ),
        /deployment evidence versions are immutable/,
      );

      const audit = await pool.query(
        `SELECT event_type, actor_user_id, evidence_version, environment_status
         FROM insight.operational_audit_events
         ORDER BY occurred_at, event_type`,
      );
      assert.ok(audit.rows.every(({ evidence_version }) => Number.isInteger(evidence_version)));
      assert.ok(
        audit.rows.some(
          ({ event_type, actor_user_id }) =>
            event_type === "IDENTIFIED_MODE_DISABLED" && actor_user_id === null,
        ),
      );
      const auditColumns = await pool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'insight' AND table_name = 'operational_audit_events'`,
      );
      assert.doesNotMatch(
        auditColumns.rows.map(({ column_name }) => column_name).join(" "),
        /authority|basis|approval_reference|patient|clinical|content|payload/,
      );
    }),
  );

  await suite.test("activation requires every prerequisite", () =>
    withDeploymentDatabase(async (pool) => {
      const administrator = (
        await pool.query("SELECT id FROM insight.users WHERE username_normalized = 'admin'")
      ).rows[0];
      const now = new Date("2030-01-01T00:00:00.000Z");
      const evidence = await recordDeploymentEvidence(
        pool,
        administrator.id,
        evidenceInput(new Date("2029-01-01T00:00:00.000Z"), new Date("2031-01-01T00:00:00.000Z"), {
          encryptionAtRest: false,
        }),
      );
      await assert.rejects(
        () =>
          activateIdentifiedResearchMode(pool, administrator.id, evidence.version, undefined, now),
        (error) =>
          error.name === "DeploymentPrerequisitesIncompleteError" &&
          error.prerequisites.includes("encryptionAtRest"),
      );
      assert.equal((await getDeploymentGateStatus(pool, now)).identifiedMode, "DISABLED");
    }),
  );

  await suite.test("deployment evidence services reject Psychiatrist actors", () =>
    withDeploymentDatabase(async (pool) => {
      const psychiatrist = await createUser(pool, {
        username: "ServiceDenied",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      await assert.rejects(
        () =>
          recordDeploymentEvidence(
            pool,
            psychiatrist.id,
            evidenceInput(
              new Date("2029-01-01T00:00:00.000Z"),
              new Date("2031-01-01T00:00:00.000Z"),
            ),
          ),
        (error) => error.name === "DeploymentAuthorizationError",
      );
    }),
  );

  await suite.test("evidence stays Administrator-only and does not block Patient creation", () =>
    withDeploymentDatabase(async (pool) => {
      await createUser(pool, {
        username: "Researcher",
        password: "research-password",
        role: "PSYCHIATRIST",
      });
      const app = buildApp({
        authentication: { pool, allowInsecureLoopbackCookie: true, loginDelay: async () => {} },
        registerApiRoutes: async (api) => {
          api.post("/patients", async (_request, reply) =>
            reply.status(201).send({ created: true }),
          );
        },
      });
      try {
        const administrator = await login(app, "admin", "admin");
        const psychiatrist = await login(app, "Researcher", "research-password");
        const denied = await app.inject({
          method: "GET",
          url: "/api/v1/admin/deployment-evidence",
          headers: { cookie: psychiatrist.cookie },
        });
        assert.equal(denied.statusCode, 403);

        const patientCreation = await app.inject({
          method: "POST",
          url: "/api/v1/patients",
          headers: {
            cookie: psychiatrist.cookie,
            "x-csrf-token": psychiatrist.csrfToken,
          },
          payload: { identified: true },
        });
        assert.equal(patientCreation.statusCode, 201);

        const created = await app.inject({
          method: "POST",
          url: "/api/v1/admin/deployment-evidence",
          headers: {
            cookie: administrator.cookie,
            "x-csrf-token": administrator.csrfToken,
          },
          payload: {
            schemaVersion: "1",
            responsibleAuthority: "External Research Ethics Committee",
            approvalBasis: "External research approval",
            approvalReference: "EXT-01-REFERENCE",
            approvalGrantedAt: "2020-01-01T00:00:00.000Z",
            approvalExpiresAt: "2099-01-01T00:00:00.000Z",
            environmentStatus: "APPROVED_IDENTIFIED_RESEARCH",
            securityControls: allControls,
          },
        });
        assert.equal(created.statusCode, 201);
        assert.equal(created.json().identifiedMode, "DISABLED");
        assert.match(created.json().notice, /does not grant ethics or legal approval/);
        assert.doesNotMatch(
          created.body,
          /patient|clinical|officialIdentifier|firstName|lastName/i,
        );

        const activated = await app.inject({
          method: "POST",
          url: "/api/v1/admin/deployment-evidence/1/activate",
          headers: {
            cookie: administrator.cookie,
            "x-csrf-token": administrator.csrfToken,
          },
        });
        assert.equal(activated.statusCode, 200);
        assert.equal(activated.json().identifiedMode, "ENABLED");

        const patientCreationAfterActivation = await app.inject({
          method: "POST",
          url: "/api/v1/patients",
          headers: {
            cookie: psychiatrist.cookie,
            "x-csrf-token": psychiatrist.csrfToken,
          },
          payload: { identified: true },
        });
        assert.equal(patientCreationAfterActivation.statusCode, 201);

        const adminPatientAccess = await app.inject({
          method: "POST",
          url: "/api/v1/patients",
          headers: {
            cookie: administrator.cookie,
            "x-csrf-token": administrator.csrfToken,
          },
          payload: { identified: true },
        });
        assert.equal(adminPatientAccess.statusCode, 403);
      } finally {
        await app.close();
      }
    }),
  );
});

function evidenceInput(approvalGrantedAt, approvalExpiresAt, controlOverrides = {}) {
  return {
    responsibleAuthority: "External Research Ethics Committee",
    approvalBasis: "External research approval",
    approvalReference: "EXT-01-REFERENCE",
    approvalGrantedAt,
    approvalExpiresAt,
    environmentStatus: "APPROVED_IDENTIFIED_RESEARCH",
    securityControls: { ...allControls, ...controlOverrides },
  };
}

async function login(app, username, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  return {
    cookie: setCookie.split(";", 1)[0],
    csrfToken: response.json().csrfToken,
  };
}

async function withDeploymentDatabase(operation) {
  return withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
    const pool = createPostgresPool({ connectionString });
    try {
      await migrateToHead(pool);
      return await operation(pool);
    } finally {
      await pool.end();
    }
  });
}

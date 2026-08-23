import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  DDI_TRANSFORM_VERSION,
  MEDSCAPE_PARSER_VERSION,
  InternalMcpGateway,
  McpToolError,
  activateDdiSource,
  createDdiToolHandlers,
  createOrOverwritePatient,
  createUser,
  evaluateDdiRegimen,
  importDdiSource,
  reviewDdiSource,
  sha256,
} from "../.tsbuild/server/index.js";
import {
  createPostgresPool,
  migrateToHead,
  withIsolatedTestDatabase,
} from "../.tsbuild/server/database/index.js";
import { makeSyntheticPatientIdentity } from "./support/synthetic-data.mjs";

const adminConnectionString = process.env.TEST_DATABASE_URL;
const identifierConfiguration = {
  type: "RESEARCH_ID",
  issuingAuthority: "INSIGHT_TEST",
  pattern: "^SYNTHETIC-[0-9]{6}$",
  normalization: "NFKC_UPPERCASE",
};
const regimen = [
  {
    medicationEntryRef: "current-1",
    kind: "CURRENT",
    normalizationState: "NORMALIZED",
    canonicalId: "DRUG-A",
  },
  {
    medicationEntryRef: "proposed-1",
    kind: "PROPOSED",
    normalizationState: "NORMALIZED",
    canonicalId: "DRUG-B",
  },
  {
    medicationEntryRef: "proposed-2",
    kind: "PROPOSED",
    normalizationState: "UNKNOWN",
  },
];
const refs = regimen.map(({ medicationEntryRef }) => medicationEntryRef);

function sourceInput(drugIdentity, partner, detail) {
  const artifact = new TextEncoder().encode(`${drugIdentity}
Interactions
Serious (1)
• ${partner}: ${detail}
Adverse Effects`);
  return {
    artifact,
    manifest: {
      drugIdentity,
      title: `${drugIdentity} Drug Information`,
      url: `https://reference.medscape.com/drug/${drugIdentity.toLowerCase()}`,
      publisher: "Medscape",
      retrievedAt: "2026-08-20T10:00:00.000Z",
      contentDate: "2026-08-19",
      sha256: sha256(artifact),
      parserVersion: MEDSCAPE_PARSER_VERSION,
      transformVersion: DDI_TRANSFORM_VERSION,
      reviewerId: "reviewer-1",
      reviewedAt: "2026-08-21T10:00:00.000Z",
      reviewReference: `review://ddi/${drugIdentity}`,
      permission: {
        status: "granted",
        basis: "Synthetic permission fixture",
        recordReference: "legal://permission/1",
        coversStorage: true,
        coversTransformation: true,
        coversResearchUse: true,
      },
      lifecycle: "quarantined",
    },
  };
}

async function activate(pool, administrator, artifactRoot, input) {
  const imported = await importDdiSource(pool, administrator, input, { artifactRoot });
  await reviewDdiSource(pool, administrator, imported.id, "reviewed", "review://accepted");
  return activateDdiSource(pool, administrator, imported.id, {
    legalApprovalReference: "legal://approval/1",
    clinicalApprovalReference: "clinical://approval/1",
  });
}

test("DDI MCP persists exact immutable executions and fails closed on source defects", async () => {
  assert.ok(adminConnectionString, "TEST_DATABASE_URL is required.");
  const artifactRoot = await mkdtemp(join(tmpdir(), "insight-ddi-evaluation-"));
  try {
    await withIsolatedTestDatabase(adminConnectionString, async (connectionString) => {
      const pool = createPostgresPool({ connectionString });
      try {
        await migrateToHead(pool);
        const administrator = await createUser(pool, {
          username: "DdiEvaluationAdministrator",
          password: "ddi-evaluation-admin-password",
          role: "ADMINISTRATOR",
        });
        const psychiatrist = await createUser(pool, {
          username: "DdiEvaluationPsychiatrist",
          password: "ddi-evaluation-psychiatrist-password",
          role: "PSYCHIATRIST",
        });
        const synthetic = makeSyntheticPatientIdentity(952);
        const created = await createOrOverwritePatient(
          pool,
          psychiatrist,
          {
            officialIdentifier: {
              type: identifierConfiguration.type,
              issuingAuthority: identifierConfiguration.issuingAuthority,
              value: synthetic.officialIdentifier,
            },
            firstName: synthetic.firstName,
            lastName: "DdiEvaluation",
            dateOfBirth: synthetic.birthDate,
            sex: synthetic.sex,
          },
          identifierConfiguration,
          "00000000-0000-4000-8000-000000000952",
        );
        const researchCaseId = created.patient.researchCase.id;
        const revision = (
          await pool.query(
            "SELECT workflow_revision,input_revision FROM insight.research_cases WHERE id=$1",
            [researchCaseId],
          )
        ).rows[0];
        await activate(
          pool,
          administrator,
          artifactRoot,
          sourceInput(
            "DRUG-A",
            "DRUG-B",
            "Mechanism: CYP inhibition; Effect: increased exposure; Action: monitor closely",
          ),
        );
        await activate(
          pool,
          administrator,
          artifactRoot,
          sourceInput("DRUG-B", "DRUG-X", "No interaction with tested pair"),
        );
        const execution = (toolExecutionId) => ({
          toolExecutionId,
          researchCaseId,
          requestedByUserId: psychiatrist.id,
          workflowRevision: Number(revision.workflow_revision),
          inputRevision: Number(revision.input_revision),
        });

        const gateway = new InternalMcpGateway(
          createDdiToolHandlers(
            pool,
            async (context) => execution(context.executionId),
            async () => regimen,
          ),
          () => new Date("2026-08-23T12:00:00.000Z"),
        );
        const context = {
          executionId: "ddi-primary-tool-execution",
          jobId: "ddi-primary-job",
          subjectRef: "ddi-primary-subject",
          researchCaseRevision: Number(revision.workflow_revision),
          workflowState: "CHECKING_PRIMARY_DDI",
          actorRole: "PSYCHIATRIST",
          allowedToolNames: ["ddi.evaluate_regimen"],
          idempotencyKey: "ddi-primary-key",
        };
        const primary = await gateway.invoke(context, {
          name: "ddi.evaluate_regimen",
          input: { purpose: "PRIMARY_FILTER", medicationEntryRefs: refs },
        });
        assert.equal(primary.ok, true);
        assert.deepEqual(primary.data.excludedCanonicalIds, ["DRUG-A", "DRUG-B"]);
        assert.equal(primary.data.omittedPairCount, 1);
        assert.deepEqual(primary.data.findings[0], {
          leftCanonicalId: "DRUG-A",
          rightCanonicalId: "DRUG-B",
          severity: "serious",
          mechanism: "CYP inhibition",
          clinicalEffect: "increased exposure",
          recommendedAction: "monitor closely",
          sourceRecordRef: primary.data.findings[0].sourceRecordRef,
        });
        assert.equal(primary.warnings[0].code, "UNKNOWN_MEDICATIONS_OMITTED");
        const wrongPurpose = await gateway.invoke(context, {
          name: "ddi.evaluate_regimen",
          input: { purpose: "FINAL_RECHECK", medicationEntryRefs: refs },
        });
        assert.equal(wrongPurpose.ok, false);
        assert.equal(wrongPurpose.error.code, "INVALID_TOOL_INPUT");

        const final = await evaluateDdiRegimen(
          pool,
          execution("ddi-final-tool-execution"),
          "FINAL_RECHECK",
          refs,
          regimen,
        );
        assert.deepEqual(final.excludedCanonicalIds, []);
        assert.equal(final.findings.length, 1);
        assert.equal(final.omittedPairCount, 2);
        const unknownOnly = await evaluateDdiRegimen(
          pool,
          execution("ddi-unknown-only"),
          "FINAL_RECHECK",
          ["unknown-1", "unknown-2"],
          [
            {
              medicationEntryRef: "unknown-1",
              kind: "CURRENT",
              normalizationState: "UNKNOWN",
            },
            {
              medicationEntryRef: "unknown-2",
              kind: "PROPOSED",
              normalizationState: "UNKNOWN",
            },
          ],
        );
        assert.equal(unknownOnly.omittedPairCount, 1);
        assert.deepEqual(unknownOnly.evaluatedCanonicalIds, []);

        await assert.rejects(
          () => pool.query("UPDATE insight.ddi_executions SET omitted_pair_count=0"),
          /immutable/,
        );
        await assert.rejects(
          () =>
            evaluateDdiRegimen(
              pool,
              execution("ddi-disabled-source"),
              "FINAL_RECHECK",
              ["current-1"],
              [
                {
                  medicationEntryRef: "current-1",
                  kind: "CURRENT",
                  normalizationState: "NORMALIZED",
                  canonicalId: "DRUG-MISSING",
                },
              ],
            ),
          (error) => error instanceof McpToolError && error.code === "DDI_SOURCE_DISABLED",
        );

        await pool.query(
          "ALTER TABLE insight.ddi_source_versions DISABLE TRIGGER ddi_source_versions_immutable",
        );
        await pool.query(
          `UPDATE insight.ddi_source_versions
           SET interactions=jsonb_set(interactions,'{0,evidenceReference,sourceSha256}',to_jsonb($1::text))
           WHERE drug_identity='DRUG-A'`,
          ["0".repeat(64)],
        );
        await pool.query(
          "ALTER TABLE insight.ddi_source_versions ENABLE TRIGGER ddi_source_versions_immutable",
        );
        await assert.rejects(
          () =>
            evaluateDdiRegimen(
              pool,
              execution("ddi-provenance-mismatch"),
              "FINAL_RECHECK",
              refs,
              regimen,
            ),
          (error) => error instanceof McpToolError && error.code === "PROVENANCE_MISMATCH",
        );
      } finally {
        await pool.end();
      }
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

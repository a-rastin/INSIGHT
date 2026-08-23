import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InternalMcpGateway,
  McpToolError,
  MODEL_TOOL_NAMES,
  TOOL_ERROR_CODES,
} from "../.tsbuild/server/index.js";
import { stableSerialize } from "../packages/contracts/dist/index.js";

const fixedNow = new Date("2026-08-23T12:00:00.000Z");

function context(workflowState = "NORMALIZING_MEDICATIONS", allowedToolNames = MODEL_TOOL_NAMES) {
  return {
    executionId: "execution-1",
    jobId: "job-1",
    subjectRef: "abcdefghijklmnopqrstuvwx",
    researchCaseRevision: 7,
    workflowState,
    actorRole: "PSYCHIATRIST",
    allowedToolNames,
    idempotencyKey: "idempotency-1",
  };
}

const searchInput = { medicationEntryRef: "current-1", query: "risperidone" };
const searchOutput = {
  catalogVersion: "catalog-2026.08",
  candidates: [
    {
      canonicalId: "rx-risperidone",
      preferredName: "Risperidone",
      synonyms: ["Risperdal"],
    },
  ],
};

const hash = (value) => createHash("sha256").update(stableSerialize(value)).digest("hex");

test("registers exactly nine tools across all six namespaces and filters them by state", () => {
  assert.deepEqual(new Set(MODEL_TOOL_NAMES), new Set([
    "research_case.get_context",
    "assessment.submit_imputation",
    "medication.search_candidates",
    "medication.commit_mapping",
    "ddi.evaluate_regimen",
    "bn.get_routed_contracts",
    "bn.submit_cpt_snapshot",
    "bn.run_inference",
    "treatment_plan.submit_primary",
  ]));
  assert.deepEqual(
    new InternalMcpGateway({}).listTools(context()).map(({ name }) => name),
    ["research_case.get_context", "medication.search_candidates", "medication.commit_mapping"],
  );
  assert.deepEqual(new InternalMcpGateway({}).listTools(context("FINALIZED")), []);
});

test("successful calls hash validated input and output and pin tool and knowledge versions", async () => {
  let receivedContext;
  const gateway = new InternalMcpGateway(
    {
      "medication.search_candidates": (trusted) => {
        receivedContext = trusted;
        return {
          data: searchOutput,
          knowledgeVersions: ["terminology:42"],
          warnings: [{ code: "CATALOG_NOTE", safeMessage: "One synonym omitted." }],
        };
      },
    },
    () => fixedNow,
  );
  const trusted = context();
  const result = await gateway.invoke(trusted, {
    name: "medication.search_candidates",
    input: searchInput,
  });

  assert.equal(receivedContext, trusted);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, searchOutput);
  assert.equal(result.provenance.toolName, "medication.search_candidates");
  assert.equal(result.provenance.toolVersion, "1.0.0");
  assert.equal(result.provenance.inputHash, hash(searchInput));
  assert.equal(result.provenance.outputHash, hash(searchOutput));
  assert.deepEqual(result.provenance.knowledgeVersions, [
    "terminology:42",
    "catalogVersion:catalog-2026.08",
  ]);
  assert.equal(result.provenance.executedAt, fixedNow.toISOString());
});

test("forged trusted fields are rejected before a domain handler runs", async () => {
  let calls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      calls += 1;
      return { data: searchOutput };
    },
  });
  for (const field of [
    "executionId",
    "jobId",
    "subjectRef",
    "researchCaseRevision",
    "workflowState",
    "actorRole",
    "allowedToolNames",
    "idempotencyKey",
  ]) {
    const nested = await gateway.invoke(context(), {
      name: "medication.search_candidates",
      input: { ...searchInput, nested: { [field]: "forged" } },
    });
    assert.equal(nested.ok, false, field);
    assert.equal(nested.error.code, "INVALID_TOOL_INPUT", field);

    const envelope = await gateway.invoke(context(), {
      name: "medication.search_candidates",
      input: searchInput,
      [field]: "forged",
    });
    assert.equal(envelope.ok, false, field);
    assert.equal(envelope.error.code, "INVALID_TOOL_INPUT", field);
  }
  assert.equal(calls, 0);
});

test("nested schema-invalid inputs and outputs never cross their boundary", async () => {
  let inputCalls = 0;
  const invalidInputGateway = new InternalMcpGateway({
    "treatment_plan.submit_primary": () => {
      inputCalls += 1;
      return { data: { draftRef: "draft-1", draftRevision: 1, aiImputationNoticeVisible: false } };
    },
  });
  const invalidInput = await invalidInputGateway.invoke(context("GENERATING_PRIMARY_PLAN"), {
    name: "treatment_plan.submit_primary",
    input: {
      schemaVersion: "1",
      regimen: [{
        canonicalMedicationId: "rx-one",
        dose: { value: 1, unit: "mg", forged: true },
        route: "oral",
        frequency: "daily",
        monitoring: [],
        rationale: [{ kind: "BN", sourceRef: "source-1", text: "Reason" }],
        warningRefs: [],
      }],
      generalMonitoring: [],
      explanation: "Draft explanation",
      sourceExecutionRefs: ["source-1"],
    },
  });
  assert.equal(invalidInput.ok, false);
  assert.equal(invalidInput.error.code, "INVALID_TOOL_INPUT");
  assert.equal(inputCalls, 0);

  const invalidOutputGateway = new InternalMcpGateway({
    "medication.search_candidates": () => ({
      data: {
        ...searchOutput,
        candidates: [{ ...searchOutput.candidates[0], backendRecord: { id: "internal" } }],
      },
    }),
  });
  const invalidOutput = await invalidOutputGateway.invoke(context(), {
    name: "medication.search_candidates",
    input: searchInput,
  });
  assert.equal(invalidOutput.ok, false);
  assert.equal(invalidOutput.error.code, "PROVENANCE_MISMATCH");
});

test("arbitrary records, SQL, and paths are blocked before domain execution", async () => {
  let calls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      calls += 1;
      return { data: searchOutput };
    },
  });
  for (const input of [
    { ...searchInput, records: ["patient"] },
    { ...searchInput, query: "SELECT name FROM medications" },
    { ...searchInput, query: "/etc/passwd" },
    { ...searchInput, query: "C:\\Windows\\System32" },
  ]) {
    const result = await gateway.invoke(context(), {
      name: "medication.search_candidates",
      input,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  }
  assert.equal(calls, 0);
});

test("every backend-only command class is absent and rejected before domain execution", async () => {
  const gateway = new InternalMcpGateway({});
  const prohibited = {
    patientMutation: "patient.create",
    officialIdentifier: "official_identifier.reveal",
    userAdministration: "user.reset_password",
    authentication: "auth.assign_role",
    knowledgeActivation: "knowledge.activate",
    modelActivation: "bn.activate_model",
    endpointCredentials: "model_endpoint.configure_credentials",
    backupRestore: "backup.restore",
    workflowMutation: "workflow.change_state",
    clinicianApproval: "treatment_plan.approve_edits",
    finalization: "treatment_plan.finalize",
    supersession: "treatment_plan.supersede",
    hardDeletion: "patient.hard_delete",
    auditRead: "audit.read_clinical_history",
  };
  for (const [commandClass, name] of Object.entries(prohibited)) {
    assert.equal(MODEL_TOOL_NAMES.includes(name), false, commandClass);
    const result = await gateway.invoke(context(), { name, input: {} });
    assert.equal(result.ok, false, commandClass);
    assert.equal(result.error.code, "TOOL_NOT_ALLOWED_IN_STATE", commandClass);
  }
});

test("model cannot name a Bayesian model or pathway", async () => {
  let calls = 0;
  const gateway = new InternalMcpGateway({
    "bn.get_routed_contracts": () => {
      calls += 1;
      return { data: [] };
    },
  });
  for (const input of [
    { modelRef: "model-pharmacotherapy-v1" },
    { pathwayIdentity: "PHARMACOTHERAPY" },
  ]) {
    const result = await gateway.invoke(context("GENERATING_CPTS"), {
      name: "bn.get_routed_contracts",
      input,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  }
  assert.equal(calls, 0);
});

test("all contract error codes map to fixed retryability and sanitized messages", async () => {
  const retryable = new Set([
    "DEPENDENCY_UNAVAILABLE",
    "CPT_VALIDATION_FAILED",
    "PLAN_SCHEMA_INVALID",
    "MODEL_ENDPOINT_FAILED",
  ]);
  let code = "DEPENDENCY_UNAVAILABLE";
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      throw new McpToolError(code, { nodeRef: "node-1", reason: "Dimension mismatch" });
    },
  });

  for (const errorCode of TOOL_ERROR_CODES) {
    code = errorCode;
    const result = await gateway.invoke(context(), {
      name: "medication.search_candidates",
      input: searchInput,
    });
    assert.equal(result.ok, false, errorCode);
    assert.equal(result.error.code, errorCode, errorCode);
    assert.equal(result.error.retryable, retryable.has(errorCode), errorCode);
    assert.equal(JSON.stringify(result).includes("Jane Doe"), false, errorCode);
  }
});

test("raw exceptions and sensitive identifiers never enter model-visible results", async () => {
  const exceptionGateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      throw new Error("SELECT * FROM patients at /srv/private Jane Doe 9988776655");
    },
  });
  const exception = await exceptionGateway.invoke(context(), {
    name: "medication.search_candidates",
    input: searchInput,
  });
  assert.deepEqual(exception, {
    ok: false,
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
      safeMessage: "A required dependency is unavailable.",
    },
  });

  const leakGateway = new InternalMcpGateway({
    "medication.search_candidates": () => ({
      data: {
        ...searchOutput,
        candidates: [{
          ...searchOutput.candidates[0],
          preferredName: "Jane Doe",
          synonyms: ["11111111-1111-4111-8111-111111111111"],
        }],
      },
      sensitiveValues: ["Jane Doe", "9988776655"],
    }),
  });
  const leak = await leakGateway.invoke(context(), {
    name: "medication.search_candidates",
    input: searchInput,
  });
  assert.equal(leak.ok, false);
  assert.equal(leak.error.code, "PROVENANCE_MISMATCH");
  assert.equal(JSON.stringify(leak).includes("Jane"), false);
  assert.equal(JSON.stringify(leak).includes("11111111"), false);
});

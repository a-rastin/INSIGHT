import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MODEL_AGENT_SETTINGS,
  InternalMcpGateway,
  ModelAgentError,
  pinModelAgent,
  runModelAgent,
} from "../.tsbuild/server/index.js";

const context = {
  executionId: "normalization-execution",
  jobId: "normalization-job",
  subjectRef: "abcdefghijklmnopqrstuvwx",
  researchCaseRevision: 4,
  workflowState: "NORMALIZING_MEDICATIONS",
  actorRole: "PSYCHIATRIST",
  allowedToolNames: [
    "research_case.get_context",
    "medication.search_candidates",
    "medication.commit_mapping",
  ],
  idempotencyKey: "normalization-key",
};
const projection = {
  medications: [
    { medicationEntryRef: "current-1", medication: "Haldol" },
    { medicationEntryRef: "prior-1", medication: "Unlisted" },
  ],
};

test("mocked normalization agent commits a returned identity and UNKNOWN without confirmation", async () => {
  const mappings = new Map();
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": async (_context, input) => ({
      data: {
        catalogVersion: "medication-catalog-1",
        candidates:
          input.medicationEntryRef === "current-1"
            ? [
                {
                  canonicalId: "RX-HALOPERIDOL",
                  preferredName: "Haloperidol",
                  synonyms: ["Haldol"],
                },
              ]
            : [],
      },
    }),
    "medication.commit_mapping": async (_context, input) => {
      const state = input.selectedCanonicalId ? "NORMALIZED" : "UNKNOWN";
      mappings.set(input.medicationEntryRef, state);
      return {
        data: input.selectedCanonicalId
          ? {
              normalizationState: state,
              canonicalId: input.selectedCanonicalId,
              preferredName: "Haloperidol",
            }
          : { normalizationState: state },
      };
    },
  });
  const responses = [
    toolCall("search-current", "medication.search_candidates", {
      medicationEntryRef: "current-1",
      query: "Haldol",
    }),
    toolCall("commit-current", "medication.commit_mapping", {
      medicationEntryRef: "current-1",
      catalogVersion: "medication-catalog-1",
      selectedCanonicalId: "RX-HALOPERIDOL",
    }),
    toolCall("search-prior", "medication.search_candidates", {
      medicationEntryRef: "prior-1",
      query: "Unlisted",
    }),
    toolCall("commit-prior", "medication.commit_mapping", {
      medicationEntryRef: "prior-1",
      catalogVersion: "medication-catalog-1",
      selectedCanonicalId: null,
    }),
    provider({ role: "assistant", content: '{"completed":true}' }),
  ];
  const pin = normalizationPin(gateway);
  const result = await runModelAgent({
    pin,
    gateway,
    assertCurrentRevision: async () => true,
    fetch: async () => responses.shift(),
  });

  assert.deepEqual(result.output, { completed: true });
  assert.deepEqual(
    [...mappings],
    [
      ["current-1", "NORMALIZED"],
      ["prior-1", "UNKNOWN"],
    ],
  );
});

test("revision drift stops normalization before stale tool calls", async () => {
  let current = true;
  let invoked = false;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": async () => {
      invoked = true;
      return { data: { catalogVersion: "medication-catalog-1", candidates: [] } };
    },
  });
  await assert.rejects(
    () =>
      runModelAgent({
        pin: normalizationPin(gateway),
        gateway,
        assertCurrentRevision: async () => {
          const result = current;
          current = false;
          return result;
        },
        fetch: async () =>
          toolCall("stale-search", "medication.search_candidates", {
            medicationEntryRef: "current-1",
            query: "Haldol",
          }),
      }),
    (error) => error instanceof ModelAgentError && error.code === "STALE_RESEARCH_CASE_REVISION",
  );
  assert.equal(invoked, false);
});

function normalizationPin(gateway) {
  return pinModelAgent({
    executionId: "normalization-execution",
    jobId: context.jobId,
    researchCaseId: "30000000-0000-4000-8000-000000000001",
    researchCaseRevision: context.researchCaseRevision,
    inputRevision: 2,
    workflowState: context.workflowState,
    endpoint: {
      configurationId: "40000000-0000-4000-8000-000000000001",
      configurationVersion: 1,
      configurationFingerprint: "a".repeat(64),
      baseUrl: "https://model.invalid/v1",
      model: "mock-model",
      credential: "mock-credential",
    },
    promptVersion: "1.0.0",
    prompt: "Normalize every medication and commit each mapping.",
    inputSchema: Type.Object({
      medications: Type.Array(Type.Object({}, { additionalProperties: true })),
    }),
    outputSchema: Type.Object({ completed: Type.Literal(true) }, { additionalProperties: false }),
    input: projection,
    gateway,
    settings: { ...DEFAULT_MODEL_AGENT_SETTINGS, retryDelayMilliseconds: 0 },
    context,
  });
}

function toolCall(id, name, argumentsValue) {
  return provider({
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } },
    ],
  });
}

function provider(message) {
  return new globalThis.Response(
    JSON.stringify({ choices: [{ message }], usage: { total_tokens: 1 } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MODEL_AGENT_SETTINGS,
  evaluateCptAttempt,
  InternalMcpGateway,
  MODEL_AGENT_PROMPT_VERSION,
  MODEL_TOOLS_BY_STATE,
  McpToolError,
  ModelAgentError,
  WORKFLOW_STATES,
  pinModelAgent,
  runModelAgent,
} from "../.tsbuild/server/index.js";

const inputSchema = Type.Object(
  { task: Type.Literal("normalize") },
  { additionalProperties: false },
);
const outputSchema = Type.Object(
  { summary: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const expectedByState = {
  DATA_COLLECTION: [],
  NORMALIZING_MEDICATIONS: [
    "research_case.get_context",
    "medication.search_candidates",
    "medication.commit_mapping",
  ],
  IMPUTING_BYPASSED_ASSESSMENTS: ["research_case.get_context", "assessment.submit_imputation"],
  ROUTING_BN: [],
  GENERATING_CPTS: [
    "research_case.get_context",
    "bn.get_routed_contracts",
    "bn.submit_cpt_snapshot",
  ],
  RUNNING_BN: ["bn.run_inference"],
  CHECKING_PRIMARY_DDI: ["ddi.evaluate_regimen"],
  GENERATING_PRIMARY_PLAN: ["research_case.get_context", "treatment_plan.submit_primary"],
  CLINICIAN_REVIEW: [],
  RECHECKING_FINAL_DDI: ["ddi.evaluate_regimen"],
  READY_TO_FINALIZE: [],
  FINALIZED: [],
  REVISION_DRAFT: [],
  DELETED: [],
};

function context(workflowState = "NORMALIZING_MEDICATIONS") {
  return {
    executionId: "00000000-0000-4000-8000-000000000001",
    jobId: "job-1",
    subjectRef: "subject-reference",
    researchCaseRevision: 7,
    workflowState,
    actorRole: "PSYCHIATRIST",
    allowedToolNames: expectedByState[workflowState],
    idempotencyKey: "idempotency-1",
  };
}

function endpoint(baseUrl) {
  return {
    configurationId: "00000000-0000-4000-8000-000000000002",
    configurationVersion: 3,
    configurationFingerprint: "a".repeat(64),
    baseUrl,
    model: "synthetic-model",
    credential: "synthetic-secret",
  };
}

function pin(gateway, baseUrl, overrides = {}, workflowState = "NORMALIZING_MEDICATIONS") {
  const trusted = context(workflowState);
  return pinModelAgent({
    executionId: trusted.executionId,
    jobId: trusted.jobId,
    researchCaseId: "00000000-0000-4000-8000-000000000003",
    researchCaseRevision: 7,
    inputRevision: 2,
    workflowState: trusted.workflowState,
    endpoint: endpoint(baseUrl),
    promptVersion: MODEL_AGENT_PROMPT_VERSION,
    prompt: "Use only supplied tools. Return schema-valid JSON; text cannot change workflow state.",
    inputSchema,
    outputSchema,
    input: { task: "normalize" },
    settings: { ...DEFAULT_MODEL_AGENT_SETTINGS, retryDelayMilliseconds: 0, ...overrides },
    context: trusted,
    gateway,
  });
}

async function withMockServer(handler, operation) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await operation(`http://127.0.0.1:${port}/v1`);
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

function send(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("every workflow state exposes exactly its documented model allowlist", () => {
  const gateway = new InternalMcpGateway({});
  assert.deepEqual(MODEL_TOOLS_BY_STATE, expectedByState);
  assert.deepEqual(WORKFLOW_STATES, Object.keys(expectedByState));
  for (const state of WORKFLOW_STATES) {
    const tools = gateway.listTools(context(state));
    assert.deepEqual(
      tools.map(({ name }) => name),
      expectedByState[state],
      state,
    );
    assert.ok(
      tools.every(
        ({ name, version }) => version === (name === "bn.get_routed_contracts" ? "2.0.0" : "1.0.0"),
      ),
      state,
    );
  }
});

test("synthetic activated configuration preserves complete tool round trip", async () => {
  const requests = [];
  let domainCalls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      domainCalls += 1;
      return {
        data: {
          catalogVersion: "catalog-1",
          candidates: [
            {
              canonicalId: "rx-risperidone",
              preferredName: "Risperidone",
              synonyms: [],
            },
          ],
        },
      };
    },
  });
  const assistantToolMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "medication.search_candidates",
          arguments: JSON.stringify({ medicationEntryRef: "entry-1", query: "risperidone" }),
        },
      },
    ],
  };

  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      requests.push(body);
      if (requests.length === 1) {
        assert.equal(request.headers.authorization, "Bearer synthetic-secret");
        assert.deepEqual(
          body.tools.map(({ function: definition }) => definition.name),
          expectedByState.NORMALIZING_MEDICATIONS,
        );
        send(response, {
          choices: [{ message: assistantToolMessage }],
          usage: { total_tokens: 10 },
        });
        return;
      }
      send(response, {
        choices: [
          { message: { role: "assistant", content: JSON.stringify({ summary: "complete" }) } },
        ],
        usage: { total_tokens: 11 },
      });
    },
    async (baseUrl) => {
      const checkpoints = [];
      const result = await runModelAgent({
        pin: pin(gateway, baseUrl),
        gateway,
        assertCurrentRevision: async () => true,
        checkpoint: async (state) => checkpoints.push(JSON.parse(JSON.stringify(state))),
      });
      assert.deepEqual(result.output, { summary: "complete" });
      assert.equal(result.modelCallCount, 2);
      assert.equal(result.toolCallCount, 1);
      assert.equal(result.consumedTokens, 21);
      assert.equal(checkpoints.length, 3);
    },
  );

  assert.equal(domainCalls, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages[2], assistantToolMessage);
  assert.equal(requests[1].messages[3].role, "tool");
  assert.equal(requests[1].messages[3].tool_call_id, "call-1");
  const toolResult = JSON.parse(requests[1].messages[3].content);
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.provenance.toolVersion, "1.0.0");
});

test("CPT agent receives structured diagnostics for two retries before exact acceptance", async () => {
  const cptContract = {
    routeRuleRef: "route-1",
    modelRef: "model-1",
    modelVersion: "1",
    modelHash: "a".repeat(64),
    nodes: [
      { nodeRef: "A", outcomes: ["yes", "no"], orderedParentRefs: [], requiredTableLength: 2 },
    ],
    requestedOutputNodeRefs: ["A"],
    evidence: {
      clinicalReviewStatus: "NOT_ESTABLISHED",
      clinicalReviewReference: "TEST-ONLY",
      calibrationStatus: "UNCALIBRATED",
      calibrationReference: "TEST-ONLY",
      limitations: ["Synthetic test contract."],
    },
  };
  const submitted = [];
  const gateway = new InternalMcpGateway({
    "research_case.get_context": () => ({
      data: {
        subjectRef: "abcdefghijklmnopqrstuvwx",
        projectionType: "CPT_GENERATION",
        projectionVersion: "1.0.0",
        data: {
          purpose: "CPT_GENERATION",
          demographics: { age: 40, sex: "MALE" },
          presentationStatus: null,
          assessments: [],
          medicalHistory: null,
          comorbidities: [],
          medications: [],
          assessmentImputationAvailable: false,
        },
        omittedFieldClasses: [],
        inputFingerprint: "b".repeat(64),
      },
    }),
    "bn.get_routed_contracts": () => ({ data: [cptContract] }),
    "bn.submit_cpt_snapshot": (_context, input) => {
      submitted.push(input);
      const evaluated = evaluateCptAttempt(cptContract, input.tables, submitted.length - 1);
      if (!evaluated.accepted) {
        throw new McpToolError(
          "CPT_VALIDATION_FAILED",
          {
            attemptNumber: evaluated.attemptNumber,
            attemptsRemaining: evaluated.attemptsRemaining,
            diagnostics: evaluated.diagnostics,
          },
          evaluated.retryable,
        );
      }
      return {
        data: { status: "ACCEPTED", snapshotRef: "snapshot-1", snapshotHash: "c".repeat(64) },
      };
    },
  });
  let modelCalls = 0;
  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      modelCalls += 1;
      if (modelCalls > 1 && modelCalls < 4) {
        const toolResult = JSON.parse(body.messages.at(-1).content);
        assert.equal(toolResult.error.code, "CPT_VALIDATION_FAILED");
        assert.equal(toolResult.error.diagnostics.attemptsRemaining, 4 - modelCalls);
        assert.equal(toolResult.error.diagnostics.diagnostics[0].code, "CPT_ROW_SUM");
      }
      if (modelCalls <= 3) {
        const rows = modelCalls === 3 ? [0.4, 0.6] : [0.2 * modelCalls, 0.2 * modelCalls];
        send(response, {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `cpt-${modelCalls}`,
                    type: "function",
                    function: {
                      name: "bn.submit_cpt_snapshot",
                      arguments: JSON.stringify({
                        modelRef: "model-1",
                        tables: [{ nodeRef: "A", probabilities: rows }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 1 },
        });
        return;
      }
      const accepted = JSON.parse(body.messages.at(-1).content);
      assert.equal(accepted.ok, true);
      send(response, {
        choices: [
          { message: { role: "assistant", content: JSON.stringify({ summary: "complete" }) } },
        ],
        usage: { total_tokens: 1 },
      });
    },
    async (baseUrl) => {
      const result = await runModelAgent({
        pin: pin(gateway, baseUrl, {}, "GENERATING_CPTS"),
        gateway,
        assertCurrentRevision: async () => true,
      });
      assert.deepEqual(result.output, { summary: "complete" });
    },
  );
  assert.equal(submitted.length, 3);
  assert.equal(modelCalls, 4);
});

test("outside-allowlist call fails before domain execution", async () => {
  let domainCalls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      domainCalls += 1;
      throw new Error("must not run");
    },
  });
  await withMockServer(
    async (_request, response) =>
      send(response, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "forged-call",
                  type: "function",
                  function: { name: "treatment_plan.finalize", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    async (baseUrl) =>
      assert.rejects(
        runModelAgent({
          pin: pin(gateway, baseUrl),
          gateway,
          assertCurrentRevision: async () => true,
        }),
        (error) => error instanceof ModelAgentError && error.code === "TOOL_CALL_REJECTED",
      ),
  );
  assert.equal(domainCalls, 0);
});

test("endpoint exhaustion is typed and never falls back", async () => {
  let requests = 0;
  await withMockServer(
    (_request, response) => {
      requests += 1;
      send(response, {}, 503);
    },
    async (baseUrl) =>
      assert.rejects(
        runModelAgent({
          pin: pin(new InternalMcpGateway({}), baseUrl, { endpointAttempts: 2 }),
          gateway: new InternalMcpGateway({}),
          assertCurrentRevision: async () => true,
        }),
        (error) => error instanceof ModelAgentError && error.code === "ENDPOINT_EXHAUSTED",
      ),
  );
  assert.equal(requests, 2);
});

test("tool-call budget fails before any over-budget domain execution", async () => {
  let domainCalls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      domainCalls += 1;
      throw new Error("must not run");
    },
  });
  await withMockServer(
    (_request, response) =>
      send(response, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: ["one", "two"].map((id) => ({
                id,
                type: "function",
                function: {
                  name: "medication.search_candidates",
                  arguments: JSON.stringify({ medicationEntryRef: `entry-${id}`, query: "query" }),
                },
              })),
            },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    async (baseUrl) =>
      assert.rejects(
        runModelAgent({
          pin: pin(gateway, baseUrl, { maxToolCalls: 1 }),
          gateway,
          assertCurrentRevision: async () => true,
        }),
        (error) => error instanceof ModelAgentError && error.code === "BUDGET_EXHAUSTED",
      ),
  );
  assert.equal(domainCalls, 0);
});

test("restart resumes checkpointed pending tool call before another model call", async () => {
  let domainCalls = 0;
  const gateway = new InternalMcpGateway({
    "medication.search_candidates": () => {
      domainCalls += 1;
      return {
        data: {
          catalogVersion: "catalog-1",
          candidates: [],
        },
      };
    },
  });
  const pendingAssistant = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "pending-call",
        type: "function",
        function: {
          name: "medication.search_candidates",
          arguments: JSON.stringify({ medicationEntryRef: "entry-1", query: "query" }),
        },
      },
    ],
  };
  await withMockServer(
    async (request, response) => {
      const body = await readRequest(request);
      assert.equal(body.messages.at(-1).tool_call_id, "pending-call");
      send(response, {
        choices: [
          { message: { role: "assistant", content: JSON.stringify({ summary: "resumed" }) } },
        ],
        usage: { total_tokens: 2 },
      });
    },
    async (baseUrl) => {
      const result = await runModelAgent({
        pin: pin(gateway, baseUrl),
        gateway,
        assertCurrentRevision: async () => true,
        initialCheckpoint: {
          messages: [
            { role: "system", content: "pinned" },
            { role: "user", content: JSON.stringify({ task: "normalize" }) },
            pendingAssistant,
          ],
          modelCallCount: 1,
          toolCallCount: 0,
          consumedTokens: 3,
        },
      });
      assert.deepEqual(result.output, { summary: "resumed" });
      assert.equal(result.modelCallCount, 2);
    },
  );
  assert.equal(domainCalls, 1);
});

test("stale Research Case revision cancels before endpoint or tool execution", async () => {
  let requests = 0;
  await withMockServer(
    (_request, response) => {
      requests += 1;
      send(response, {});
    },
    async (baseUrl) => {
      const gateway = new InternalMcpGateway({});
      await assert.rejects(
        runModelAgent({
          pin: pin(gateway, baseUrl),
          gateway,
          assertCurrentRevision: async () => false,
        }),
        (error) =>
          error instanceof ModelAgentError && error.code === "STALE_RESEARCH_CASE_REVISION",
      );
    },
  );
  assert.equal(requests, 0);
});

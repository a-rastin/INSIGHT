import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { stableSerialize, type JsonValue } from "@insight/contracts";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { Pool, QueryResultRow } from "pg";

import type { TrustedToolContext } from "../deidentification/gateway.js";
import {
  MODEL_COMPATIBILITY_TEST_VERSION,
  modelChatCompletionsUrl,
  type ActiveModelEndpoint,
} from "../model-endpoint/configuration.js";
import { MODEL_TOOLS_BY_STATE } from "../patient/workflow.js";
import { InternalMcpGateway, type ModelToolDefinition } from "./gateway.js";

export const MODEL_AGENT_PROMPT_VERSION = "1.0.0";

export type ModelAgentFailureCode =
  | "BUDGET_EXHAUSTED"
  | "ENDPOINT_EXHAUSTED"
  | "FINAL_SCHEMA_INVALID"
  | "MALFORMED_MODEL_RESPONSE"
  | "STALE_RESEARCH_CASE_REVISION"
  | "TOOL_CALL_REJECTED";

const SAFE_MESSAGES: Readonly<Record<ModelAgentFailureCode, string>> = Object.freeze({
  BUDGET_EXHAUSTED: "Model agent execution budget was exhausted.",
  ENDPOINT_EXHAUSTED: "Pinned model endpoint attempts were exhausted.",
  FINAL_SCHEMA_INVALID: "Model final output did not match the pinned schema.",
  MALFORMED_MODEL_RESPONSE: "Model endpoint returned an invalid response.",
  STALE_RESEARCH_CASE_REVISION: "Research Case revision changed during execution.",
  TOOL_CALL_REJECTED: "Model tool call was rejected.",
});
const MAX_TOOL_ARGUMENT_BYTES = 65_536;
const MAX_MODEL_JSON_DEPTH = 32;
const MAX_MODEL_JSON_NODES = 10_000;

export class ModelAgentError extends Error {
  constructor(readonly code: ModelAgentFailureCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "ModelAgentError";
  }
}

class ModelAgentClaimLostError extends Error {}

interface ModelAgentClaimFence {
  readonly leaseOwner: string;
  readonly attempt: number;
}

export interface ModelAgentSettings {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxResponseBytes: number;
  readonly endpointAttempts: number;
  readonly timeoutMilliseconds: number;
  readonly retryDelayMilliseconds: number;
}

export const DEFAULT_MODEL_AGENT_SETTINGS: ModelAgentSettings = Object.freeze({
  maxModelCalls: 12,
  maxToolCalls: 24,
  maxTotalTokens: 100_000,
  maxOutputTokensPerCall: 8_000,
  maxResponseBytes: 1_000_000,
  endpointAttempts: 3,
  timeoutMilliseconds: 30_000,
  retryDelayMilliseconds: 250,
});

export type PinnedModelEndpoint = ActiveModelEndpoint;

interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string | JsonValue };
}

export type ModelProtocolMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly ToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface ModelAgentPin {
  readonly executionId: string;
  readonly jobId: string;
  readonly researchCaseId: string;
  readonly researchCaseRevision: number;
  readonly inputRevision: number;
  readonly workflowState: TrustedToolContext["workflowState"];
  readonly endpoint: PinnedModelEndpoint;
  readonly promptVersion: string;
  readonly prompt: string;
  readonly inputSchema: TSchema;
  readonly outputSchema: TSchema;
  readonly input: JsonValue;
  readonly tools: readonly ModelToolDefinition[];
  readonly settings: ModelAgentSettings;
  readonly context: TrustedToolContext;
}

export interface ModelAgentCheckpoint {
  readonly messages: readonly ModelProtocolMessage[];
  readonly modelCallCount: number;
  readonly toolCallCount: number;
  readonly consumedTokens: number;
}

export interface RunModelAgentOptions {
  readonly pin: ModelAgentPin;
  readonly gateway: InternalMcpGateway;
  readonly assertCurrentRevision: () => Promise<boolean>;
  readonly checkpoint?: (state: ModelAgentCheckpoint) => Promise<void>;
  readonly initialCheckpoint?: ModelAgentCheckpoint;
  readonly fetch?: typeof fetch;
}

export interface ModelAgentSuccess extends ModelAgentCheckpoint {
  readonly output: JsonValue;
}

interface ProviderResponse {
  readonly choices: readonly [{ readonly message: unknown }, ...unknown[]];
  readonly usage: { readonly total_tokens: number };
}

export function pinModelAgent(
  input: Omit<ModelAgentPin, "executionId" | "tools"> & {
    readonly executionId?: string;
    readonly gateway: InternalMcpGateway;
  },
): ModelAgentPin {
  validateSettings(input.settings);
  if (!Value.Check(input.inputSchema, input.input))
    throw new TypeError("Model agent input is invalid.");
  const expected = MODEL_TOOLS_BY_STATE[input.workflowState];
  if (
    input.context.researchCaseRevision !== input.researchCaseRevision ||
    input.context.workflowState !== input.workflowState ||
    stableSerialize(input.context.allowedToolNames as JsonValue) !==
      stableSerialize(expected as JsonValue)
  ) {
    throw new ModelAgentError("STALE_RESEARCH_CASE_REVISION");
  }
  const tools = input.gateway.listTools(input.context);
  if (
    stableSerialize(tools.map(({ name }) => name) as JsonValue) !==
    stableSerialize(expected as JsonValue)
  ) {
    throw new ModelAgentError("TOOL_CALL_REJECTED");
  }
  const { gateway: _gateway, executionId, ...pinned } = input;
  void _gateway;
  return Object.freeze({ ...pinned, executionId: executionId ?? randomUUID(), tools });
}

export async function runModelAgent(options: RunModelAgentOptions): Promise<ModelAgentSuccess> {
  const { pin } = options;
  validatePin(pin, options.gateway);
  if (options.initialCheckpoint) validateCheckpoint(options.initialCheckpoint);
  const state: {
    messages: ModelProtocolMessage[];
    modelCallCount: number;
    toolCallCount: number;
    consumedTokens: number;
  } = options.initialCheckpoint
    ? {
        messages: [...options.initialCheckpoint.messages],
        modelCallCount: options.initialCheckpoint.modelCallCount,
        toolCallCount: options.initialCheckpoint.toolCallCount,
        consumedTokens: options.initialCheckpoint.consumedTokens,
      }
    : {
        messages: [
          { role: "system", content: pin.prompt },
          { role: "user", content: stableSerialize(pin.input) },
        ],
        modelCallCount: 0,
        toolCallCount: 0,
        consumedTokens: 0,
      };

  for (;;) {
    const pendingCalls = pendingToolCalls(state.messages);
    if (pendingCalls.length > 0) {
      if (state.toolCallCount + pendingCalls.length > pin.settings.maxToolCalls) {
        throw new ModelAgentError("BUDGET_EXHAUSTED");
      }
      for (const call of pendingCalls) {
        await assertRevision(options.assertCurrentRevision);
        const toolInput = parseToolArguments(call.function.arguments);
        const result = await options.gateway.invoke(pin.context, {
          name: call.function.name,
          input: toolInput,
        });
        await assertRevision(options.assertCurrentRevision);
        state.toolCallCount += 1;
        if (!result.ok && !result.error.retryable) throw new ModelAgentError("TOOL_CALL_REJECTED");
        state.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stableSerialize(result as unknown as JsonValue),
        });
        await saveCheckpoint(options.checkpoint, state);
      }
      continue;
    }
    await assertRevision(options.assertCurrentRevision);
    if (state.modelCallCount >= pin.settings.maxModelCalls) {
      throw new ModelAgentError("BUDGET_EXHAUSTED");
    }
    const response = await requestModel(pin, state.messages, options.fetch ?? fetch);
    await assertRevision(options.assertCurrentRevision);
    state.modelCallCount += 1;
    state.consumedTokens += response.usage.total_tokens;
    if (state.consumedTokens > pin.settings.maxTotalTokens) {
      throw new ModelAgentError("BUDGET_EXHAUSTED");
    }
    const assistant = parseAssistantMessage(response.choices[0].message);
    state.messages.push(assistant);
    await saveCheckpoint(options.checkpoint, state);

    if (!assistant.tool_calls?.length) {
      const output = parseFinalOutput(assistant.content, pin.outputSchema);
      return { ...state, messages: [...state.messages], output };
    }
    if (state.toolCallCount + assistant.tool_calls.length > pin.settings.maxToolCalls) {
      throw new ModelAgentError("BUDGET_EXHAUSTED");
    }
  }
}

function pendingToolCalls(messages: readonly ModelProtocolMessage[]): readonly ToolCall[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    if (!message.tool_calls?.length) return [];
    const completed = new Set(
      messages
        .slice(index + 1)
        .filter(
          (entry): entry is Extract<ModelProtocolMessage, { role: "tool" }> =>
            entry.role === "tool",
        )
        .map((entry) => entry.tool_call_id),
    );
    return message.tool_calls.filter(({ id }) => !completed.has(id));
  }
  return [];
}

async function requestModel(
  pin: ModelAgentPin,
  messages: readonly ModelProtocolMessage[],
  request: typeof fetch,
): Promise<ProviderResponse> {
  const tools = pin.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  for (let attempt = 1; attempt <= pin.settings.endpointAttempts; attempt += 1) {
    try {
      const response = await request(modelChatCompletionsUrl(pin.endpoint.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${pin.endpoint.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: pin.endpoint.model,
          messages,
          tools,
          tool_choice: tools.length ? "auto" : "none",
          max_tokens: pin.settings.maxOutputTokensPerCall,
        }),
        signal: AbortSignal.timeout(pin.settings.timeoutMilliseconds),
      });
      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt === pin.settings.endpointAttempts) {
          throw new ModelAgentError("ENDPOINT_EXHAUSTED");
        }
      } else {
        const source = await boundedResponseText(response, pin.settings.maxResponseBytes);
        let body: unknown;
        try {
          body = JSON.parse(source) as unknown;
        } catch {
          throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
        }
        if (!isProviderResponse(body)) throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
        return body;
      }
    } catch (error) {
      if (error instanceof ModelAgentError) throw error;
      if (attempt === pin.settings.endpointAttempts)
        throw new ModelAgentError("ENDPOINT_EXHAUSTED");
    }
    if (pin.settings.retryDelayMilliseconds > 0) await delay(pin.settings.retryDelayMilliseconds);
  }
  throw new ModelAgentError("ENDPOINT_EXHAUSTED");
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ModelAgentError("BUDGET_EXHAUSTED");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

function parseAssistantMessage(
  value: unknown,
): Extract<ModelProtocolMessage, { role: "assistant" }> {
  if (!isRecord(value) || value.role !== "assistant")
    throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
  if (value.content !== null && typeof value.content !== "string") {
    throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
  }
  if (value.tool_calls === undefined) return { role: "assistant", content: value.content };
  if (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0) {
    throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
  }
  const calls = value.tool_calls.map((entry): ToolCall => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.type !== "function" ||
      !isRecord(entry.function) ||
      typeof entry.function.name !== "string" ||
      !(typeof entry.function.arguments === "string" || isJsonValue(entry.function.arguments))
    )
      throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
    return {
      id: entry.id,
      type: "function",
      function: { name: entry.function.name, arguments: entry.function.arguments },
    };
  });
  if (new Set(calls.map(({ id }) => id)).size !== calls.length) {
    throw new ModelAgentError("MALFORMED_MODEL_RESPONSE");
  }
  return { role: "assistant", content: value.content, tool_calls: calls };
}

function parseToolArguments(value: string | JsonValue): JsonValue {
  if (typeof value !== "string") {
    if (!isJsonValue(value)) throw new ModelAgentError("TOOL_CALL_REJECTED");
    return value;
  }
  if (Buffer.byteLength(value) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new ModelAgentError("TOOL_CALL_REJECTED");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonValue(parsed)) throw new SyntaxError();
    return parsed;
  } catch {
    throw new ModelAgentError("TOOL_CALL_REJECTED");
  }
}

function parseFinalOutput(content: string | null, schema: TSchema): JsonValue {
  if (content === null) throw new ModelAgentError("FINAL_SCHEMA_INVALID");
  try {
    const output = JSON.parse(content) as unknown;
    if (!isJsonValue(output) || !Value.Check(schema, output)) throw new SyntaxError();
    return output;
  } catch {
    throw new ModelAgentError("FINAL_SCHEMA_INVALID");
  }
}

function validatePin(pin: ModelAgentPin, gateway: InternalMcpGateway): void {
  validateSettings(pin.settings);
  const expected = MODEL_TOOLS_BY_STATE[pin.workflowState];
  const registered = gateway.listTools(pin.context);
  if (
    pin.context.researchCaseRevision !== pin.researchCaseRevision ||
    pin.context.workflowState !== pin.workflowState ||
    stableSerialize(pin.context.allowedToolNames as JsonValue) !==
      stableSerialize(expected as JsonValue) ||
    stableSerialize(pin.tools.map(({ name }) => name) as JsonValue) !==
      stableSerialize(expected as JsonValue) ||
    stableSerialize(pin.tools as unknown as JsonValue) !==
      stableSerialize(registered as unknown as JsonValue)
  )
    throw new ModelAgentError("TOOL_CALL_REJECTED");
}

function validateSettings(settings: ModelAgentSettings): void {
  for (const [key, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value < (key === "retryDelayMilliseconds" ? 0 : 1)) {
      throw new TypeError("Invalid model agent settings.");
    }
  }
}

function validateCheckpoint(checkpoint: ModelAgentCheckpoint): void {
  if (
    !Array.isArray(checkpoint.messages) ||
    !Number.isSafeInteger(checkpoint.modelCallCount) ||
    checkpoint.modelCallCount < 0 ||
    !Number.isSafeInteger(checkpoint.toolCallCount) ||
    checkpoint.toolCallCount < 0 ||
    !Number.isSafeInteger(checkpoint.consumedTokens) ||
    checkpoint.consumedTokens < 0
  )
    throw new ModelAgentError("TOOL_CALL_REJECTED");
  for (const message of checkpoint.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new ModelAgentError("TOOL_CALL_REJECTED");
    }
    if (message.role === "assistant") parseAssistantMessage(message);
    else if (
      (message.role === "system" || message.role === "user") &&
      typeof message.content === "string"
    )
      continue;
    else if (
      message.role === "tool" &&
      typeof message.tool_call_id === "string" &&
      typeof message.content === "string"
    )
      continue;
    else if (message.role !== "assistant") throw new ModelAgentError("TOOL_CALL_REJECTED");
  }
}

async function assertRevision(check: () => Promise<boolean>): Promise<void> {
  if (!(await check())) throw new ModelAgentError("STALE_RESEARCH_CASE_REVISION");
}

async function saveCheckpoint(
  save: RunModelAgentOptions["checkpoint"],
  state: Omit<ModelAgentCheckpoint, "messages"> & { messages: ModelProtocolMessage[] },
): Promise<void> {
  await save?.({ ...state, messages: [...state.messages] });
}

function isProviderResponse(value: unknown): value is ProviderResponse {
  if (!isRecord(value) || !isRecord(value.usage)) return false;
  const totalTokens = value.usage.total_tokens;
  return (
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    isRecord(value.choices[0]) &&
    "message" in value.choices[0] &&
    Number.isSafeInteger(totalTokens) &&
    typeof totalTokens === "number" &&
    totalTokens >= 0
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_MODEL_JSON_NODES || current.depth > MAX_MODEL_JSON_DEPTH) return false;
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    const entries = Array.isArray(current.value)
      ? current.value
      : isRecord(current.value)
        ? Object.values(current.value)
        : null;
    if (!entries) return false;
    for (const entry of entries) pending.push({ value: entry, depth: current.depth + 1 });
  }
  return true;
}

interface ExecutionRow extends QueryResultRow {
  id: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  messages?: ModelProtocolMessage[];
  model_call_count?: number;
  tool_call_count?: number;
  consumed_tokens?: number;
  output?: JsonValue;
}

export async function persistModelAgentPin(pool: Pool, pin: ModelAgentPin): Promise<string> {
  const toolManifest = pin.tools.map(({ name, version, description, inputSchema }) => ({
    name,
    version,
    description,
    inputSchema,
  }));
  const values: unknown[] = [
    pin.executionId,
    pin.jobId,
    pin.researchCaseId,
    pin.researchCaseRevision,
    pin.inputRevision,
    pin.workflowState,
    pin.endpoint.configurationId,
    pin.endpoint.configurationVersion,
    pin.endpoint.configurationFingerprint,
    pin.promptVersion,
    pin.prompt,
    pin.inputSchema,
    pin.outputSchema,
    pin.input,
    toolManifest,
    pin.settings,
    pin.context,
    MODEL_COMPATIBILITY_TEST_VERSION,
  ];
  const existing = await pool.query<ExecutionRow>(
    `SELECT id,status FROM insight.model_agent_executions
     WHERE id=$1 AND job_id=$2 AND research_case_id=$3 AND research_case_revision=$4
       AND input_revision=$5 AND workflow_state=$6 AND endpoint_configuration_id=$7
       AND endpoint_configuration_version=$8 AND endpoint_fingerprint=$9
       AND prompt_version=$10 AND prompt=$11 AND input_schema=$12 AND output_schema=$13
        AND input_payload=$14 AND tool_manifest=$15 AND settings=$16 AND trusted_context=$17`,
    values.slice(0, 17),
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const result = await pool.query<ExecutionRow>(
    `INSERT INTO insight.model_agent_executions (
       id, job_id, research_case_id, research_case_revision, input_revision, workflow_state,
       endpoint_configuration_id, endpoint_configuration_version, endpoint_fingerprint,
       prompt_version, prompt, input_schema, output_schema, input_payload, tool_manifest,
       settings, trusted_context
     ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       WHERE EXISTS (
         SELECT 1 FROM insight.research_cases
         WHERE id=$3 AND workflow_revision=$4 AND input_revision=$5 AND workflow_state=$6
        ) AND EXISTS (
          SELECT 1 FROM insight.model_endpoint_configurations configuration
          WHERE configuration.id=$7 AND configuration.version=$8
            AND configuration.configuration_fingerprint=$9
            AND configuration.compatibility_test_version=$18
            AND configuration.credential_ciphertext IS NOT NULL
        )
       RETURNING id,status`,
    values,
  );
  if (!result.rows[0]) {
    throw new ModelAgentError(
      (await isPinnedResearchCaseRevisionCurrent(pool, pin))
        ? "ENDPOINT_EXHAUSTED"
        : "STALE_RESEARCH_CASE_REVISION",
    );
  }
  return result.rows[0].id;
}

export async function isPinnedResearchCaseRevisionCurrent(
  pool: Pool,
  pin: ModelAgentPin,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM insight.research_cases
     WHERE id=$1 AND workflow_revision=$2 AND input_revision=$3 AND workflow_state=$4`,
    [pin.researchCaseId, pin.researchCaseRevision, pin.inputRevision, pin.workflowState],
  );
  return result.rowCount === 1;
}

export async function runDurableModelAgent(
  pool: Pool,
  pin: ModelAgentPin,
  gateway: InternalMcpGateway,
  request: typeof fetch = fetch,
  claim?: ModelAgentClaimFence,
): Promise<ModelAgentSuccess> {
  await persistModelAgentPin(pool, pin);
  const terminal = await resumeModelAgentExecution(pool, pin, claim);
  if (terminal) return terminal;
  let initialCheckpoint = await loadModelAgentCheckpoint(pool, pin);
  if (initialCheckpoint.messages.length === 0) {
    const messages: ModelProtocolMessage[] = [
      { role: "system", content: pin.prompt },
      { role: "user", content: stableSerialize(pin.input) },
    ];
    initialCheckpoint = {
      ...initialCheckpoint,
      messages,
    };
    await checkpointModelAgentExecution(pool, pin.executionId, initialCheckpoint, claim);
  }
  let result: ModelAgentSuccess;
  try {
    result = await runModelAgent({
      pin,
      gateway,
      fetch: request,
      initialCheckpoint,
      assertCurrentRevision: async () => {
        if (!(await isPinnedResearchCaseRevisionCurrent(pool, pin))) return false;
        if (claim && !(await isModelAgentClaimCurrent(pool, pin.executionId, claim))) {
          throw new ModelAgentClaimLostError();
        }
        return true;
      },
      checkpoint: (checkpoint) =>
        checkpointModelAgentExecution(pool, pin.executionId, checkpoint, claim),
    });
  } catch (error) {
    if (!(error instanceof ModelAgentError)) throw error;
    await settleModelAgentExecution(pool, pin.executionId, { failure: error.code }, claim);
    throw error;
  }
  await settleModelAgentExecution(pool, pin.executionId, { output: result.output }, claim);
  return result;
}

async function resumeModelAgentExecution(
  pool: Pool,
  pin: ModelAgentPin,
  claim?: ModelAgentClaimFence,
): Promise<ModelAgentSuccess | null> {
  const result = await pool.query<ExecutionRow>(
    `SELECT status,messages,model_call_count,tool_call_count,consumed_tokens,output
     FROM insight.model_agent_executions WHERE id=$1`,
    [pin.executionId],
  );
  const row = result.rows[0];
  if (!row) throw new ModelAgentError("TOOL_CALL_REJECTED");
  if (row.status === "FAILED") {
    const reset = await pool.query(
      `UPDATE insight.model_agent_executions
       SET status='PENDING',failure_code=NULL,completed_at=NULL,updated_at=clock_timestamp()
       WHERE id=$1 AND status='FAILED'
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM insight.jobs job
           WHERE job.id=model_agent_executions.job_id AND job.status='RUNNING'
             AND job.lease_owner=$2 AND job.attempt_count=$3
             AND job.lease_expires_at>clock_timestamp()
         ))`,
      [pin.executionId, claim?.leaseOwner ?? null, claim?.attempt ?? null],
    );
    if (reset.rowCount !== 1) throw new ModelAgentClaimLostError();
    return null;
  }
  if (row.status === "CANCELLED") {
    throw new ModelAgentError("STALE_RESEARCH_CASE_REVISION");
  }
  if (row.status !== "SUCCEEDED") return null;
  const checkpoint = {
    messages: row.messages ?? [],
    modelCallCount: row.model_call_count ?? -1,
    toolCallCount: row.tool_call_count ?? -1,
    consumedTokens: row.consumed_tokens ?? -1,
  };
  validateCheckpoint(checkpoint);
  if (!isJsonValue(row.output) || !Value.Check(pin.outputSchema, row.output)) {
    throw new ModelAgentError("FINAL_SCHEMA_INVALID");
  }
  return { ...checkpoint, output: row.output };
}

async function loadModelAgentCheckpoint(
  pool: Pool,
  pin: ModelAgentPin,
): Promise<ModelAgentCheckpoint & { messages: ModelProtocolMessage[] }> {
  const result = await pool.query<ExecutionRow>(
    `SELECT status,messages,model_call_count,tool_call_count,consumed_tokens
     FROM insight.model_agent_executions WHERE id=$1 AND status IN ('PENDING','RUNNING')`,
    [pin.executionId],
  );
  const row = result.rows[0];
  if (
    !row ||
    !Array.isArray(row.messages) ||
    !Number.isSafeInteger(row.model_call_count) ||
    !Number.isSafeInteger(row.tool_call_count) ||
    !Number.isSafeInteger(row.consumed_tokens)
  )
    throw new ModelAgentError("TOOL_CALL_REJECTED");
  const checkpoint = {
    messages: row.messages,
    modelCallCount: row.model_call_count!,
    toolCallCount: row.tool_call_count!,
    consumedTokens: row.consumed_tokens!,
  };
  validateCheckpoint(checkpoint);
  return checkpoint;
}

export async function checkpointModelAgentExecution(
  pool: Pool,
  executionId: string,
  checkpoint: ModelAgentCheckpoint,
  claim?: ModelAgentClaimFence,
): Promise<void> {
  const result = await pool.query(
    `UPDATE insight.model_agent_executions
     SET status='RUNNING', messages=$2, model_call_count=$3, tool_call_count=$4,
         consumed_tokens=$5, updated_at=clock_timestamp()
      WHERE id=$1 AND status IN ('PENDING','RUNNING')
        AND ($6::text IS NULL OR EXISTS (
          SELECT 1 FROM insight.jobs job
          WHERE job.id=model_agent_executions.job_id AND job.status='RUNNING'
            AND job.lease_owner=$6 AND job.attempt_count=$7
            AND job.lease_expires_at>clock_timestamp()
        ))`,
    [
      executionId,
      checkpoint.messages,
      checkpoint.modelCallCount,
      checkpoint.toolCallCount,
      checkpoint.consumedTokens,
      claim?.leaseOwner ?? null,
      claim?.attempt ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    if (claim) throw new ModelAgentClaimLostError();
    throw new ModelAgentError("STALE_RESEARCH_CASE_REVISION");
  }
}

export async function settleModelAgentExecution(
  pool: Pool,
  executionId: string,
  outcome: { readonly output: JsonValue } | { readonly failure: ModelAgentFailureCode },
  claim?: ModelAgentClaimFence,
): Promise<void> {
  const result = await pool.query(
    `UPDATE insight.model_agent_executions
     SET status=$2, output=$3, failure_code=$4, completed_at=clock_timestamp(),
         updated_at=clock_timestamp()
      WHERE id=$1 AND status IN ('PENDING','RUNNING')
        AND ($5::text IS NULL OR EXISTS (
          SELECT 1 FROM insight.jobs job
          WHERE job.id=model_agent_executions.job_id AND job.status='RUNNING'
            AND job.lease_owner=$5 AND job.attempt_count=$6
            AND job.lease_expires_at>clock_timestamp()
        ))`,
    [
      executionId,
      "output" in outcome
        ? "SUCCEEDED"
        : outcome.failure === "STALE_RESEARCH_CASE_REVISION"
          ? "CANCELLED"
          : "FAILED",
      "output" in outcome ? outcome.output : null,
      "failure" in outcome ? outcome.failure : null,
      claim?.leaseOwner ?? null,
      claim?.attempt ?? null,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Model agent execution could not be settled.");
}

async function isModelAgentClaimCurrent(
  pool: Pool,
  executionId: string,
  claim: ModelAgentClaimFence,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM insight.model_agent_executions execution
     JOIN insight.jobs job ON job.id=execution.job_id
     WHERE execution.id=$1 AND job.status='RUNNING' AND job.lease_owner=$2
       AND job.attempt_count=$3 AND job.lease_expires_at>clock_timestamp()`,
    [executionId, claim.leaseOwner, claim.attempt],
  );
  return result.rowCount === 1;
}

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";

import type { Role } from "@insight/contracts";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export const MODEL_COMPATIBILITY_TEST_VERSION = "1";
export type ModelEndpointStatus = "PENDING" | "CHECKING" | "COMPATIBLE" | "INCOMPATIBLE";
export type ModelEndpointFailureCategory =
  | "AUTHENTICATION"
  | "ENDPOINT"
  | "RATE_LIMITED"
  | "PROVIDER"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "TOOL_CALL"
  | "TOOL_ROUND_TRIP";

export interface ModelEndpointActor {
  readonly id: string;
  readonly role: Role;
}

export interface ModelEndpointConfiguration {
  readonly version: number;
  readonly baseUrl: string;
  readonly model: string;
  readonly credentialConfigured: boolean;
  readonly status: ModelEndpointStatus;
  readonly aiEligible: boolean;
  readonly compatibilityTestVersion: string;
  readonly configurationFingerprint: string;
  readonly failureCategory: ModelEndpointFailureCategory | null;
  readonly returnedModel: string | null;
  readonly lastCheckedAt: string | null;
  readonly createdAt: string;
}

export interface ActiveModelEndpoint {
  readonly configurationId: string;
  readonly configurationVersion: number;
  readonly configurationFingerprint: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly credential: string;
}

interface ProviderToolCall {
  readonly id?: unknown;
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
}
interface ProviderMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: readonly ProviderToolCall[];
}
interface ProviderResponse {
  readonly model?: unknown;
  readonly choices: readonly [{ readonly message: ProviderMessage }, ...unknown[]];
}

interface ConfigurationRow extends QueryResultRow {
  id: string;
  version: number;
  base_url: string;
  model: string;
  credential_ciphertext: Buffer | null;
  credential_iv: Buffer | null;
  credential_tag: Buffer | null;
  encryption_key_version: number | null;
  compatibility_test_version: string;
  configuration_fingerprint: string;
  created_at: Date;
  status: ModelEndpointStatus;
  failure_category: ModelEndpointFailureCategory | null;
  returned_model: string | null;
  last_checked_at: Date | null;
  key_material?: Buffer;
}

export class ModelEndpointAuthorizationError extends Error {}
export class ModelEndpointInputError extends Error {}
export class ModelEndpointNotConfiguredError extends Error {}

export async function getActiveModelEndpointForExecution(
  database: Pick<Pool, "query">,
): Promise<ActiveModelEndpoint> {
  const result = await database.query<ConfigurationRow>(`
    SELECT configuration.*, state.status, state.failure_category, state.returned_model,
           state.last_checked_at, key.key_material
    FROM insight.model_endpoint_state state
    JOIN insight.model_endpoint_configurations configuration
      ON configuration.id = state.current_configuration_id
    JOIN insight.application_encryption_keys key
      ON key.version = configuration.encryption_key_version
    WHERE state.singleton = true AND state.status = 'COMPATIBLE'
      AND configuration.compatibility_test_version = $1
      AND configuration.credential_ciphertext IS NOT NULL
  `, [MODEL_COMPATIBILITY_TEST_VERSION]);
  const row = result.rows[0];
  if (!row?.key_material || !row.credential_ciphertext || !row.credential_iv || !row.credential_tag) {
    throw new ModelEndpointNotConfiguredError();
  }
  return {
    configurationId: row.id,
    configurationVersion: row.version,
    configurationFingerprint: row.configuration_fingerprint,
    baseUrl: row.base_url,
    model: row.model,
    credential: decrypt(
      row.credential_ciphertext,
      row.credential_iv,
      row.credential_tag,
      row.key_material,
      row.id,
    ),
  };
}

export function normalizeModelBaseUrl(value: string, allowDevelopmentLoopbackHttp = false): string {
  const input = value.trim();
  if (!input || /[?#]/.test(input)) throw new ModelEndpointInputError("Invalid model base URL.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ModelEndpointInputError("Invalid model base URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ModelEndpointInputError("Invalid model base URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(allowDevelopmentLoopbackHttp && url.protocol === "http:" && loopback)
  ) {
    throw new ModelEndpointInputError("Invalid model base URL.");
  }
  const normalized = url.href.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) {
    throw new ModelEndpointInputError("Invalid model base URL.");
  }
  return normalized;
}

export function modelChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`;
}

export async function getModelEndpointConfiguration(
  pool: Pool,
  actor: ModelEndpointActor,
): Promise<ModelEndpointConfiguration | null> {
  await requireAdministrator(pool, actor);
  const result = await pool.query<ConfigurationRow>(currentConfigurationSql());
  return result.rows[0] ? publicConfiguration(result.rows[0]) : null;
}

export async function replaceModelEndpointConfiguration(
  pool: Pool,
  actor: ModelEndpointActor,
  input: { readonly baseUrl: string; readonly model: string; readonly credential: string },
  allowDevelopmentLoopbackHttp = false,
  now = new Date(),
): Promise<ModelEndpointConfiguration> {
  await requireAdministrator(pool, actor);
  const baseUrl = normalizeModelBaseUrl(input.baseUrl, allowDevelopmentLoopbackHttp);
  const model = requiredValue(input.model, "model", 500);
  const credential = requiredValue(input.credential, "credential", 4096);
  return withTransaction(pool, async (client) => {
    await lockState(client);
    const key = await activeKey(client);
    const id = randomUUID();
    const encrypted = encrypt(credential, key.key_material, id);
    const version = await nextVersion(client);
    const fingerprint = fingerprintOf(key.key_material, baseUrl, model, credential);
    const inserted = await client.query<ConfigurationRow>(
      `INSERT INTO insight.model_endpoint_configurations (
         id, version, base_url, model, credential_ciphertext, credential_iv, credential_tag,
         encryption_key_version, compatibility_test_version, configuration_fingerprint,
         created_by_user_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *, 'PENDING'::text AS status, NULL::text AS failure_category,
                 NULL::text AS returned_model, NULL::timestamptz AS last_checked_at`,
      [
        id,
        version,
        baseUrl,
        model,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        key.version,
        MODEL_COMPATIBILITY_TEST_VERSION,
        fingerprint,
        actor.id,
        now,
      ],
    );
    await activatePending(client, id);
    await audit(client, "MODEL_ENDPOINT_REPLACED", actor.id, id, version, baseUrl, model, now);
    return publicConfiguration(inserted.rows[0]);
  });
}

export async function clearModelEndpointCredential(
  pool: Pool,
  actor: ModelEndpointActor,
  now = new Date(),
): Promise<ModelEndpointConfiguration> {
  await requireAdministrator(pool, actor);
  return withTransaction(pool, async (client) => {
    await lockState(client);
    const current = await client.query<ConfigurationRow>(currentConfigurationSql());
    const previous = current.rows[0];
    if (!previous) throw new ModelEndpointNotConfiguredError();
    const id = randomUUID();
    const version = await nextVersion(client);
    const key = await activeKey(client);
    const fingerprint = fingerprintOf(key.key_material, previous.base_url, previous.model, "");
    const inserted = await client.query<ConfigurationRow>(
      `INSERT INTO insight.model_endpoint_configurations (
         id, version, base_url, model, compatibility_test_version, configuration_fingerprint,
         created_by_user_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *, 'PENDING'::text AS status, NULL::text AS failure_category,
                 NULL::text AS returned_model, NULL::timestamptz AS last_checked_at`,
      [
        id,
        version,
        previous.base_url,
        previous.model,
        MODEL_COMPATIBILITY_TEST_VERSION,
        fingerprint,
        actor.id,
        now,
      ],
    );
    await activatePending(client, id);
    await audit(
      client,
      "MODEL_ENDPOINT_CREDENTIAL_CLEARED",
      actor.id,
      id,
      version,
      previous.base_url,
      previous.model,
      now,
    );
    return publicConfiguration(inserted.rows[0]);
  });
}

export async function checkModelEndpointCompatibility(
  pool: Pool,
  actor: ModelEndpointActor,
): Promise<ModelEndpointConfiguration> {
  await requireAdministrator(pool, actor);
  const row = await withTransaction(pool, async (client) => {
    await lockState(client);
    const result = await client.query<ConfigurationRow>(`
      SELECT configuration.*, state.status, state.failure_category, state.returned_model,
             state.last_checked_at, key.key_material
      FROM insight.model_endpoint_state state
      JOIN insight.model_endpoint_configurations configuration
        ON configuration.id = state.current_configuration_id
      LEFT JOIN insight.application_encryption_keys key
        ON key.version = configuration.encryption_key_version
      WHERE state.singleton = true
    `);
    const current = result.rows[0];
    if (!current || !current.credential_ciphertext || !current.key_material) {
      throw new ModelEndpointNotConfiguredError();
    }
    await client.query(
      `UPDATE insight.model_endpoint_state SET status = 'CHECKING', failure_category = NULL,
       returned_model = NULL, last_checked_at = NULL WHERE singleton = true`,
    );
    return current;
  });

  const credential = decrypt(
    row.credential_ciphertext!,
    row.credential_iv!,
    row.credential_tag!,
    row.key_material!,
    row.id,
  );
  const result = await runModelEndpointCompatibilityProbe(row.base_url, row.model, credential);
  return withTransaction(pool, async (client) => {
    await lockState(client);
    await client.query(
      `UPDATE insight.model_endpoint_state
       SET status = $2, failure_category = $3, returned_model = $4, last_checked_at = $5
       WHERE singleton = true AND current_configuration_id = $1`,
      [
        row.id,
        result.compatible ? "COMPATIBLE" : "INCOMPATIBLE",
        result.failureCategory,
        result.returnedModel,
        new Date(),
      ],
    );
    const current = await client.query<ConfigurationRow>(currentConfigurationSql());
    if (!current.rows[0]) throw new ModelEndpointNotConfiguredError();
    return publicConfiguration(current.rows[0]);
  });
}

export interface ModelEndpointProbeResult {
  readonly compatible: boolean;
  readonly failureCategory: ModelEndpointFailureCategory | null;
  readonly returnedModel: string | null;
}

export async function runModelEndpointCompatibilityProbe(
  baseUrl: string,
  model: string,
  credential: string,
  timeoutMs = 15_000,
): Promise<ModelEndpointProbeResult> {
  const nonce = randomBytes(18).toString("base64url");
  const firstTool = "insight_probe_echo";
  const secondTool = "insight_probe_complete";
  const firstArguments = probeArguments(nonce, 1);
  const secondArguments = probeArguments(nonce, 2);
  const firstSchema = probeSchema(nonce, 1);
  const secondSchema = probeSchema(nonce, 2);
  const tool = (name: string, schema: TSchema) => ({
    type: "function",
    function: {
      name,
      description: "INSIGHT compatibility probe",
      parameters: schema,
    },
  });
  const firstMessages = [
    {
      role: "user",
      content: `Call ${firstTool} with exactly ${JSON.stringify(firstArguments)}.`,
    },
  ];
  try {
    const first = await providerRequest(
      baseUrl,
      credential,
      {
        model,
        messages: firstMessages,
        tools: [tool(firstTool, firstSchema)],
        tool_choice: { type: "function", function: { name: firstTool } },
      },
      timeoutMs,
    );
    if (!first.ok) return first.failure;
    const call = toolCall(first.body, firstTool, firstSchema);
    if (!call) return { compatible: false, failureCategory: "TOOL_CALL", returnedModel: null };
    const second = await providerRequest(
      baseUrl,
      credential,
      {
        model,
        messages: [
          ...firstMessages,
          first.body.choices[0].message,
          {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ accepted: call.arguments, next: secondArguments }),
          },
        ],
        tools: [tool(secondTool, secondSchema)],
        tool_choice: { type: "function", function: { name: secondTool } },
      },
      timeoutMs,
    );
    if (!second.ok) return second.failure;
    if (!toolCall(second.body, secondTool, secondSchema)) {
      return { compatible: false, failureCategory: "TOOL_ROUND_TRIP", returnedModel: null };
    }
    const returnedModel =
      safeReturnedModel(second.body.model, credential) ??
      safeReturnedModel(first.body.model, credential);
    return { compatible: true, failureCategory: null, returnedModel };
  } catch (error) {
    return {
      compatible: false,
      failureCategory: error instanceof SyntaxError ? "MALFORMED_RESPONSE" : "TIMEOUT",
      returnedModel: null,
    };
  }
}

async function providerRequest(
  baseUrl: string,
  credential: string,
  body: object,
  timeoutMs: number,
) {
  const response = await fetch(modelChatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const category: ModelEndpointFailureCategory =
      response.status === 401 || response.status === 403
        ? "AUTHENTICATION"
        : response.status === 404
          ? "ENDPOINT"
          : response.status === 408
            ? "TIMEOUT"
            : response.status === 429
              ? "RATE_LIMITED"
              : "PROVIDER";
    return {
      ok: false as const,
      failure: { compatible: false as const, failureCategory: category, returnedModel: null },
    };
  }
  const parsed = (await response.json()) as Partial<ProviderResponse>;
  if (
    !parsed ||
    !Array.isArray(parsed.choices) ||
    !parsed.choices[0]?.message ||
    typeof parsed.choices[0].message !== "object"
  ) {
    throw new SyntaxError();
  }
  return { ok: true as const, body: parsed as ProviderResponse };
}

function probeArguments(nonce: string, sequence: number) {
  return {
    nonce,
    roundTrip: { sequence, acknowledged: true },
    checks: [{ name: "native-chat-completions", passed: true }],
  };
}

function probeSchema(nonce: string, sequence: number) {
  return Type.Object(
    {
      nonce: Type.Literal(nonce),
      roundTrip: Type.Object(
        {
          sequence: Type.Literal(sequence),
          acknowledged: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
      checks: Type.Array(
        Type.Object(
          {
            name: Type.Literal("native-chat-completions"),
            passed: Type.Literal(true),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 1 },
      ),
    },
    { additionalProperties: false },
  );
}

function toolCall(
  body: ProviderResponse,
  expectedName: string,
  schema: TSchema,
): { id: string; arguments: unknown } | null {
  const calls = body.choices[0].message.tool_calls;
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    !call ||
    typeof call.id !== "string" ||
    !call.id ||
    call.function?.name !== expectedName
  ) {
    return null;
  }
  let args: unknown = call.function.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return Value.Check(schema, args) ? { id: call.id, arguments: args } : null;
}

function safeReturnedModel(value: unknown, credential: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes(credential)) return null;
  return value.slice(0, 500);
}

function currentConfigurationSql(): string {
  return `SELECT configuration.*, state.status, state.failure_category, state.returned_model,
                 state.last_checked_at
          FROM insight.model_endpoint_state state
          JOIN insight.model_endpoint_configurations configuration
            ON configuration.id = state.current_configuration_id
          WHERE state.singleton = true`;
}

async function requireAdministrator(pool: Pool, actor: ModelEndpointActor) {
  if (actor.role !== "ADMINISTRATOR") throw new ModelEndpointAuthorizationError();
  const result = await pool.query(
    "SELECT 1 FROM insight.users WHERE id=$1 AND role='ADMINISTRATOR' AND status <> 'DISABLED'",
    [actor.id],
  );
  if (result.rowCount !== 1) throw new ModelEndpointAuthorizationError();
}

async function lockState(client: PoolClient) {
  await client.query(
    "SELECT singleton FROM insight.model_endpoint_state WHERE singleton=true FOR UPDATE",
  );
}
async function nextVersion(client: PoolClient) {
  return (
    await client.query<{ version: number }>(
      "SELECT coalesce(max(version),0)::integer+1 AS version FROM insight.model_endpoint_configurations",
    )
  ).rows[0].version;
}
async function activeKey(client: PoolClient) {
  return (
    await client.query<{ version: number; key_material: Buffer }>(
      "SELECT version,key_material FROM insight.application_encryption_keys WHERE active=true",
    )
  ).rows[0];
}
async function activatePending(client: PoolClient, id: string) {
  await client.query(
    `UPDATE insight.model_endpoint_state SET current_configuration_id=$1,
    status='PENDING', failure_category=NULL, returned_model=NULL, last_checked_at=NULL WHERE singleton=true`,
    [id],
  );
}
async function audit(
  client: PoolClient,
  event: string,
  actorId: string,
  id: string,
  version: number,
  baseUrl: string,
  model: string,
  now: Date,
) {
  await client.query(
    `INSERT INTO insight.model_endpoint_audit_events
    (event_type,actor_user_id,configuration_id,configuration_version,base_url,model,occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [event, actorId, id, version, baseUrl, model, now],
  );
}
function requiredValue(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw new ModelEndpointInputError(`Invalid ${label}.`);
  return normalized;
}
function fingerprintOf(key: Buffer, baseUrl: string, model: string, credential: string) {
  return createHmac("sha256", key)
    .update(`${MODEL_COMPATIBILITY_TEST_VERSION}\0${baseUrl}\0${model}\0${credential}`)
    .digest("hex");
}
function encrypt(value: string, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return {
    ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}
function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
function publicConfiguration(row: ConfigurationRow): ModelEndpointConfiguration {
  return {
    version: row.version,
    baseUrl: row.base_url,
    model: row.model,
    credentialConfigured: row.credential_ciphertext !== null,
    status: row.status,
    aiEligible: row.status === "COMPATIBLE",
    compatibilityTestVersion: row.compatibility_test_version,
    configurationFingerprint: row.configuration_fingerprint,
    failureCategory: row.failure_category,
    returnedModel: row.returned_model,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

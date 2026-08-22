import { FormatRegistry, Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const CURRENT_SCHEMA_VERSION = "1" as const;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const TIMESTAMP_PATTERN =
  "^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const ERROR_CODE_PATTERN = "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$";

const timestampParts = new RegExp(TIMESTAMP_PATTERN);

function isRfc3339Timestamp(value: string): boolean {
  if (timestampParts.exec(value) === null) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return day >= 1 && day <= daysInMonth[month - 1]!;
}

const isUuid = (value: string): boolean => new RegExp(UUID_PATTERN).test(value);

function registerContractFormats(): void {
  FormatRegistry.Set("uuid", isUuid);
  FormatRegistry.Set("date-time", isRfc3339Timestamp);
}

registerContractFormats();

export const UuidSchema = Type.String({
  title: "INSIGHT UUID v1",
  format: "uuid",
  pattern: UUID_PATTERN,
});
export type Uuid = Static<typeof UuidSchema>;

export const TimestampSchema = Type.String({
  title: "INSIGHT timestamp v1",
  format: "date-time",
  pattern: TIMESTAMP_PATTERN,
});
export type Timestamp = Static<typeof TimestampSchema>;

export const Sha256Schema = Type.String({
  title: "INSIGHT SHA-256 v1",
  pattern: SHA256_PATTERN,
});
export type Sha256 = Static<typeof Sha256Schema>;

export const RoleSchema = Type.Union(
  [Type.Literal("ADMINISTRATOR"), Type.Literal("PSYCHIATRIST")],
  { title: "INSIGHT role v1" },
);
export type Role = Static<typeof RoleSchema>;

export const SchemaVersionSchema = Type.Literal(CURRENT_SCHEMA_VERSION, {
  description: "Runtime contract schema version",
});
export type SchemaVersion = Static<typeof SchemaVersionSchema>;

export const ApiErrorIssueSchema = Type.Object(
  {
    path: Type.String({ maxLength: 512 }),
    code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
    message: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type ApiErrorIssue = Static<typeof ApiErrorIssueSchema>;

export const ApiErrorSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    error: Type.Object(
      {
        status: Type.Integer({ minimum: 400, maximum: 599 }),
        code: Type.String({ pattern: ERROR_CODE_PATTERN, maxLength: 100 }),
        message: Type.String({ minLength: 1, maxLength: 1000 }),
        requestId: UuidSchema,
        issues: Type.Optional(Type.Array(ApiErrorIssueSchema, { maxItems: 100 })),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "insight.api-error.v1", additionalProperties: false },
);
export type ApiError = Static<typeof ApiErrorSchema>;

export const PaginationQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  },
  { $id: "insight.pagination-query.v1", additionalProperties: false },
);
export type PaginationQuery = Static<typeof PaginationQuerySchema>;

export const PaginationSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { title: "INSIGHT pagination v1", additionalProperties: false },
);
export type Pagination = Static<typeof PaginationSchema>;

export function paginatedResponseSchema<T extends TSchema>(itemSchema: T) {
  return Type.Object(
    {
      schemaVersion: SchemaVersionSchema,
      items: Type.Array(itemSchema),
      pagination: PaginationSchema,
    },
    { additionalProperties: false },
  );
}

export const ProvenanceSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    executionId: UuidSchema,
    source: Type.String({ minLength: 1, maxLength: 200 }),
    sourceVersion: Type.String({ minLength: 1, maxLength: 200 }),
    inputHash: Sha256Schema,
    outputHash: Sha256Schema,
    recordedAt: TimestampSchema,
  },
  { $id: "insight.provenance.v1", additionalProperties: false },
);
export type Provenance = Static<typeof ProvenanceSchema>;

export const HealthResponseSchema = Type.Object(
  { status: Type.Literal("ok") },
  { $id: "insight.health-response.v1", additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

export interface ContractValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly ContractValidationIssue[];

  constructor(issues: readonly ContractValidationIssue[]) {
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export class UnsupportedSchemaVersionError extends Error {
  readonly received: unknown;
  readonly supported = CURRENT_SCHEMA_VERSION;

  constructor(received: unknown) {
    const description =
      received === null || ["boolean", "number", "string", "undefined"].includes(typeof received)
        ? String(received)
        : `<${typeof received}>`;
    super(`Unsupported schema version: ${description}`);
    this.name = "UnsupportedSchemaVersionError";
    this.received = received;
  }
}

export function isContract<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  registerContractFormats();
  return Value.Check(schema, value);
}

export function parseContract<T extends TSchema>(schema: T, value: unknown): Static<T> {
  registerContractFormats();
  if (Value.Check(schema, value)) return value as Static<T>;

  const issues = [...Value.Errors(schema, value)]
    .map(({ path, message }) => ({ path: path || "/", message }))
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      if (left.message === right.message) return 0;
      return left.message < right.message ? -1 : 1;
    });
  throw new ContractValidationError(issues);
}

export function assertSupportedSchemaVersion(
  value: unknown,
): asserts value is { schemaVersion: SchemaVersion } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractValidationError([
      { path: "/schemaVersion", message: "Expected a versioned object" },
    ]);
  }

  const received = (value as Record<string, unknown>).schemaVersion;
  if (received === undefined) {
    throw new ContractValidationError([
      { path: "/schemaVersion", message: "Expected schemaVersion" },
    ]);
  }
  if (received !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(received);
  }
}

export function parseVersionedContract<T extends TSchema>(schema: T, value: unknown): Static<T> {
  assertSupportedSchemaVersion(value);
  return parseContract(schema, value);
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function serializeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot serialize non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot serialize JSON value of type ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Cannot serialize cyclic JSON value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serializeJson(entry, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cannot serialize non-plain object as JSON");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJson(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableSerialize(value: JsonValue): string {
  return serializeJson(value, new Set());
}

export async function sha256Hex(input: string | Uint8Array): Promise<Sha256> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as Sha256;
}

export function hashCanonicalJson(value: JsonValue): Promise<Sha256> {
  return sha256Hex(stableSerialize(value));
}

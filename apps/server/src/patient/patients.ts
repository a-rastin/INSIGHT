import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";
import { invalidateResearchCaseInputsInTransaction } from "./workflow.js";

export type PatientSex = "MALE" | "FEMALE";
export type IdentifierNormalization = "NFKC" | "NFKC_UPPERCASE" | "NFKC_LOWERCASE";

export interface OfficialIdentifierConfiguration {
  readonly type: string;
  readonly issuingAuthority: string;
  readonly pattern: string;
  readonly normalization: IdentifierNormalization;
}

export interface PatientActor {
  readonly id: string;
  readonly role: "ADMINISTRATOR" | "PSYCHIATRIST";
}

export interface PatientDemographics {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly sex: PatientSex;
}

export interface PatientInput extends PatientDemographics {
  readonly officialIdentifier: {
    readonly type: string;
    readonly issuingAuthority: string;
    readonly value: string;
  };
}

export interface PatientRecord extends PatientInput {
  readonly id: string;
  readonly profileAge: number;
  readonly researchCase: {
    readonly id: string;
    readonly startedAt: string;
    readonly ageAtStart: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PatientSaveResult {
  readonly created: boolean;
  readonly patient: PatientRecord;
}

export interface PatientDeletionResult {
  readonly databaseStatus: "DELETED";
  readonly artifactRemoval: "SUCCEEDED" | "FAILED";
}

export interface PatientDeletionOptions {
  readonly artifactRoot: string;
  readonly removeArtifacts?: (path: string) => Promise<void>;
}

export interface PatientAuditEvent {
  readonly eventType: "PATIENT_CREATED" | "PATIENT_DEMOGRAPHICS_SAVED" | "PATIENT_DELETED";
  readonly patientLink: {
    readonly patientId: string;
    readonly researchCaseId: string;
  };
  readonly targetVersion: number;
  readonly before: PatientDemographics | null;
  readonly after: PatientDemographics | null;
  readonly payloadReference: string | null;
  readonly actorUserId: string | null;
  readonly requestId: string;
  readonly occurredAt: string;
}

interface EncryptionKeyRow extends QueryResultRow {
  version: number;
  key_material: Buffer;
}

interface PatientRow extends QueryResultRow {
  id: string;
  official_identifier_type: string;
  official_identifier_issuer: string;
  official_identifier_ciphertext: Buffer;
  official_identifier_iv: Buffer;
  official_identifier_tag: Buffer;
  first_name_ciphertext: Buffer;
  first_name_iv: Buffer;
  first_name_tag: Buffer;
  last_name_ciphertext: Buffer;
  last_name_iv: Buffer;
  last_name_tag: Buffer;
  date_of_birth_ciphertext: Buffer;
  date_of_birth_iv: Buffer;
  date_of_birth_tag: Buffer;
  encryption_key_version: number;
  sex: PatientSex;
  created_at: Date;
  updated_at: Date;
  record_version: string;
  research_case_id: string;
  started_at: Date;
}

interface AuditRow extends QueryResultRow {
  event_type: PatientAuditEvent["eventType"];
  patient_id: string;
  research_case_id: string;
  target_version: string;
  before_values_ciphertext: Buffer | null;
  before_values_iv: Buffer | null;
  before_values_tag: Buffer | null;
  after_values_ciphertext: Buffer | null;
  after_values_iv: Buffer | null;
  after_values_tag: Buffer | null;
  payload_reference: string | null;
  key_material: Buffer;
  actor_user_id: string | null;
  request_id: string;
  occurred_at: Date;
}

interface EncryptedValue {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class PatientAuthorizationError extends Error {
  constructor() {
    super("Patient content is available only to Psychiatrists.");
    this.name = "PatientAuthorizationError";
  }
}

export class PatientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatientInputError";
  }
}

export class PatientNotFoundError extends Error {
  constructor() {
    super("Patient was not found.");
    this.name = "PatientNotFoundError";
  }
}

const NAME_PATTERN = /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function officialIdentifierConfigurationFromEnv(
  env: NodeJS.ProcessEnv,
): OfficialIdentifierConfiguration {
  const type = env.INSIGHT_OFFICIAL_IDENTIFIER_TYPE?.trim();
  const issuingAuthority = env.INSIGHT_OFFICIAL_IDENTIFIER_ISSUER?.trim();
  const pattern = env.INSIGHT_OFFICIAL_IDENTIFIER_PATTERN;
  const normalization = env.INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION;
  if (!type || !issuingAuthority || !pattern) {
    throw new Error(
      "INSIGHT_OFFICIAL_IDENTIFIER_TYPE, INSIGHT_OFFICIAL_IDENTIFIER_ISSUER, and INSIGHT_OFFICIAL_IDENTIFIER_PATTERN are required.",
    );
  }
  if (!isNormalization(normalization)) {
    throw new Error(
      "INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION must be NFKC, NFKC_UPPERCASE, or NFKC_LOWERCASE.",
    );
  }
  validateConfiguration({ type, issuingAuthority, pattern, normalization });
  return { type, issuingAuthority, pattern, normalization };
}

export function normalizeOfficialIdentifier(
  value: string,
  configuration: OfficialIdentifierConfiguration,
): string {
  validateConfiguration(configuration);
  const normalized = value.normalize("NFKC").trim();
  const cased =
    configuration.normalization === "NFKC_UPPERCASE"
      ? normalized.toLocaleUpperCase("en-US")
      : configuration.normalization === "NFKC_LOWERCASE"
        ? normalized.toLocaleLowerCase("en-US")
        : normalized;
  if (!new RegExp(configuration.pattern, "u").test(cased)) {
    throw new PatientInputError("Official identifier does not match deployment configuration.");
  }
  return cased;
}

export function calculateAge(dateOfBirth: string, referenceDate: string): number {
  const birth = parseCalendarDate(dateOfBirth, "Date of birth");
  const reference = parseCalendarDate(referenceDate, "Reference date");
  const age =
    reference.year -
    birth.year -
    (reference.month < birth.month || (reference.month === birth.month && reference.day < birth.day)
      ? 1
      : 0);
  if (age < 0) throw new PatientInputError("Date of birth cannot be after reference date.");
  return age;
}

export async function createOrOverwritePatient(
  pool: Pool,
  actor: PatientActor,
  input: PatientInput,
  configuration: OfficialIdentifierConfiguration,
  requestId: string,
  now = new Date(),
): Promise<PatientSaveResult> {
  requirePsychiatrist(actor);
  const demographics = validateDemographics(input, now);
  const identifier = validateIdentifier(input.officialIdentifier, configuration);

  return withTransaction(pool, async (client) => {
    const key = await activeKey(client);
    const lookupHash = identifierHash(key.key_material, identifier.value);
    await lockIdentifier(client, configuration, lookupHash);

    const existing = await patientByIdentifier(client, configuration, lookupHash);
    const encrypted = encryptPatient(identifier.value, demographics, key);
    let row: PatientRow;
    let before: PatientDemographics | null = null;
    let created = false;

    if (existing) {
      const existingKey = await encryptionKey(client, existing.encryption_key_version);
      before = decryptDemographics(existing, existingKey);
      assertBirthBeforeCase(demographics.dateOfBirth, existing.started_at);
      row = await updatePatient(client, existing.id, actor.id, encrypted, demographics.sex, now);
      await invalidateResearchCaseInputsInTransaction(
        client,
        actor,
        existing.id,
        "Patient demographics changed.",
        requestId,
        now,
      );
    } else {
      created = true;
      row = await insertPatientAndCase(
        client,
        actor.id,
        configuration,
        lookupHash,
        encrypted,
        demographics.sex,
        now,
      );
    }

    await auditPatientSave(
      client,
      created ? "PATIENT_CREATED" : "PATIENT_DEMOGRAPHICS_SAVED",
      row,
      actor.id,
      requestId,
      before,
      demographics,
      key,
      now,
    );
    return {
      created,
      patient: materializePatient(row, identifier.value, demographics, now),
    };
  });
}

export async function savePatientDemographics(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  demographicsInput: PatientDemographics,
  requestId: string,
  now = new Date(),
): Promise<PatientRecord> {
  requirePsychiatrist(actor);
  const demographics = validateDemographics(demographicsInput, now);
  return withTransaction(pool, async (client) => {
    const key = await activeKey(client);
    const existing = await patientById(client, patientId);
    if (!existing) throw new PatientNotFoundError();
    assertBirthBeforeCase(demographics.dateOfBirth, existing.started_at);
    const existingKey = await encryptionKey(client, existing.encryption_key_version);
    const before = decryptDemographics(existing, existingKey);
    const identifier = decryptField(existing, "official_identifier", existingKey);
    const encrypted = encryptPatient(identifier, demographics, key);
    const row = await updatePatient(client, patientId, actor.id, encrypted, demographics.sex, now);
    await invalidateResearchCaseInputsInTransaction(
      client,
      actor,
      patientId,
      "Patient demographics changed.",
      requestId,
      now,
    );
    await auditPatientSave(
      client,
      "PATIENT_DEMOGRAPHICS_SAVED",
      row,
      actor.id,
      requestId,
      before,
      demographics,
      key,
      now,
    );
    return materializePatient(row, identifier, demographics, now);
  });
}

export async function listPatients(
  pool: Pool,
  actor: PatientActor,
  now = new Date(),
): Promise<readonly PatientRecord[]> {
  requirePsychiatrist(actor);
  const result = await pool.query<PatientRow>(
    `${patientSelect()} ORDER BY p.updated_at DESC, p.id`,
  );
  const keys = new Map<number, Buffer>();
  const patients: PatientRecord[] = [];

  for (const row of result.rows) {
    let key = keys.get(row.encryption_key_version);
    if (!key) {
      key = await encryptionKey(pool, row.encryption_key_version);
      keys.set(row.encryption_key_version, key);
    }
    patients.push(materializeStoredPatient(row, key, now));
  }
  return patients;
}

export async function getPatient(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  now = new Date(),
): Promise<PatientRecord> {
  requirePsychiatrist(actor);
  const result = await pool.query<PatientRow>(`${patientSelect()} WHERE p.id = $1`, [patientId]);
  const row = result.rows[0];
  if (!row) throw new PatientNotFoundError();
  const key = await encryptionKey(pool, row.encryption_key_version);
  return materializeStoredPatient(row, key, now);
}

export async function deletePatient(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
  requestId: string,
  options: PatientDeletionOptions,
  now = new Date(),
): Promise<PatientDeletionResult> {
  requirePsychiatrist(actor);
  await withTransaction(pool, async (client) => {
    const existing = await patientById(client, patientId);
    if (!existing) return;

    const keyMaterial = await encryptionKey(client, existing.encryption_key_version);
    const demographics = decryptDemographics(existing, keyMaterial);
    await auditPatientSave(
      client,
      "PATIENT_DELETED",
      { ...existing, record_version: String(Number(existing.record_version) + 1) },
      actor.id,
      requestId,
      demographics,
      null,
      { version: existing.encryption_key_version, key_material: keyMaterial },
      now,
    );
    for (const setting of [
      "insight.workflow_transition",
      "insight.dsm5tr_write",
      "insight.panss_write",
      "insight.cssrs_write",
      "insight.medical_history_write",
      "insight.primary_plan_write",
      "insight.final_plan_write",
    ]) {
      await client.query("SELECT set_config($1,'allowed',true)", [setting]);
    }
    await client.query("DELETE FROM insight.patients WHERE id = $1", [patientId]);
  });

  try {
    const removeArtifacts =
      options.removeArtifacts ?? ((path: string) => rm(path, { recursive: true, force: true }));
    await removeArtifacts(resolve(options.artifactRoot, "patients", patientId));
    return { databaseStatus: "DELETED", artifactRemoval: "SUCCEEDED" };
  } catch {
    return { databaseStatus: "DELETED", artifactRemoval: "FAILED" };
  }
}

export async function listPatientAuditEvents(
  pool: Pool,
  actor: PatientActor,
  patientId: string,
): Promise<readonly PatientAuditEvent[]> {
  requirePsychiatrist(actor);
  const authorization = await pool.query(
    `SELECT 1 FROM insight.users
     WHERE id = $1 AND role = 'PSYCHIATRIST' AND status <> 'DISABLED'`,
    [actor.id],
  );
  if (authorization.rowCount !== 1) throw new PatientAuthorizationError();
  const result = await pool.query<AuditRow>(
    `SELECT a.event_type, a.patient_id, a.research_case_id, a.target_version,
            a.before_values_ciphertext, a.before_values_iv,
            a.before_values_tag, a.after_values_ciphertext, a.after_values_iv,
            a.after_values_tag, a.payload_reference, k.key_material,
            a.actor_user_id, a.request_id, a.occurred_at
     FROM insight.patient_audit_events a
     JOIN insight.application_encryption_keys k ON k.version = a.encryption_key_version
     WHERE a.patient_id = $1
     ORDER BY a.target_version, a.occurred_at, a.id`,
    [patientId],
  );
  return result.rows.map((row) => ({
    eventType: row.event_type,
    patientLink: { patientId: row.patient_id, researchCaseId: row.research_case_id },
    targetVersion: Number(row.target_version),
    before:
      row.before_values_ciphertext && row.before_values_iv && row.before_values_tag
        ? decryptJson(
            {
              ciphertext: row.before_values_ciphertext,
              iv: row.before_values_iv,
              tag: row.before_values_tag,
            },
            row.key_material,
            "patient-audit",
          )
        : null,
    after:
      row.after_values_ciphertext && row.after_values_iv && row.after_values_tag
        ? decryptJson(
            {
              ciphertext: row.after_values_ciphertext,
              iv: row.after_values_iv,
              tag: row.after_values_tag,
            },
            row.key_material,
            "patient-audit",
          )
        : null,
    payloadReference: row.payload_reference,
    actorUserId: row.actor_user_id,
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

function validateConfiguration(configuration: OfficialIdentifierConfiguration): void {
  if (
    configuration.type.trim() !== configuration.type ||
    configuration.type.length === 0 ||
    configuration.type.length > 128 ||
    configuration.issuingAuthority.trim() !== configuration.issuingAuthority ||
    configuration.issuingAuthority.length === 0 ||
    configuration.issuingAuthority.length > 256
  ) {
    throw new Error("Official identifier type or issuing authority is invalid.");
  }
  try {
    void new RegExp(configuration.pattern, "u");
  } catch {
    throw new Error("Official identifier pattern is invalid.");
  }
}

function isNormalization(value: string | undefined): value is IdentifierNormalization {
  return value === "NFKC" || value === "NFKC_UPPERCASE" || value === "NFKC_LOWERCASE";
}

function validateIdentifier(
  identifier: PatientInput["officialIdentifier"],
  configuration: OfficialIdentifierConfiguration,
) {
  if (
    identifier.type !== configuration.type ||
    identifier.issuingAuthority !== configuration.issuingAuthority
  ) {
    throw new PatientInputError("Official identifier type or issuing authority is not accepted.");
  }
  return { ...identifier, value: normalizeOfficialIdentifier(identifier.value, configuration) };
}

function validateDemographics(input: PatientDemographics, now: Date): PatientDemographics {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (
    !NAME_PATTERN.test(firstName) ||
    !NAME_PATTERN.test(lastName) ||
    firstName.length > 128 ||
    lastName.length > 128
  ) {
    throw new PatientInputError("First and last names must contain English words.");
  }
  parseCalendarDate(input.dateOfBirth, "Date of birth");
  if (input.sex !== "MALE" && input.sex !== "FEMALE") {
    throw new PatientInputError("Sex must be MALE or FEMALE.");
  }
  const age = calculateAge(input.dateOfBirth, localCalendarDate(now));
  if (age < 18 || age > 99) {
    throw new PatientInputError("Patient age must be between 18 and 99 on save date.");
  }
  return { firstName, lastName, dateOfBirth: input.dateOfBirth, sex: input.sex };
}

function parseCalendarDate(value: string, label: string) {
  if (!DATE_PATTERN.test(value)) throw new PatientInputError(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PatientInputError(`${label} is not a valid calendar date.`);
  }
  return { year, month, day };
}

function localCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertBirthBeforeCase(dateOfBirth: string, startedAt: Date): void {
  calculateAge(dateOfBirth, localCalendarDate(startedAt));
}

function requirePsychiatrist(actor: PatientActor): void {
  if (actor.role !== "PSYCHIATRIST") throw new PatientAuthorizationError();
}

async function activeKey(database: Queryable): Promise<EncryptionKeyRow> {
  const result = await database.query<EncryptionKeyRow>(
    "SELECT version, key_material FROM insight.application_encryption_keys WHERE active = true",
  );
  const key = result.rows[0];
  if (!key || key.key_material.length !== 32)
    throw new Error("Active encryption key is unavailable.");
  return key;
}

async function encryptionKey(database: Queryable, version: number): Promise<Buffer> {
  const result = await database.query<EncryptionKeyRow>(
    "SELECT version, key_material FROM insight.application_encryption_keys WHERE version = $1",
    [version],
  );
  const key = result.rows[0]?.key_material;
  if (!key || key.length !== 32) throw new Error("Encryption key is unavailable.");
  return key;
}

function identifierHash(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

async function lockIdentifier(
  client: PoolClient,
  configuration: OfficialIdentifierConfiguration,
  lookupHash: Buffer,
): Promise<void> {
  const lockId = createHmac("sha256", lookupHash)
    .update(`${configuration.type}\0${configuration.issuingAuthority}`)
    .digest()
    .readBigInt64BE()
    .toString();
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId]);
}

async function patientByIdentifier(
  database: Queryable,
  configuration: OfficialIdentifierConfiguration,
  lookupHash: Buffer,
): Promise<PatientRow | undefined> {
  const result = await database.query<PatientRow>(
    `${patientSelect()}
     WHERE p.official_identifier_type = $1
       AND p.official_identifier_issuer = $2
       AND p.official_identifier_lookup_hash = $3
     FOR UPDATE OF p`,
    [configuration.type, configuration.issuingAuthority, lookupHash],
  );
  return result.rows[0];
}

async function patientById(
  database: Queryable,
  patientId: string,
): Promise<PatientRow | undefined> {
  const result = await database.query<PatientRow>(
    `${patientSelect()} WHERE p.id = $1 FOR UPDATE OF p`,
    [patientId],
  );
  return result.rows[0];
}

function patientSelect(): string {
  return `SELECT p.*, rc.id AS research_case_id, rc.started_at
          FROM insight.patients p
          JOIN insight.research_cases rc ON rc.patient_id = p.id`;
}

function encryptPatient(
  identifier: string,
  demographics: PatientDemographics,
  key: EncryptionKeyRow,
) {
  return {
    identifier: encryptText(identifier, key.key_material, "official-identifier"),
    firstName: encryptText(demographics.firstName, key.key_material, "first-name"),
    lastName: encryptText(demographics.lastName, key.key_material, "last-name"),
    dateOfBirth: encryptText(demographics.dateOfBirth, key.key_material, "date-of-birth"),
    keyVersion: key.version,
  };
}

async function insertPatientAndCase(
  client: PoolClient,
  actorUserId: string,
  configuration: OfficialIdentifierConfiguration,
  lookupHash: Buffer,
  encrypted: ReturnType<typeof encryptPatient>,
  sex: PatientSex,
  now: Date,
): Promise<PatientRow> {
  const patient = await client.query<{ id: string }>(
    `INSERT INTO insight.patients (
       official_identifier_type, official_identifier_issuer, official_identifier_lookup_hash,
       official_identifier_ciphertext, official_identifier_iv, official_identifier_tag,
       first_name_ciphertext, first_name_iv, first_name_tag,
       last_name_ciphertext, last_name_iv, last_name_tag,
       date_of_birth_ciphertext, date_of_birth_iv, date_of_birth_tag,
       encryption_key_version, sex, created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $18, $19, $19
     ) RETURNING id`,
    [
      configuration.type,
      configuration.issuingAuthority,
      lookupHash,
      encrypted.identifier.ciphertext,
      encrypted.identifier.iv,
      encrypted.identifier.tag,
      encrypted.firstName.ciphertext,
      encrypted.firstName.iv,
      encrypted.firstName.tag,
      encrypted.lastName.ciphertext,
      encrypted.lastName.iv,
      encrypted.lastName.tag,
      encrypted.dateOfBirth.ciphertext,
      encrypted.dateOfBirth.iv,
      encrypted.dateOfBirth.tag,
      encrypted.keyVersion,
      sex,
      actorUserId,
      now,
    ],
  );
  const patientId = patient.rows[0]!.id;
  await client.query(
    `INSERT INTO insight.research_cases
       (patient_id, started_at, created_by_user_id, updated_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $2, $2)`,
    [patientId, now, actorUserId],
  );
  return (await patientById(client, patientId))!;
}

async function updatePatient(
  client: PoolClient,
  patientId: string,
  actorUserId: string,
  encrypted: ReturnType<typeof encryptPatient>,
  sex: PatientSex,
  now: Date,
): Promise<PatientRow> {
  await client.query(
    `UPDATE insight.patients SET
       official_identifier_ciphertext = $2,
       official_identifier_iv = $3,
       official_identifier_tag = $4,
       first_name_ciphertext = $5,
       first_name_iv = $6,
       first_name_tag = $7,
       last_name_ciphertext = $8,
       last_name_iv = $9,
       last_name_tag = $10,
       date_of_birth_ciphertext = $11,
       date_of_birth_iv = $12,
       date_of_birth_tag = $13,
       encryption_key_version = $14,
       sex = $15,
       updated_by_user_id = $16,
       updated_at = $17,
       record_version = record_version + 1
     WHERE id = $1`,
    [
      patientId,
      encrypted.identifier.ciphertext,
      encrypted.identifier.iv,
      encrypted.identifier.tag,
      encrypted.firstName.ciphertext,
      encrypted.firstName.iv,
      encrypted.firstName.tag,
      encrypted.lastName.ciphertext,
      encrypted.lastName.iv,
      encrypted.lastName.tag,
      encrypted.dateOfBirth.ciphertext,
      encrypted.dateOfBirth.iv,
      encrypted.dateOfBirth.tag,
      encrypted.keyVersion,
      sex,
      actorUserId,
      now,
    ],
  );
  return (await patientById(client, patientId))!;
}

async function auditPatientSave(
  client: PoolClient,
  eventType: PatientAuditEvent["eventType"],
  patient: PatientRow,
  actorUserId: string,
  requestId: string,
  before: PatientDemographics | null,
  after: PatientDemographics | null,
  key: EncryptionKeyRow,
  now: Date,
): Promise<void> {
  const encryptedBefore = before ? encryptJson(before, key.key_material, "patient-audit") : null;
  const encryptedAfter = after ? encryptJson(after, key.key_material, "patient-audit") : null;
  await client.query(
    `INSERT INTO insight.patient_audit_events (
       event_type, patient_id, research_case_id, target_version, actor_user_id, request_id,
       before_values_ciphertext, before_values_iv, before_values_tag,
       after_values_ciphertext, after_values_iv, after_values_tag,
       encryption_key_version, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      eventType,
      patient.id,
      patient.research_case_id,
      patient.record_version,
      actorUserId,
      requestId,
      encryptedBefore?.ciphertext ?? null,
      encryptedBefore?.iv ?? null,
      encryptedBefore?.tag ?? null,
      encryptedAfter?.ciphertext ?? null,
      encryptedAfter?.iv ?? null,
      encryptedAfter?.tag ?? null,
      key.version,
      now,
    ],
  );
}

function encryptText(value: string, key: Buffer, purpose: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`insight:${purpose}:v1`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptField(row: PatientRow, field: string, key: Buffer): string {
  const source = row as unknown as Record<string, Buffer>;
  return decryptText(
    {
      ciphertext: source[`${field}_ciphertext`]!,
      iv: source[`${field}_iv`]!,
      tag: source[`${field}_tag`]!,
    },
    key,
    field.replaceAll("_", "-"),
  );
}

function decryptText(encrypted: EncryptedValue, key: Buffer, purpose: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(Buffer.from(`insight:${purpose}:v1`));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

function encryptJson(value: PatientDemographics, key: Buffer, purpose: string): EncryptedValue {
  return encryptText(JSON.stringify(value), key, purpose);
}

function decryptJson(value: EncryptedValue, key: Buffer, purpose: string): PatientDemographics {
  return JSON.parse(decryptText(value, key, purpose)) as PatientDemographics;
}

function decryptDemographics(row: PatientRow, key: Buffer): PatientDemographics {
  return {
    firstName: decryptField(row, "first_name", key),
    lastName: decryptField(row, "last_name", key),
    dateOfBirth: decryptField(row, "date_of_birth", key),
    sex: row.sex,
  };
}

function materializePatient(
  row: PatientRow,
  officialIdentifier: string,
  demographics: PatientDemographics,
  now: Date,
): PatientRecord {
  return {
    id: row.id,
    officialIdentifier: {
      type: row.official_identifier_type,
      issuingAuthority: row.official_identifier_issuer,
      value: officialIdentifier,
    },
    ...demographics,
    profileAge: calculateAge(demographics.dateOfBirth, localCalendarDate(now)),
    researchCase: {
      id: row.research_case_id,
      startedAt: row.started_at.toISOString(),
      ageAtStart: calculateAge(demographics.dateOfBirth, localCalendarDate(row.started_at)),
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function materializeStoredPatient(row: PatientRow, key: Buffer, now: Date): PatientRecord {
  return materializePatient(
    row,
    decryptField(row, "official_identifier", key),
    decryptDemographics(row, key),
    now,
  );
}

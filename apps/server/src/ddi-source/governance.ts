import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  DdiExtractedInteraction,
  DdiPermissionRecord,
  DdiSourceManifest,
  DdiSourceVersion,
  Role,
} from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export const MEDSCAPE_PARSER_VERSION = "medscape-text-v1";
export const DDI_TRANSFORM_VERSION = "ddi-evidence-v1";

type DdiLifecycle = DdiSourceVersion["lifecycle"];

export interface DdiSourceActor {
  readonly id: string;
  readonly role: Role;
}

export interface DdiSourceImport {
  readonly manifest: DdiSourceManifest;
  readonly artifact: Uint8Array;
}

interface SourceRow extends QueryResultRow {
  id: string;
  version: number;
  drug_identity: string;
  title: string;
  source_url: string;
  publisher: string;
  retrieved_at: Date;
  content_date: string | Date;
  content_hash: string;
  parser_version: string;
  transform_version: string;
  reviewer_id: string;
  reviewed_at: Date;
  review_reference: string;
  permission_record: DdiPermissionRecord;
  artifact_path: string;
  artifact_media_type: "text/plain; charset=utf-8";
  artifact_byte_length: string | number;
  interactions: DdiExtractedInteraction[];
  imported_by_user_id: string;
  imported_at: Date;
  lifecycle: DdiLifecycle;
  legal_approval_reference: string | null;
  clinical_approval_reference: string | null;
}

export class DdiSourceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DdiSourceInputError";
  }
}

export class DdiSourceAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to access the DDI source operation.");
    this.name = "DdiSourceAuthorizationError";
  }
}

export class DdiSourceLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DdiSourceLifecycleError";
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateDdiSourceManifest(manifest: DdiSourceManifest): DdiSourceManifest {
  if (!manifest.permission) throw new DdiSourceInputError("Permission record is required.");
  const normalized = {
    ...manifest,
    drugIdentity: governedId(manifest.drugIdentity, "Drug identity"),
    title: requiredText(manifest.title, "Title"),
    url: validateMedscapeUrl(manifest.url),
    publisher: requiredText(manifest.publisher, "Publisher"),
    contentDate: validateDate(manifest.contentDate, "Content date"),
    parserVersion: requiredText(manifest.parserVersion, "Parser version"),
    transformVersion: requiredText(manifest.transformVersion, "Transform version"),
    reviewerId: requiredText(manifest.reviewerId, "Reviewer"),
    reviewReference: requiredText(manifest.reviewReference, "Review reference"),
    permission: {
      ...manifest.permission,
      basis: requiredText(manifest.permission.basis, "Permission basis"),
      recordReference: requiredText(
        manifest.permission.recordReference,
        "Permission record reference",
      ),
    },
  };
  if (normalized.publisher.toLowerCase() !== "medscape") {
    throw new DdiSourceInputError("Publisher must be Medscape.");
  }
  validateTimestamp(normalized.retrievedAt, "Retrieval time");
  validateTimestamp(normalized.reviewedAt, "Review time");
  if (!/^[0-9a-f]{64}$/.test(normalized.sha256)) {
    throw new DdiSourceInputError("SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  if (normalized.parserVersion !== MEDSCAPE_PARSER_VERSION) {
    throw new DdiSourceInputError(`Unsupported parser version: ${normalized.parserVersion}.`);
  }
  if (normalized.transformVersion !== DDI_TRANSFORM_VERSION) {
    throw new DdiSourceInputError(`Unsupported transform version: ${normalized.transformVersion}.`);
  }
  if (normalized.lifecycle !== "quarantined") {
    throw new DdiSourceInputError("Imported DDI sources must start quarantined.");
  }
  return normalized;
}

export function extractMedscapeInteractions(
  artifact: Uint8Array,
  sourceSha256: string,
): DdiExtractedInteraction[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(artifact);
  } catch {
    throw new DdiSourceInputError("Artifact must be valid UTF-8 text.");
  }
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const severities: Readonly<Record<string, DdiExtractedInteraction["severity"]>> = {
    contraindicated: "contraindicated",
    serious: "serious",
    "monitor closely": "monitor_closely",
    minor: "minor",
  };
  const interactions: DdiExtractedInteraction[] = [];
  let inInteractions = false;
  let severity: DdiExtractedInteraction["severity"] | undefined;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "Interactions") {
      inInteractions = true;
      continue;
    }
    if (!inInteractions) continue;
    if (/^Adverse Effects$/i.test(line)) break;
    const heading = /^([A-Za-z ]+)\s*\(\d+\)$/.exec(line);
    if (heading) {
      severity = severities[heading[1].trim().toLowerCase()];
      continue;
    }
    if (severity && /^[•*-]\s+\S/.test(line)) {
      const evidence = line.replace(/^[•*-]\s+/, "");
      const separator = evidence.indexOf(":");
      if (separator < 1) {
        throw new DdiSourceInputError("Interaction evidence must identify the interacting drug.");
      }
      const interactingDrugIdentity = evidence.slice(0, separator).trim();
      const detail = evidence.slice(separator + 1).trim();
      if (!interactingDrugIdentity || !detail) {
        throw new DdiSourceInputError("Interaction evidence must identify the interacting drug.");
      }
      const fields = Object.fromEntries(
        detail
          .split(";")
          .map((part) => /^\s*(mechanism|effect|action)\s*:\s*(.+)\s*$/i.exec(part))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => [match[1]!.toLowerCase(), match[2]!.trim()]),
      );
      interactions.push({
        interactingDrugIdentity,
        severity,
        evidenceText: line,
        ...(fields.mechanism ? { mechanism: fields.mechanism } : {}),
        ...(fields.effect ? { clinicalEffect: fields.effect } : { clinicalEffect: detail }),
        ...(fields.action ? { recommendedAction: fields.action } : {}),
        evidenceReference: { sourceSha256, lineStart: index + 1, lineEnd: index + 1 },
      });
    }
  }
  if (!inInteractions || interactions.length === 0) {
    throw new DdiSourceInputError("Artifact contains no extractable Medscape interactions.");
  }
  return interactions;
}

export function assertLifecycleTransition(from: DdiLifecycle, to: DdiLifecycle): void {
  const allowed: Readonly<Record<DdiLifecycle, readonly DdiLifecycle[]>> = {
    quarantined: ["reviewed", "rejected"],
    reviewed: ["active", "rejected"],
    active: ["superseded", "rejected"],
    superseded: [],
    rejected: [],
  };
  if (!allowed[from].includes(to)) {
    throw new DdiSourceLifecycleError(`DDI source cannot transition from ${from} to ${to}.`);
  }
}

export function assertActivationAuthorized(
  source: Pick<DdiSourceVersion, "lifecycle" | "manifest">,
  legalApprovalReference: string,
  clinicalApprovalReference: string,
): void {
  assertLifecycleTransition(source.lifecycle, "active");
  const permission = source.manifest.permission;
  if (
    permission.status !== "granted" ||
    !permission.coversStorage ||
    !permission.coversTransformation ||
    !permission.coversResearchUse
  ) {
    throw new DdiSourceLifecycleError("DDI source permission does not cover required use.");
  }
  requiredText(legalApprovalReference, "Legal approval reference");
  requiredText(clinicalApprovalReference, "Clinical approval reference");
}

export async function importDdiSource(
  pool: Pool,
  actor: DdiSourceActor,
  input: DdiSourceImport,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<DdiSourceVersion> {
  requireAdministrator(actor);
  const now = options.now ?? new Date();
  const manifest = validateDdiSourceManifest(input.manifest);
  const hash = sha256(input.artifact);
  if (hash !== manifest.sha256)
    throw new DdiSourceInputError("Artifact SHA-256 does not match manifest.");
  const interactions = extractMedscapeInteractions(input.artifact, hash);
  const artifactPath = await storeArtifact(
    options.artifactRoot ?? resolve("artifacts"),
    input.artifact,
    hash,
  );
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [manifest.drugIdentity]);
    const existing = await loadSources(client, {
      identity: manifest.drugIdentity,
      hash,
      parserVersion: manifest.parserVersion,
      transformVersion: manifest.transformVersion,
    });
    if (existing[0]) return existing[0];
    const next = await client.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::integer + 1 AS version
       FROM insight.ddi_source_versions WHERE drug_identity = $1`,
      [manifest.drugIdentity],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO insight.ddi_source_versions (
         version, drug_identity, title, source_url, publisher, retrieved_at, content_date,
         content_hash, parser_version, transform_version, reviewer_id, reviewed_at,
         review_reference, permission_record, artifact_path, artifact_media_type,
         artifact_byte_length, interactions, imported_by_user_id, imported_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        next.rows[0].version,
        manifest.drugIdentity,
        manifest.title,
        manifest.url,
        manifest.publisher,
        manifest.retrievedAt,
        manifest.contentDate,
        hash,
        manifest.parserVersion,
        manifest.transformVersion,
        manifest.reviewerId,
        manifest.reviewedAt,
        manifest.reviewReference,
        JSON.stringify(manifest.permission),
        artifactPath,
        "text/plain; charset=utf-8",
        input.artifact.byteLength,
        JSON.stringify(interactions),
        actor.id,
        now,
      ],
    );
    await insertLifecycleEvent(
      client,
      inserted.rows[0].id,
      "quarantined",
      actor.id,
      now,
      manifest.reviewReference,
      null,
      null,
    );
    return (await loadSources(client, { id: inserted.rows[0].id }))[0]!;
  });
}

export async function reviewDdiSource(
  pool: Pool,
  actor: DdiSourceActor,
  id: string,
  decision: "reviewed" | "rejected",
  reviewReference: string,
  now = new Date(),
): Promise<DdiSourceVersion> {
  requireAdministrator(actor);
  requiredText(reviewReference, "Review reference");
  return withTransaction(pool, async (client) => {
    const source = await lockedSource(client, id);
    assertLifecycleTransition(source.lifecycle, decision);
    await insertLifecycleEvent(client, id, decision, actor.id, now, reviewReference, null, null);
    return (await loadSources(client, { id }))[0]!;
  });
}

export async function activateDdiSource(
  pool: Pool,
  actor: DdiSourceActor,
  id: string,
  approvals: {
    readonly legalApprovalReference: string;
    readonly clinicalApprovalReference: string;
  },
  now = new Date(),
): Promise<DdiSourceVersion> {
  requireAdministrator(actor);
  return withTransaction(pool, async (client) => {
    const source = await lockedSource(client, id);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      source.manifest.drugIdentity,
    ]);
    assertActivationAuthorized(
      source,
      approvals.legalApprovalReference,
      approvals.clinicalApprovalReference,
    );
    const prior = await client.query<{ source_version_id: string }>(
      `SELECT source_version_id FROM insight.ddi_active_sources
       WHERE drug_identity = $1 FOR UPDATE`,
      [source.manifest.drugIdentity],
    );
    if (prior.rows[0] && prior.rows[0].source_version_id !== id) {
      await insertLifecycleEvent(
        client,
        prior.rows[0].source_version_id,
        "superseded",
        actor.id,
        now,
        null,
        null,
        null,
      );
    }
    await insertLifecycleEvent(
      client,
      id,
      "active",
      actor.id,
      now,
      null,
      approvals.legalApprovalReference,
      approvals.clinicalApprovalReference,
    );
    await client.query(
      `INSERT INTO insight.ddi_active_sources
         (drug_identity, source_version_id, activated_by_user_id, activated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (drug_identity) DO UPDATE SET source_version_id = excluded.source_version_id,
         activated_by_user_id = excluded.activated_by_user_id, activated_at = excluded.activated_at`,
      [source.manifest.drugIdentity, id, actor.id, now],
    );
    return (await loadSources(client, { id }))[0]!;
  });
}

export async function getDdiSourceHistory(
  pool: Pool,
  actor: DdiSourceActor,
): Promise<readonly DdiSourceVersion[]> {
  requireAdministrator(actor);
  return loadSources(pool);
}

export async function getActiveDdiSources(
  pool: Pool,
  actor: DdiSourceActor,
): Promise<readonly DdiSourceVersion[]> {
  if (actor.role !== "PSYCHIATRIST" && actor.role !== "ADMINISTRATOR") {
    throw new DdiSourceAuthorizationError();
  }
  return loadSources(pool, { activeOnly: true });
}

async function lockedSource(client: PoolClient, id: string): Promise<DdiSourceVersion> {
  await client.query("SELECT id FROM insight.ddi_source_versions WHERE id = $1 FOR UPDATE", [id]);
  const source = (await loadSources(client, { id }))[0];
  if (!source) throw new DdiSourceInputError("DDI source version was not found.");
  return source;
}

async function insertLifecycleEvent(
  client: PoolClient,
  sourceVersionId: string,
  lifecycle: DdiLifecycle,
  actorId: string,
  occurredAt: Date,
  eventReference: string | null,
  legalApprovalReference: string | null,
  clinicalApprovalReference: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO insight.ddi_source_lifecycle_events (
       source_version_id, lifecycle, actor_user_id, occurred_at,
       event_reference, legal_approval_reference, clinical_approval_reference
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      sourceVersionId,
      lifecycle,
      actorId,
      occurredAt,
      eventReference,
      legalApprovalReference,
      clinicalApprovalReference,
    ],
  );
}

async function loadSources(
  database: Pool | PoolClient,
  options: {
    id?: string;
    identity?: string;
    hash?: string;
    parserVersion?: string;
    transformVersion?: string;
    activeOnly?: boolean;
  } = {},
): Promise<DdiSourceVersion[]> {
  const values: string[] = [];
  const conditions: string[] = [];
  const add = (condition: string, value: string) => {
    values.push(value);
    conditions.push(condition.replace("?", `$${values.length}`));
  };
  if (options.id) add("source.id = ?", options.id);
  if (options.identity) add("source.drug_identity = ?", options.identity);
  if (options.hash) add("source.content_hash = ?", options.hash);
  if (options.parserVersion) add("source.parser_version = ?", options.parserVersion);
  if (options.transformVersion) add("source.transform_version = ?", options.transformVersion);
  if (options.activeOnly) conditions.push("active.source_version_id = source.id");
  const result = await database.query<SourceRow>(
    `SELECT source.*, source.content_date::text AS content_date,
       latest.lifecycle, latest.legal_approval_reference,
       latest.clinical_approval_reference
     FROM insight.ddi_source_versions source
     LEFT JOIN insight.ddi_active_sources active ON active.drug_identity = source.drug_identity
     JOIN LATERAL (
       SELECT lifecycle, legal_approval_reference, clinical_approval_reference
       FROM insight.ddi_source_lifecycle_events event
       WHERE event.source_version_id = source.id ORDER BY event.sequence DESC LIMIT 1
     ) latest ON true
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY source.drug_identity, source.version DESC`,
    values,
  );
  return result.rows.map(materializeSource);
}

function materializeSource(row: SourceRow): DdiSourceVersion {
  const contentDate =
    row.content_date instanceof Date
      ? row.content_date.toISOString().slice(0, 10)
      : String(row.content_date);
  return {
    id: row.id,
    version: Number(row.version),
    manifest: {
      drugIdentity: row.drug_identity,
      title: row.title,
      url: row.source_url,
      publisher: row.publisher,
      retrievedAt: row.retrieved_at.toISOString(),
      contentDate,
      sha256: row.content_hash,
      parserVersion: row.parser_version,
      transformVersion: row.transform_version,
      reviewerId: row.reviewer_id,
      reviewedAt: row.reviewed_at.toISOString(),
      reviewReference: row.review_reference,
      permission: row.permission_record,
      lifecycle: "quarantined",
    },
    artifact: {
      path: row.artifact_path,
      mediaType: row.artifact_media_type,
      byteLength: Number(row.artifact_byte_length),
    },
    interactions: row.interactions,
    lifecycle: row.lifecycle,
    importedByUserId: row.imported_by_user_id,
    importedAt: row.imported_at.toISOString(),
    legalApprovalReference: row.legal_approval_reference,
    clinicalApprovalReference: row.clinical_approval_reference,
  };
}

async function storeArtifact(
  artifactRoot: string,
  bytes: Uint8Array,
  hash: string,
): Promise<string> {
  const relativePath = `ddi-sources/${hash}.txt`;
  const path = resolve(artifactRoot, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o640 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (sha256(await readFile(path)) !== hash) {
      throw new DdiSourceInputError("Existing artifact does not match its content hash.");
    }
  }
  return relativePath;
}

function requireAdministrator(actor: DdiSourceActor): void {
  if (actor.role !== "ADMINISTRATOR") throw new DdiSourceAuthorizationError();
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new DdiSourceInputError(`${label} cannot be blank.`);
  return trimmed;
}

function governedId(value: string, label: string): string {
  const id = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new DdiSourceInputError(`${label} is not a valid governed ID.`);
  }
  return id;
}

function validateMedscapeUrl(value: string): string {
  const text = requiredText(value, "URL");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DdiSourceInputError("URL is invalid.");
  }
  if (url.protocol !== "https:" || !/(^|\.)medscape\.com$/i.test(url.hostname)) {
    throw new DdiSourceInputError("URL must be an HTTPS Medscape URL.");
  }
  return url.href;
}

function validateTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DdiSourceInputError(`${label} must be an ISO timestamp.`);
  }
}

function validateDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DdiSourceInputError(`${label} must be an ISO date.`);
  }
  return value;
}

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  edgesOf,
  findDefinition,
  importBnModel,
  parsePositionProperty,
  parseXmlBif,
  type BnModelImport,
  type BnModelVersion as ImportedBnModel,
} from "@insight/bayes";
import type { BnModelVersion, Role } from "@insight/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export interface BnModelActor {
  readonly id: string;
  readonly role: Role;
}

interface ModelRow extends QueryResultRow {
  id: string;
  pathway_identity: string;
  version: number;
  artifact_path: string;
  media_type: "application/xml";
  byte_length: string | number;
  content_sha256: string;
  semantic_sha256: string | null;
  topology_sha256: string | null;
  importer_version: string;
  validation_report: ImportedBnModel["validationReport"];
  evidence_metadata: ImportedBnModel["evidence"];
  calibration_metadata: ImportedBnModel["calibration"];
  clinical_review_metadata: ImportedBnModel["clinicalReview"];
  lifecycle: ImportedBnModel["lifecycle"];
  quarantine_reason: string | null;
  imported_by_user_id: string;
  imported_at: Date;
  source_reference: string;
}

export class BnModelAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to access Bayesian models.");
    this.name = "BnModelAuthorizationError";
  }
}

export class BnModelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BnModelInputError";
  }
}

export async function importAndRegisterBnModel(
  pool: Pool,
  actor: BnModelActor,
  input: BnModelImport,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<BnModelVersion> {
  requireAdministrator(actor);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(input.candidate.pathwayIdentity)) {
    throw new BnModelInputError(
      "Pathway identity must use uppercase letters, numbers, and underscores.",
    );
  }
  const sourceReference = basename(input.candidate.artifactPath.trim());
  if (!sourceReference || sourceReference === "." || sourceReference.length > 500) {
    throw new BnModelInputError("Source file name is invalid.");
  }

  const imported = await importBnModel(input);
  const now = options.now ?? new Date();
  const artifactRoot = options.artifactRoot ?? resolve("artifacts");
  const artifactPath = await storeArtifact(
    artifactRoot,
    input.source,
    imported.artifact.contentSha256,
  );
  const modelId = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [imported.pathwayIdentity]);
    const existing = await client.query<{ id: string }>(
      `SELECT model.id FROM insight.bn_model_versions model
       JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
       WHERE model.pathway_identity = $1 AND artifact.content_sha256 = $2`,
      [imported.pathwayIdentity, imported.artifact.contentSha256],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const next = await client.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::integer + 1 AS version
       FROM insight.bn_model_versions WHERE pathway_identity = $1`,
      [imported.pathwayIdentity],
    );
    const artifact = await client.query<{ id: string }>(
      `INSERT INTO insight.bn_model_artifacts (
         artifact_path, media_type, byte_length, content_sha256, semantic_sha256,
         topology_sha256, stored_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        artifactPath,
        imported.artifact.mediaType,
        imported.artifact.byteLength,
        imported.artifact.contentSha256,
        imported.artifact.semanticSha256,
        imported.artifact.topologySha256,
        now,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO insight.bn_model_versions (
         pathway_identity, version, artifact_id, registry_schema_version, importer_version,
         validation_report, evidence_metadata, calibration_metadata, clinical_review_metadata,
         initial_lifecycle, quarantine_reason, imported_by_user_id, imported_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        imported.pathwayIdentity,
        next.rows[0]!.version,
        artifact.rows[0]!.id,
        imported.validationReport.schemaVersion,
        imported.validationReport.importerVersion,
        JSON.stringify(imported.validationReport),
        JSON.stringify(imported.evidence),
        JSON.stringify(imported.calibration),
        JSON.stringify(imported.clinicalReview),
        imported.lifecycle,
        imported.quarantineReason,
        actor.id,
        now,
      ],
    );
    await client.query(
      `INSERT INTO insight.bn_model_lifecycle_events
         (model_version_id, lifecycle, actor_user_id, occurred_at, event_reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [inserted.rows[0]!.id, imported.lifecycle, actor.id, now, sourceReference],
    );
    if (imported.lifecycle === "ACTIVE") {
      await activateImportedModel(
        client,
        imported.pathwayIdentity,
        inserted.rows[0]!.id,
        actor.id,
        now,
      );
    }
    return inserted.rows[0]!.id;
  });
  return (await loadModels(pool, artifactRoot, modelId))[0]!;
}

export async function getBnModelHistory(
  pool: Pool,
  actor: BnModelActor,
  artifactRoot = resolve("artifacts"),
): Promise<readonly BnModelVersion[]> {
  requireAdministrator(actor);
  return loadModels(pool, artifactRoot);
}

async function activateImportedModel(
  client: PoolClient,
  pathwayIdentity: string,
  modelId: string,
  actorId: string,
  now: Date,
): Promise<void> {
  const previous = await client.query<{ model_version_id: string }>(
    `SELECT model_version_id FROM insight.bn_active_models
     WHERE pathway_identity = $1 FOR UPDATE`,
    [pathwayIdentity],
  );
  if (previous.rows[0] && previous.rows[0].model_version_id !== modelId) {
    await client.query(
      `INSERT INTO insight.bn_model_lifecycle_events
         (model_version_id, lifecycle, actor_user_id, occurred_at, event_reference)
       VALUES ($1,'SUPERSEDED',$2,$3,$4)`,
      [previous.rows[0].model_version_id, actorId, now, `superseded-by:${modelId}`],
    );
  }
  await client.query(
    `INSERT INTO insight.bn_active_models
       (pathway_identity, model_version_id, activated_by_user_id, activated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (pathway_identity) DO UPDATE SET
       model_version_id = EXCLUDED.model_version_id,
       activated_by_user_id = EXCLUDED.activated_by_user_id,
       activated_at = EXCLUDED.activated_at`,
    [pathwayIdentity, modelId, actorId, now],
  );
}

async function loadModels(
  database: Pool | PoolClient,
  artifactRoot: string,
  id?: string,
): Promise<BnModelVersion[]> {
  const result = await database.query<ModelRow>(
    `SELECT model.id, model.pathway_identity, model.version, artifact.artifact_path,
       artifact.media_type, artifact.byte_length, artifact.content_sha256,
       artifact.semantic_sha256, artifact.topology_sha256, model.importer_version,
       model.validation_report, model.evidence_metadata, model.calibration_metadata,
       model.clinical_review_metadata, latest.lifecycle, model.quarantine_reason,
       model.imported_by_user_id, model.imported_at, initial.event_reference AS source_reference
     FROM insight.bn_model_versions model
     JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
     JOIN LATERAL (
       SELECT lifecycle FROM insight.bn_model_lifecycle_events event
       WHERE event.model_version_id = model.id ORDER BY sequence DESC LIMIT 1
     ) latest ON true
     JOIN LATERAL (
       SELECT event_reference FROM insight.bn_model_lifecycle_events event
       WHERE event.model_version_id = model.id ORDER BY sequence LIMIT 1
     ) initial ON true
     ${id ? "WHERE model.id = $1" : ""}
     ORDER BY model.pathway_identity, model.version DESC`,
    id ? [id] : [],
  );
  return Promise.all(result.rows.map((row) => materializeModel(row, artifactRoot)));
}

async function materializeModel(row: ModelRow, artifactRoot: string): Promise<BnModelVersion> {
  const parsed = parseXmlBif(await readFile(resolve(artifactRoot, row.artifact_path), "utf8"));
  return {
    id: row.id,
    pathwayIdentity: row.pathway_identity,
    version: Number(row.version),
    lifecycle: row.lifecycle,
    quarantineReason: row.quarantine_reason,
    source: {
      fileName: row.source_reference,
      mediaType: row.media_type,
      byteLength: Number(row.byte_length),
      contentSha256: row.content_sha256,
      semanticSha256: row.semantic_sha256,
      topologySha256: row.topology_sha256,
      importerVersion: row.importer_version,
      importedByUserId: row.imported_by_user_id,
      importedAt: row.imported_at.toISOString(),
    },
    validation: {
      softwareCompatible: row.validation_report.softwareCompatible,
      clinicalValidity: row.validation_report.clinicalValidity,
      checks: [...row.validation_report.checks],
      diagnostics: [...row.validation_report.diagnostics],
    },
    evidence: row.evidence_metadata,
    calibration: row.calibration_metadata,
    clinicalReview: row.clinical_review_metadata,
    networks: parsed.ok
      ? parsed.file.networks.map((network) => ({
          name: network.name,
          nodes: network.variables.map((variable) => {
            const definition = findDefinition(network, variable.name);
            return {
              id: variable.name,
              type: variable.type,
              outcomes: variable.outcomes,
              parents: definition?.given ?? [],
              properties: variable.properties.map(({ text }) => text),
              tableValueCount: definition?.table.length ?? 0,
              position:
                variable.properties
                  .map(({ text }) => parsePositionProperty(text))
                  .find((value) => value !== null) ?? null,
            };
          }),
          edges: edgesOf(network),
        }))
      : [],
  };
}

async function storeArtifact(root: string, source: string, hash: string): Promise<string> {
  const relativePath = `bn-models/${hash}.xml`;
  const path = resolve(root, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  try {
    await writeFile(path, source, { flag: "wx", mode: 0o640 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== hash
    ) {
      throw new BnModelInputError("Existing BN artifact does not match its content hash.");
    }
  }
  return relativePath;
}

function requireAdministrator(actor: BnModelActor): void {
  if (actor.role !== "ADMINISTRATOR") throw new BnModelAuthorizationError();
}

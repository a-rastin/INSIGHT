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

export interface BnModelExecutionPin {
  readonly researchCaseId: string;
  readonly pathwayIdentity: string;
  readonly modelId: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly semanticSha256: string;
  readonly pinnedAt: string;
}

interface PinRow extends QueryResultRow {
  research_case_id: string;
  pathway_identity: string;
  model_version_id: string;
  model_version: number;
  content_sha256: string;
  semantic_sha256: string;
  pinned_at: Date;
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

export class BnModelUnavailableError extends Error {
  constructor() {
    super("No active compatible Bayesian model exists for the pathway.");
    this.name = "BnModelUnavailableError";
  }
}

export async function importAndRegisterBnModel(
  pool: Pool,
  actor: BnModelActor,
  input: BnModelImport,
  options: {
    readonly now?: Date;
    readonly artifactRoot?: string;
    readonly candidateOnly?: boolean;
  } = {},
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
  if (options.candidateOnly && !imported.validationReport.softwareCompatible) {
    throw new BnModelInputError("Edited model must pass all software validation checks.");
  }
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
    if (existing.rows[0]) {
      if (options.candidateOnly) {
        throw new BnModelInputError("Edited model must differ from every existing version.");
      }
      return existing.rows[0].id;
    }

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
    const lifecycle = imported.lifecycle;
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
        lifecycle,
        imported.quarantineReason,
        actor.id,
        now,
      ],
    );
    await insertLifecycleEvent(
      client,
      inserted.rows[0]!.id,
      "IMPORTED",
      actor.id,
      now,
      sourceReference,
    );
    if (lifecycle !== "ACTIVE") {
      await insertLifecycleEvent(
        client,
        inserted.rows[0]!.id,
        lifecycle,
        actor.id,
        now,
        sourceReference,
      );
    }
    if (lifecycle === "ACTIVE") {
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

export async function getBnModelSource(
  pool: Pool,
  actor: BnModelActor,
  modelId: string,
  artifactRoot = resolve("artifacts"),
): Promise<string> {
  requireAdministrator(actor);
  const result = await pool.query<{ artifact_path: string }>(
    `SELECT artifact.artifact_path FROM insight.bn_model_versions model
     JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
     WHERE model.id = $1`,
    [modelId],
  );
  if (!result.rows[0]) throw new BnModelInputError("Bayesian model version does not exist.");
  return readFile(resolve(artifactRoot, result.rows[0].artifact_path), "utf8");
}

export async function createBnModelCandidate(
  pool: Pool,
  actor: BnModelActor,
  sourceModelId: string,
  source: string,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<BnModelVersion> {
  requireAdministrator(actor);
  const base = await pool.query<{ pathway_identity: string; version: number }>(
    `SELECT pathway_identity, version FROM insight.bn_model_versions WHERE id = $1`,
    [sourceModelId],
  );
  if (!base.rows[0]) throw new BnModelInputError("Bayesian model version does not exist.");
  return importAndRegisterBnModel(
    pool,
    actor,
    {
      candidate: {
        pathwayIdentity: base.rows[0].pathway_identity,
        artifactPath: `${base.rows[0].pathway_identity.toLowerCase()}-edit-v${base.rows[0].version}.xml`,
        version: base.rows[0].version + 1,
      },
      source,
    },
    { ...options, candidateOnly: true },
  );
}

export async function getBnModelHistory(
  pool: Pool,
  actor: BnModelActor,
  artifactRoot = resolve("artifacts"),
): Promise<readonly BnModelVersion[]> {
  requireAdministrator(actor);
  return loadModels(pool, artifactRoot);
}

export async function disableBnModel(
  pool: Pool,
  actor: BnModelActor,
  modelId: string,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<BnModelVersion> {
  requireAdministrator(actor);
  const now = options.now ?? new Date();
  await withTransaction(pool, async (client) => {
    const model = await client.query<{ pathway_identity: string }>(
      "SELECT pathway_identity FROM insight.bn_model_versions WHERE id = $1",
      [modelId],
    );
    if (!model.rows[0]) throw new BnModelInputError("Bayesian model version does not exist.");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      model.rows[0].pathway_identity,
    ]);
    const removed = await client.query(
      `DELETE FROM insight.bn_active_models
       WHERE pathway_identity = $1 AND model_version_id = $2`,
      [model.rows[0].pathway_identity, modelId],
    );
    if (removed.rowCount !== 1) {
      throw new BnModelInputError("Only the active Bayesian model can be disabled.");
    }
    await insertLifecycleEvent(client, modelId, "DISABLED", actor.id, now, "administrator-disable");
  });
  return (await loadModels(pool, options.artifactRoot ?? resolve("artifacts"), modelId))[0]!;
}

export async function rollbackBnModel(
  pool: Pool,
  actor: BnModelActor,
  modelId: string,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<BnModelVersion> {
  requireAdministrator(actor);
  const now = options.now ?? new Date();
  await withTransaction(pool, async (client) => {
    const model = await client.query<{
      pathway_identity: string;
      software_compatible: boolean;
      initial_lifecycle: ImportedBnModel["lifecycle"];
      version: number;
    }>(
      `SELECT pathway_identity, version,
              (validation_report->>'softwareCompatible')::boolean AS software_compatible,
              initial_lifecycle
       FROM insight.bn_model_versions WHERE id = $1`,
      [modelId],
    );
    if (!model.rows[0]) throw new BnModelInputError("Bayesian model version does not exist.");
    if (!model.rows[0].software_compatible || model.rows[0].initial_lifecycle === "QUARANTINED") {
      throw new BnModelInputError("Only a software-compatible Bayesian model can be restored.");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      model.rows[0].pathway_identity,
    ]);
    const latestActivated = await client.query<{ version: number }>(
      `SELECT max(model.version)::integer AS version
       FROM insight.bn_model_versions model
       JOIN insight.bn_model_lifecycle_events event ON event.model_version_id = model.id
       WHERE model.pathway_identity = $1 AND event.lifecycle = 'ACTIVE'`,
      [model.rows[0].pathway_identity],
    );
    if (model.rows[0].version >= (latestActivated.rows[0]?.version ?? 0)) {
      throw new BnModelInputError("Rollback requires an earlier passing Bayesian model version.");
    }
    const active = await client.query<{ model_version_id: string }>(
      "SELECT model_version_id FROM insight.bn_active_models WHERE pathway_identity = $1",
      [model.rows[0].pathway_identity],
    );
    if (active.rows[0]?.model_version_id === modelId) {
      throw new BnModelInputError("Bayesian model version is already active.");
    }
    await activateImportedModel(
      client,
      model.rows[0].pathway_identity,
      modelId,
      actor.id,
      now,
      "administrator-rollback",
    );
  });
  return (await loadModels(pool, options.artifactRoot ?? resolve("artifacts"), modelId))[0]!;
}

export async function pinBnModelForExecution(
  pool: Pool,
  researchCaseId: string,
  pathwayIdentity: string,
  now = new Date(),
): Promise<BnModelExecutionPin> {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(pathwayIdentity)) throw new BnModelUnavailableError();
  const row = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${researchCaseId}:${pathwayIdentity}`,
    ]);
    const existing = await loadPin(client, researchCaseId, pathwayIdentity);
    if (existing) return existing;
    const inserted = await client.query<PinRow>(
      `INSERT INTO insight.bn_research_case_model_pins (
         research_case_id, pathway_identity, model_version_id, model_version,
         content_sha256, semantic_sha256, pinned_at
       )
       SELECT $1, active.pathway_identity, model.id, model.version,
              artifact.content_sha256, artifact.semantic_sha256, $3
       FROM insight.bn_active_models active
       JOIN insight.bn_model_versions model ON model.id = active.model_version_id
       JOIN insight.bn_model_artifacts artifact ON artifact.id = model.artifact_id
       WHERE active.pathway_identity = $2
         AND (model.validation_report->>'softwareCompatible')::boolean
         AND artifact.semantic_sha256 IS NOT NULL
       RETURNING *`,
      [researchCaseId, pathwayIdentity, now],
    );
    if (!inserted.rows[0]) throw new BnModelUnavailableError();
    return inserted.rows[0];
  });
  return materializePin(row);
}

async function activateImportedModel(
  client: PoolClient,
  pathwayIdentity: string,
  modelId: string,
  actorId: string,
  now: Date,
  eventReference = "automatic-activation",
): Promise<void> {
  const previous = await client.query<{ model_version_id: string }>(
    `SELECT model_version_id FROM insight.bn_active_models
     WHERE pathway_identity = $1 FOR UPDATE`,
    [pathwayIdentity],
  );
  if (previous.rows[0] && previous.rows[0].model_version_id !== modelId) {
    await insertLifecycleEvent(
      client,
      previous.rows[0].model_version_id,
      "SUPERSEDED",
      actorId,
      now,
      `superseded-by:${modelId}`,
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
  await insertLifecycleEvent(client, modelId, "ACTIVE", actorId, now, eventReference);
}

async function insertLifecycleEvent(
  client: PoolClient,
  modelId: string,
  lifecycle: ImportedBnModel["lifecycle"],
  actorId: string,
  now: Date,
  reference: string,
): Promise<void> {
  await client.query(
    `INSERT INTO insight.bn_model_lifecycle_events
       (model_version_id, lifecycle, actor_user_id, occurred_at, event_reference)
     VALUES ($1,$2,$3,$4,$5)`,
    [modelId, lifecycle, actorId, now, reference],
  );
}

async function loadPin(
  client: PoolClient,
  researchCaseId: string,
  pathwayIdentity: string,
): Promise<PinRow | undefined> {
  const result = await client.query<PinRow>(
    `SELECT * FROM insight.bn_research_case_model_pins
     WHERE research_case_id = $1 AND pathway_identity = $2`,
    [researchCaseId, pathwayIdentity],
  );
  return result.rows[0];
}

function materializePin(row: PinRow): BnModelExecutionPin {
  return {
    researchCaseId: row.research_case_id,
    pathwayIdentity: row.pathway_identity,
    modelId: row.model_version_id,
    version: Number(row.model_version),
    contentSha256: row.content_sha256,
    semanticSha256: row.semantic_sha256,
    pinnedAt: row.pinned_at.toISOString(),
  };
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

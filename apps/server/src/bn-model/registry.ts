import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { importBnModel, type BnModelImport, type BnModelVersion } from "@insight/bayes";
import type { Role } from "@insight/contracts";
import type { Pool } from "pg";

import { withTransaction } from "../database/transaction.js";

export interface BnModelActor {
  readonly id: string;
  readonly role: Role;
}

export class BnModelAuthorizationError extends Error {
  constructor() {
    super("Role is not permitted to import Bayesian models.");
    this.name = "BnModelAuthorizationError";
  }
}

export async function importAndRegisterBnModel(
  pool: Pool,
  actor: BnModelActor,
  input: BnModelImport,
  options: { readonly now?: Date; readonly artifactRoot?: string } = {},
): Promise<BnModelVersion> {
  if (actor.role !== "ADMINISTRATOR") throw new BnModelAuthorizationError();
  const record = await importBnModel(input);
  const now = options.now ?? new Date();
  const artifactPath = await storeArtifact(
    options.artifactRoot ?? resolve("artifacts"),
    input.source,
    record.artifact.contentSha256,
  );

  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [record.pathwayIdentity]);
    const artifact = await client.query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO insight.bn_model_artifacts (
           artifact_path, media_type, byte_length, content_sha256, semantic_sha256,
           topology_sha256, stored_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (content_sha256) DO NOTHING
         RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM insight.bn_model_artifacts WHERE content_sha256 = $4
       LIMIT 1`,
      [
        artifactPath,
        record.artifact.mediaType,
        record.artifact.byteLength,
        record.artifact.contentSha256,
        record.artifact.semanticSha256,
        record.artifact.topologySha256,
        now,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO insight.bn_model_versions (
           pathway_identity, version, artifact_id, registry_schema_version, importer_version,
           validation_report, evidence_metadata, calibration_metadata, clinical_review_metadata,
           initial_lifecycle, quarantine_reason, imported_by_user_id, imported_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (pathway_identity, artifact_id) DO NOTHING
         RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM insight.bn_model_versions
       WHERE pathway_identity = $1 AND artifact_id = $3
       LIMIT 1`,
      [
        record.pathwayIdentity,
        record.version,
        artifact.rows[0].id,
        record.validationReport.schemaVersion,
        record.validationReport.importerVersion,
        JSON.stringify(record.validationReport),
        JSON.stringify(record.evidence),
        JSON.stringify(record.calibration),
        JSON.stringify(record.clinicalReview),
        record.lifecycle,
        record.quarantineReason,
        actor.id,
        now,
      ],
    );
    await client.query(
      `INSERT INTO insight.bn_model_lifecycle_events
         (model_version_id, lifecycle, actor_user_id, occurred_at, event_reference)
       SELECT $1,$2,$3,$4,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM insight.bn_model_lifecycle_events WHERE model_version_id = $1
       )`,
      [inserted.rows[0].id, record.lifecycle, actor.id, now, input.candidate.artifactPath],
    );

    if (record.lifecycle === "ACTIVE") {
      const previous = await client.query<{ model_version_id: string }>(
        `SELECT model_version_id FROM insight.bn_active_models
         WHERE pathway_identity = $1 FOR UPDATE`,
        [record.pathwayIdentity],
      );
      if (previous.rows[0] && previous.rows[0].model_version_id !== inserted.rows[0].id) {
        await client.query(
          `INSERT INTO insight.bn_model_lifecycle_events
             (model_version_id, lifecycle, actor_user_id, occurred_at, event_reference)
           VALUES ($1,'SUPERSEDED',$2,$3,$4)`,
          [
            previous.rows[0].model_version_id,
            actor.id,
            now,
            `superseded-by:${inserted.rows[0].id}`,
          ],
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
        [record.pathwayIdentity, inserted.rows[0].id, actor.id, now],
      );
    }
  });
  return record;
}

async function storeArtifact(root: string, source: string, hash: string): Promise<string> {
  const relativePath = `bn-models/${hash}.xml`;
  const path = resolve(root, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  try {
    await writeFile(path, source, { flag: "wx", mode: 0o640 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await importBnModel({
      candidate: { pathwayIdentity: "HASH_CHECK", artifactPath: relativePath, version: 1 },
      source: await readFile(path, "utf8"),
    });
    if (existing.artifact.contentSha256 !== hash) {
      throw new Error("Existing BN artifact does not match its content hash.");
    }
  }
  return relativePath;
}

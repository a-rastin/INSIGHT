import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { Pool, QueryResultRow } from "pg";

import { withTransaction } from "../database/transaction.js";

export type ArtifactKind = "XMLBIF" | "DDI_SOURCE" | "EXPORT" | "PROVENANCE";
export type ArtifactAccessClass = "ADMINISTRATOR" | "PSYCHIATRIST" | "OWNER";

export interface ArtifactActor {
  readonly id: string;
  readonly role: "ADMINISTRATOR" | "PSYCHIATRIST";
}

export interface StoreArtifactInput {
  readonly kind: ArtifactKind;
  readonly ownerId: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly accessClass: ArtifactAccessClass;
  readonly version: string;
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly ownerId: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly accessClass: ArtifactAccessClass;
  readonly version: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface StoredArtifact {
  readonly metadata: ArtifactMetadata;
  readonly bytes: Buffer;
}

interface ArtifactRow extends QueryResultRow {
  id: string;
  kind: ArtifactKind;
  owner_id: string;
  relative_path: string;
  media_type: string;
  byte_length: string;
  sha256: string;
  access_class: ArtifactAccessClass;
  artifact_version: string;
  created_by_user_id: string;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIVE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;
const POLICIES: Readonly<
  Record<ArtifactKind, { readonly mediaTypes: readonly string[]; readonly maxBytes: number }>
> = {
  XMLBIF: { mediaTypes: ["application/xml"], maxBytes: 10 * 1024 * 1024 },
  DDI_SOURCE: { mediaTypes: ["text/plain; charset=utf-8"], maxBytes: 50 * 1024 * 1024 },
  EXPORT: { mediaTypes: ["application/json", "application/pdf"], maxBytes: 25 * 1024 * 1024 },
  PROVENANCE: { mediaTypes: ["application/json"], maxBytes: 100 * 1024 * 1024 },
};

export class ArtifactInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactInputError";
  }
}

export class ArtifactAuthorizationError extends Error {
  constructor() {
    super("Artifact access is not authorized.");
    this.name = "ArtifactAuthorizationError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor() {
    super("Artifact was not found.");
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactIntegrityError extends Error {
  constructor() {
    super("Artifact content does not match its metadata.");
    this.name = "ArtifactIntegrityError";
  }
}

export async function storeArtifact(
  pool: Pool,
  actor: ArtifactActor,
  input: StoreArtifactInput,
  artifactRoot: string,
  now = new Date(),
): Promise<ArtifactMetadata> {
  validateInput(actor, input);
  const id = randomUUID();
  const ownerId = input.ownerId.toLowerCase();
  const relativePath = `${ownerId}/${id}`;
  const path = await safeNewPath(artifactRoot, relativePath);
  const bytes = Buffer.from(input.bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Metadata intentionally follows the final write. A failed insert can leave a documented orphan.
  await writeFile(path, bytes, { flag: "wx", mode: 0o640 });
  const row = await withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('insight.artifact_write','allowed',true)");
    return (
      await client.query<ArtifactRow>(
        `INSERT INTO insight.artifacts
           (id,kind,owner_id,relative_path,media_type,byte_length,sha256,access_class,
            artifact_version,created_by_user_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          id,
          input.kind,
          ownerId,
          relativePath,
          input.mediaType,
          bytes.length,
          sha256,
          input.accessClass,
          input.version,
          actor.id,
          now,
        ],
      )
    ).rows[0]!;
  });
  return metadata(row);
}

export async function readArtifact(
  pool: Pool,
  actor: ArtifactActor,
  artifactId: string,
  artifactRoot: string,
): Promise<StoredArtifact> {
  if (!UUID.test(artifactId)) throw new ArtifactNotFoundError();
  const row = (
    await pool.query<ArtifactRow>("SELECT * FROM insight.artifacts WHERE id=$1", [artifactId])
  ).rows[0];
  if (!row) throw new ArtifactNotFoundError();
  authorize(actor, row);

  const path = await safeExistingPath(artifactRoot, row.relative_path);
  const bytes = await readFile(path);
  if (
    bytes.length !== Number(row.byte_length) ||
    createHash("sha256").update(bytes).digest("hex") !== row.sha256
  ) {
    throw new ArtifactIntegrityError();
  }
  return { metadata: metadata(row), bytes };
}

function validateInput(actor: ArtifactActor, input: StoreArtifactInput): void {
  if (!UUID.test(actor.id) || !UUID.test(input.ownerId)) {
    throw new ArtifactInputError("Actor and owner identifiers must be UUIDs.");
  }
  if (input.accessClass === "OWNER" && actor.id.toLowerCase() !== input.ownerId.toLowerCase()) {
    throw new ArtifactAuthorizationError();
  }
  if (input.accessClass !== "OWNER" && actor.role !== input.accessClass) {
    throw new ArtifactAuthorizationError();
  }
  if (!(input.kind in POLICIES)) throw new ArtifactInputError("Artifact kind is not allowed.");
  const policy = POLICIES[input.kind];
  if (!policy.mediaTypes.includes(input.mediaType)) {
    throw new ArtifactInputError(`Media type is not allowed for ${input.kind}.`);
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > policy.maxBytes) {
    throw new ArtifactInputError(`Artifact size is not allowed for ${input.kind}.`);
  }
  if (
    input.version.trim() !== input.version ||
    input.version.length < 1 ||
    input.version.length > 128
  ) {
    throw new ArtifactInputError("Artifact version must contain 1 to 128 trimmed characters.");
  }
}

function authorize(actor: ArtifactActor, row: ArtifactRow): void {
  const allowed =
    (row.access_class === "OWNER" && actor.id.toLowerCase() === row.owner_id.toLowerCase()) ||
    (row.access_class !== "OWNER" && actor.role === row.access_class);
  if (!allowed) throw new ArtifactAuthorizationError();
}

async function canonicalRoot(artifactRoot: string): Promise<string> {
  await mkdir(artifactRoot, { recursive: true, mode: 0o750 });
  return realpath(artifactRoot);
}

async function safeNewPath(artifactRoot: string, relativePath: string): Promise<string> {
  validateRelativePath(relativePath);
  const root = await canonicalRoot(artifactRoot);
  const ownerDirectory = resolve(root, relativePath.split("/")[0]!);
  await mkdir(ownerDirectory, { recursive: true, mode: 0o750 });
  if ((await realpath(ownerDirectory)) !== ownerDirectory)
    throw new ArtifactInputError("Unsafe path.");
  return descendant(root, relativePath);
}

async function safeExistingPath(artifactRoot: string, relativePath: string): Promise<string> {
  validateRelativePath(relativePath);
  const root = await canonicalRoot(artifactRoot);
  const path = descendant(root, relativePath);
  if ((await realpath(path)) !== path) throw new ArtifactIntegrityError();
  return path;
}

function descendant(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path === root || !path.startsWith(`${root}${sep}`))
    throw new ArtifactInputError("Unsafe path.");
  return path;
}

function validateRelativePath(relativePath: string): void {
  if (isAbsolute(relativePath) || !RELATIVE_PATH.test(relativePath)) {
    throw new ArtifactInputError("Artifact paths must contain only owner and artifact UUIDs.");
  }
  const [ownerId, artifactId] = relativePath.split("/");
  if (!UUID.test(ownerId!) || !UUID.test(artifactId!)) throw new ArtifactInputError("Unsafe path.");
}

function metadata(row: ArtifactRow): ArtifactMetadata {
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    byteLength: Number(row.byte_length),
    sha256: row.sha256,
    accessClass: row.access_class,
    version: row.artifact_version,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

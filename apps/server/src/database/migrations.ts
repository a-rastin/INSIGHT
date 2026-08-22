import { createHash } from "node:crypto";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface PreparedMigration extends Migration {
  checksum: string;
}

export const migrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "database_foundation",
    sql: `
      CREATE SCHEMA insight;
      COMMENT ON SCHEMA insight IS 'INSIGHT application-owned database objects';
    `,
  },
]);

export function prepareMigrations(
  source: readonly Migration[] = migrations,
): readonly PreparedMigration[] {
  const versions = new Set<number>();
  return source.map((migration, index) => {
    if (!Number.isSafeInteger(migration.version) || migration.version !== index + 1) {
      throw new Error("Migration versions must be consecutive positive integers starting at 1.");
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(migration.name) || migration.sql.trim() === "") {
      throw new Error(`Migration ${migration.version} has an invalid name or empty SQL.`);
    }
    versions.add(migration.version);
    const checksum = createHash("sha256")
      .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
      .digest("hex");
    return { ...migration, checksum };
  });
}

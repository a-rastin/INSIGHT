import { Pool, type PoolConfig } from "pg";

export const POSTGRES_MAJOR = 16;

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required by the server database package.");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }

  return { connectionString };
}

export function createPostgresPool(config: DatabaseConfig): Pool {
  const poolConfig: PoolConfig = {
    application_name: "insight-server",
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    max: config.maxConnections ?? 10,
    options: "-c timezone=UTC",
  };
  return new Pool(poolConfig);
}

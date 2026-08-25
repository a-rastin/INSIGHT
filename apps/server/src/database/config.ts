import { Pool, type PoolConfig } from "pg";

export const POSTGRES_MAJOR = 16;

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  role?: string;
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
  if (config.role && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(config.role)) {
    throw new Error("Database role must be a simple PostgreSQL identifier.");
  }
  const poolConfig: PoolConfig = {
    application_name: "insight-server",
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    max: config.maxConnections ?? 10,
    options: `-c timezone=UTC${config.role ? ` -c role=${config.role}` : ""}`,
  };
  return new Pool(poolConfig);
}

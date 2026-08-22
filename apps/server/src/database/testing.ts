import { randomUUID } from "node:crypto";

import { Pool } from "pg";

export async function withIsolatedTestDatabase<T>(
  adminConnectionString: string,
  operation: (databaseConnectionString: string) => Promise<T>,
): Promise<T> {
  const databaseName = `insight_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: adminConnectionString, max: 1 });
  const databaseUrl = new URL(adminConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  databaseUrl.searchParams.delete("options");
  let created = false;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    created = true;
    return await operation(databaseUrl.toString());
  } finally {
    try {
      if (created) await adminPool.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await adminPool.end();
    }
  }
}

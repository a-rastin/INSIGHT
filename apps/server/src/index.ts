import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildApp } from "./app.js";
import { assertSchemaAtHead, createPostgresPool, databaseConfigFromEnv } from "./database/index.js";
import { safeDatabaseDiagnostic } from "./database/diagnostic.js";

export { buildApp } from "./app.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createPostgresPool(databaseConfigFromEnv(env));
  const app = buildApp({
    staticRoot:
      env.NODE_ENV === "production"
        ? resolve(env.INSIGHT_STATIC_ROOT ?? "apps/web/dist")
        : undefined,
  });
  try {
    await assertSchemaAtHead(pool);
    app.addHook("onClose", async () => pool.end());
    await app.listen({
      host: env.HOST ?? "127.0.0.1",
      port: Number(env.PORT ?? 3000),
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error(safeDatabaseDiagnostic(error));
    process.exitCode = 1;
  });
}

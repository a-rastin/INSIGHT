import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildApp } from "./app.js";
import { assertSchemaAtHead, createPostgresPool, databaseConfigFromEnv } from "./database/index.js";
import { safeDatabaseDiagnostic } from "./database/diagnostic.js";
import { officialIdentifierConfigurationFromEnv } from "./patient/patients.js";

export { buildApp } from "./app.js";
export * from "./deployment/index.js";
export * from "./identity/index.js";
export * from "./patient/index.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createPostgresPool(databaseConfigFromEnv(env));
  const host = env.HOST ?? "127.0.0.1";
  const app = buildApp({
    staticRoot:
      env.NODE_ENV === "production"
        ? resolve(env.INSIGHT_STATIC_ROOT ?? "apps/web/dist")
        : undefined,
    readinessChecks: async () => {
      await pool.query("SELECT 1");
      await access(env.INSIGHT_WORKER_READY_FILE ?? "/run/insight/worker-ready");
      return { application: "ready", database: "ready", worker: "ready" };
    },
    authentication: {
      pool,
      allowInsecureLoopbackCookie:
        env.NODE_ENV === "development" && ["127.0.0.1", "::1", "localhost"].includes(host),
    },
    patient: { officialIdentifier: officialIdentifierConfigurationFromEnv(env) },
  });
  try {
    await assertSchemaAtHead(pool);
    app.addHook("onClose", async () => pool.end());
    await app.listen({
      host,
      port: Number(env.PORT ?? 3000),
    });
    await new Promise<void>((resolveShutdown) => {
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolveShutdown();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await app.close();
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

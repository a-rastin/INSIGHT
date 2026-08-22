import { pathToFileURL } from "node:url";

import Fastify from "fastify";
import type { HealthResponse } from "@insight/contracts";

import { assertSchemaAtHead, createPostgresPool, databaseConfigFromEnv } from "./database/index.js";
import { safeDatabaseDiagnostic } from "./database/diagnostic.js";

export const app = Fastify({ logger: false });

app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createPostgresPool(databaseConfigFromEnv(env));
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

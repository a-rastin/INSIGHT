import { rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { assertSchemaAtHead, createPostgresPool, databaseConfigFromEnv } from "./database/index.js";
import { safeDatabaseDiagnostic } from "./database/diagnostic.js";
import { runJobWorker } from "./jobs/runner.js";
import {
  createMedicationNormalizationJobHandler,
  MEDICATION_NORMALIZATION_JOB,
} from "./medication/normalization.js";

export async function startWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createPostgresPool(databaseConfigFromEnv(env));
  const readyFile = env.INSIGHT_WORKER_READY_FILE;

  try {
    await assertSchemaAtHead(pool);
    if (readyFile) await writeFile(readyFile, "ready\n", { mode: 0o640 });
    const controller = new AbortController();
    const worker = runJobWorker({
      pool,
      workerId: `worker-${randomUUID()}`,
      handlers: {
        [MEDICATION_NORMALIZATION_JOB]: createMedicationNormalizationJobHandler(pool),
      },
      signal: controller.signal,
    });
    const shutdown = new Promise<void>((resolveShutdown) => {
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolveShutdown();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await Promise.race([worker, shutdown]);
    controller.abort();
    await worker;
  } finally {
    if (readyFile) await rm(readyFile, { force: true });
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch((error: unknown) => {
    console.error(safeDatabaseDiagnostic(error));
    process.exitCode = 1;
  });
}

import { resolve } from "node:path";

import {
  rollbackDatabaseRestore,
  restoreDatabase,
  RestorePostCheckError,
  RestoreValidationError,
} from "./restore.js";

const [command, firstArgument, secondArgument] = process.argv.slice(2);

try {
  const adminDatabaseUrl = process.env.INSIGHT_RESTORE_ADMIN_DATABASE_URL;
  const targetDatabaseUrl = process.env.DATABASE_URL;
  if (!adminDatabaseUrl || !targetDatabaseUrl) {
    throw new Error("DATABASE_URL and INSIGHT_RESTORE_ADMIN_DATABASE_URL are required.");
  }
  const maintenanceMarkerPath = resolve(
    process.env.INSIGHT_MAINTENANCE_MARKER ?? ".insight-restore-maintenance",
  );
  if (command === "restore" && firstArgument && secondArgument) {
    const result = await restoreDatabase({
      adminDatabaseUrl,
      targetDatabaseUrl,
      dumpPath: resolve(firstArgument),
      manifestPath: resolve(secondArgument),
      artifactRoot: resolve(process.env.INSIGHT_ARTIFACT_ROOT ?? "artifacts"),
      maintenanceMarkerPath,
      applicationVersion: process.env.INSIGHT_APP_VERSION ?? "0.1.0",
    });
    console.log(JSON.stringify({ status: "RESTORED", ...result }));
  } else if (command === "rollback" && firstArgument && !secondArgument) {
    const result = await rollbackDatabaseRestore(
      { adminDatabaseUrl, targetDatabaseUrl, maintenanceMarkerPath },
      firstArgument,
    );
    console.log(JSON.stringify({ status: "ROLLED_BACK", ...result }));
  } else {
    throw new Error(
      "Usage: restore-cli restore <dump> <manifest> or restore-cli rollback <database>.",
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "FAILED_MAINTENANCE_REQUIRED",
      failureCode:
        error instanceof RestoreValidationError
          ? "RESTORE_VALIDATION_FAILED"
          : error instanceof RestorePostCheckError
            ? "RESTORE_POST_CHECK_FAILED"
            : "RESTORE_FAILED",
      error:
        error instanceof RestoreValidationError || error instanceof RestorePostCheckError
          ? error.message
          : "Restore operation failed; inspect PostgreSQL maintenance logs.",
      ...(error instanceof RestoreValidationError && error.artifactIssues.length > 0
        ? { artifactIssues: error.artifactIssues }
        : {}),
    }),
  );
  process.exitCode = 1;
}

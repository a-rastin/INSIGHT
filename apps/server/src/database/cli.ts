import {
  createPostgresPool,
  databaseConfigFromEnv,
  getMigrationStatus,
  migrateToHead,
} from "./index.js";
import { safeDatabaseDiagnostic } from "./diagnostic.js";

const command = process.argv[2];
const pool = createPostgresPool(databaseConfigFromEnv());

try {
  if (command === "migrate") {
    const result = await migrateToHead(pool);
    console.log(
      JSON.stringify({
        state: result.state,
        databaseHead: result.databaseHead,
        codeHead: result.codeHead,
        applied: result.applied,
      }),
    );
  } else if (command === "status") {
    console.log(JSON.stringify(await getMigrationStatus(pool)));
  } else {
    throw new Error("Expected migrate or status command.");
  }
} catch (error) {
  console.error(safeDatabaseDiagnostic(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}

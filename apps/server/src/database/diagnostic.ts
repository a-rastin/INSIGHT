import { DatabaseCompatibilityError, MigrationError } from "./migrator.js";

export function safeDatabaseDiagnostic(error: unknown): string {
  if (error instanceof DatabaseCompatibilityError || error instanceof MigrationError) {
    return error.message;
  }
  return "Database operation failed. Check PostgreSQL availability and server-side configuration.";
}

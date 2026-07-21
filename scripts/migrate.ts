import "dotenv/config";
import pg from "pg";
import { runMigrations } from "../src/rag/migrate.js";

/**
 * Explicit migration command: `npm run migrate`.
 *
 * Reads the connection string from `DATABASE_URL` (never printed or logged), applies every pending
 * SQL migration in `migrations/`, and reports only the filenames applied. It is safe to run
 * repeatedly — already-applied migrations are skipped.
 *
 * A dedicated database is required; this command intentionally has no in-memory fallback and is never
 * invoked by `npm run check`.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    // Name the variable only; never echo its value.
    throw new Error("DATABASE_URL must be set to run migrations.");
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const { applied } = await runMigrations(pool);
    if (applied.length === 0) {
      console.log("Migrations up to date; nothing to apply.");
    } else {
      console.log(`Applied ${String(applied.length)} migration(s):`);
      for (const name of applied) {
        console.log(`  - ${name}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Print the error message only; it never contains the connection string.
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exitCode = 1;
});

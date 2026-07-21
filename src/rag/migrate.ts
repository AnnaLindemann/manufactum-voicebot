import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/**
 * Minimal forward-only SQL migration runner for the RAG document store (`D-004`).
 *
 * Migrations are plain `.sql` files in the `migrations/` directory, applied in ascending filename
 * order. Each applied file is recorded in a `schema_migrations` table so re-running is a no-op. Each
 * file runs inside its own transaction together with its bookkeeping insert, so a failed migration
 * leaves the database exactly as it was before that file.
 *
 * This module never reads a connection string or any secret: the caller supplies an already-configured
 * `pg.Pool`. It is deliberately dependency-light — no migration framework, no ORM.
 */

/** Absolute path to the repository's `migrations/` directory, resolved from this module's location. */
export const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../migrations");

export type MigrationResult = {
  /** Filenames applied during this run, in the order they were applied. Empty when already current. */
  applied: string[];
};

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrationNames(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(result.rows.map((row) => row.name));
}

/** List the `.sql` migration files in `dir`, sorted ascending by filename. */
async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

/**
 * Apply every pending migration in `dir` against `pool`. Already-applied files are skipped. Returns
 * the filenames applied in order. Safe to call repeatedly; concurrent runners are serialized by the
 * primary-key insert into `schema_migrations`.
 */
export async function runMigrations(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await ensureMigrationsTable(pool);
  const alreadyApplied = await appliedMigrationNames(pool);
  const files = await migrationFiles(dir);

  const applied: string[] = [];
  for (const name of files) {
    if (alreadyApplied.has(name)) {
      continue;
    }
    const sql = await readFile(path.join(dir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied };
}

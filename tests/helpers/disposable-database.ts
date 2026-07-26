/**
 * Safety guard for the destructive PostgreSQL integration tests.
 *
 * Those tests `TRUNCATE` the RAG tables before each test, so they must run **only** against a
 * disposable database — never against the working RAG database that holds the real Manufactum FAQ.
 * The working data lives in `DATABASE_URL`; the disposable test data lives in `RAG_TEST_DATABASE_URL`.
 *
 * Design choices, per the phase's safety gate:
 *
 * - **Fail fast, never skip.** A misconfiguration (unset, same database, wrong name) raises a clear
 *   error rather than silently skipping the suite. Silent skipping is exactly how the danger hid
 *   before: the suite looked green while never running.
 * - **Compare by database identity, not raw string.** Two connection strings can differ textually — a
 *   trailing slash, different credentials, an added parameter — yet resolve to the same database. The
 *   guard compares `(host:port, database)`, so such a difference is still refused.
 * - **Require a `_test` suffix** on the disposable database name, so only a database explicitly named
 *   as disposable can ever be truncated.
 * - **Verify the real connection** (`current_database()`, `inet_server_addr()`, `inet_server_port()`)
 *   before any TRUNCATE, catching a connection string that lies about where it points.
 *
 * Neither URL nor any credential is ever printed; only non-secret database names appear in errors.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export type DatabaseIdentity = {
  /** Lower-cased `host:port`, with the default 5432 filled in. Empty when the URL is unparseable. */
  hostPort: string;
  /** Lower-cased database name (the URL path). Empty when the URL is unparseable. */
  database: string;
  /** The original trimmed string, used as a fallback identity for unparseable URLs. */
  raw: string;
};

/** Parse a connection string into a comparable identity, or `undefined` when unset/blank. */
export function parseDatabaseIdentity(url: string | undefined): DatabaseIdentity | undefined {
  const trimmed = url?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    const port = parsed.port === "" ? "5432" : parsed.port;
    // Strip the leading slash and any trailing slash so `/db` and `/db/` are the same identity.
    const database = decodeURIComponent(
      parsed.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    ).toLowerCase();
    return { hostPort: `${parsed.hostname.toLowerCase()}:${port}`, database, raw: trimmed };
  } catch {
    // Unparseable: empty identity fields force a strict raw-string comparison below.
    return { hostPort: "", database: "", raw: trimmed };
  }
}

/** True iff both identities resolve to the same physical database (same host:port and db name). */
function sameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  if (a.hostPort === "" || b.hostPort === "") {
    // At least one URL was unparseable; fall back to strict raw-string equality.
    return a.raw === b.raw;
  }
  return a.hostPort === b.hostPort && a.database === b.database;
}

/**
 * Resolve the working and disposable connection strings. Real environment variables win; when either
 * is missing, `.env` is consulted via `dotenv.parse` **without mutating `process.env`**, so this
 * never leaks database configuration into other test files sharing the worker process.
 */
export function resolveDatabaseUrls(env: NodeJS.ProcessEnv = process.env): {
  testUrl: string | undefined;
  workingUrl: string | undefined;
} {
  let testUrl = env.RAG_TEST_DATABASE_URL?.trim();
  let workingUrl = env.DATABASE_URL?.trim();
  if (
    testUrl === undefined ||
    testUrl.length === 0 ||
    workingUrl === undefined ||
    workingUrl.length === 0
  ) {
    try {
      const parsed = dotenv.parse(readFileSync(resolve(process.cwd(), ".env")));
      if (testUrl === undefined || testUrl.length === 0) {
        testUrl = parsed.RAG_TEST_DATABASE_URL?.trim();
      }
      if (workingUrl === undefined || workingUrl.length === 0) {
        workingUrl = parsed.DATABASE_URL?.trim();
      }
    } catch {
      // No readable .env; fall through with whatever the environment provided.
    }
  }
  return {
    testUrl: testUrl !== undefined && testUrl.length > 0 ? testUrl : undefined,
    workingUrl: workingUrl !== undefined && workingUrl.length > 0 ? workingUrl : undefined,
  };
}

/**
 * Static guard: assert the disposable test URL is safe to run destructive tests against, and return
 * its parsed identity. Throws a clear error when unset, not `_test`-suffixed, or resolving to the
 * same database as the working URL.
 */
export function assertDisposableTestDatabase(
  testUrl: string | undefined,
  workingUrl: string | undefined,
): DatabaseIdentity {
  const test = parseDatabaseIdentity(testUrl);
  if (test === undefined) {
    throw new Error(
      "RAG_TEST_DATABASE_URL must be set to a disposable PostgreSQL database to run the destructive RAG integration tests.",
    );
  }
  if (!test.database.endsWith("_test")) {
    throw new Error(
      'Refusing to run destructive RAG integration tests: the disposable database name must end with "_test".',
    );
  }
  const working = parseDatabaseIdentity(workingUrl);
  if (working !== undefined && sameDatabase(test, working)) {
    throw new Error(
      "Refusing to run destructive RAG integration tests: RAG_TEST_DATABASE_URL resolves to the same database as DATABASE_URL (the working RAG database).",
    );
  }
  return test;
}

/** The live server facts read from the connected pool, used by the runtime net below. */
export type ConnectedDatabaseInfo = {
  database: string;
  serverAddr: string | null;
  serverPort: number | null;
};

/**
 * Runtime net, checked after the pool actually connects and before any TRUNCATE: throw unless the
 * database really connected to is the configured disposable one, and never the working database.
 */
export function assertConnectedDisposableDatabase(
  info: ConnectedDatabaseInfo,
  testUrl: string | undefined,
  workingUrl: string | undefined,
): void {
  const connected = info.database.toLowerCase();
  if (!connected.endsWith("_test")) {
    throw new Error(
      `Refusing to TRUNCATE: the connected database "${info.database}" does not end with "_test".`,
    );
  }
  const test = parseDatabaseIdentity(testUrl);
  if (test !== undefined && test.database !== "" && connected !== test.database) {
    throw new Error(
      `Refusing to TRUNCATE: the connected database "${info.database}" is not the configured disposable database.`,
    );
  }
  const working = parseDatabaseIdentity(workingUrl);
  if (
    test !== undefined &&
    working !== undefined &&
    test.hostPort !== "" &&
    test.hostPort === working.hostPort &&
    connected === working.database
  ) {
    throw new Error(
      `Refusing to TRUNCATE: the connected database "${info.database}" is the working RAG database.`,
    );
  }
}

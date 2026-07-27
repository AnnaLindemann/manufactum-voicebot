import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  RAG_POOL_ERROR_EVENT,
  RAG_POOL_IDLE_CLIENT_ERROR_CODE,
  registerRagPoolErrorLogging,
} from "../../src/rag/pool-error-logging.js";
import { createRecordingLogger } from "../helpers/test-doubles.js";

/**
 * These tests drive a **real** `pg.Pool`, because the behaviour under test is `EventEmitter`
 * semantics: an `error` event with no listener is re-thrown by Node and kills the process. A hand-made
 * fake would emit whatever the fake was written to emit and would prove nothing about that. Building a
 * pool opens no connection — the driver connects lazily on the first query, and no query is issued
 * here — so no database is involved.
 */

/** Never resolvable, and never resolved: the pool is constructed and ended without connecting. */
const UNREACHABLE_DATABASE_URL =
  "postgres://rag:pool-test-password-never-real@db.invalid:5432/rag_pool_test";

const pools: pg.Pool[] = [];

function createPool(): pg.Pool {
  const pool = new pg.Pool({ connectionString: UNREACHABLE_DATABASE_URL });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

/** The shape a `pg` idle-client failure actually arrives in: a message plus a driver `code`. */
function driverError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) {
    Object.assign(error, { code });
  }
  return error;
}

describe("registerRagPoolErrorLogging", () => {
  it("keeps an idle-client error from terminating the process", () => {
    const pool = createPool();
    registerRagPoolErrorLogging(pool, createRecordingLogger());

    // Without the listener this call throws the error straight out of `emit`, which in production is
    // an uncaught exception and a dead web service.
    expect(() =>
      pool.emit("error", driverError("terminating connection due to administrator command"), {}),
    ).not.toThrow();
  });

  it("proves the unhandled case is genuinely fatal, so the listener is not decoration", () => {
    const pool = createPool();

    expect(() => pool.emit("error", driverError("connection reset by peer"), {})).toThrow(
      "connection reset by peer",
    );
  });

  it("logs one structured operational error carrying the closed internal code", () => {
    const pool = createPool();
    const logger = createRecordingLogger();
    registerRagPoolErrorLogging(pool, logger);

    pool.emit("error", driverError("connection terminated unexpectedly", "ECONNRESET"), {});

    expect(logger.entries).toHaveLength(1);
    const [entry] = logger.entries;
    expect(entry?.level).toBe("error");
    expect(entry?.event).toBe(RAG_POOL_ERROR_EVENT);
    expect(entry?.fields.errorCode).toBe(RAG_POOL_IDLE_CLIENT_ERROR_CODE);
  });

  it("keeps a recognizable driver code, which is the one detail an operator can act on", () => {
    const pool = createPool();
    const logger = createRecordingLogger();
    registerRagPoolErrorLogging(pool, logger);

    // `57P01` is "admin_shutdown": the database restarted under us, which is a different night's
    // debugging from a firewall reaping idle sockets.
    pool.emit("error", driverError("terminating connection", "57P01"), {});

    expect(logger.entries[0]?.fields.message).toContain("57P01");
  });

  it("drops a driver code that is not a code, rather than sanitizing an unknown string", () => {
    const pool = createPool();
    const logger = createRecordingLogger();
    registerRagPoolErrorLogging(pool, logger);

    pool.emit(
      "error",
      driverError("failed", "SELECT c.content FROM rag_chunks WHERE document_key = $1"),
      {},
    );

    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain("SELECT");
    expect(logged).not.toContain("rag_chunks");
  });

  it("logs no driver message, no connection string, and no credential", () => {
    const pool = createPool();
    const logger = createRecordingLogger();
    registerRagPoolErrorLogging(pool, logger);

    // A pg connection error routinely quotes the host, the user, and the failing statement. All of it
    // is the driver's, none of it is ours to publish into a platform's retained log stream.
    pool.emit(
      "error",
      driverError(
        'connection to server at "db.invalid" (10.0.0.5), port 5432 failed for user "rag" ' +
          "with password pool-test-password-never-real while running " +
          "SELECT c.chunk_key FROM rag_chunks c",
        "ECONNRESET",
      ),
      {},
    );

    const logged = JSON.stringify(logger.entries);
    for (const forbidden of [
      "pool-test-password-never-real",
      "db.invalid",
      "10.0.0.5",
      "SELECT",
      "rag_chunks",
      "postgres://",
      "DATABASE_URL",
    ]) {
      expect(logged, `${forbidden} must not reach the log line`).not.toContain(forbidden);
    }
  });

  it("keeps logging every subsequent failure, not only the first", () => {
    const pool = createPool();
    const logger = createRecordingLogger();
    registerRagPoolErrorLogging(pool, logger);

    // A database restart drops every idle client at once; each one emits.
    pool.emit("error", driverError("first", "57P01"), {});
    pool.emit("error", driverError("second", "57P01"), {});
    pool.emit("error", driverError("third", "57P01"), {});

    expect(logger.entries).toHaveLength(3);
  });
});

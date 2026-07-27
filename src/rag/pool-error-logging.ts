import type { Logger } from "../logging/logger.js";

/**
 * Idle-client error handling for the production RAG connection pool.
 *
 * `pg.Pool` emits `error` when a client that is **idle in the pool** fails — a managed database
 * restarting, an idle connection reaped by a proxy or a firewall, a network reset. No request is in
 * flight, so no request-level `catch` can see it. `Pool` is an `EventEmitter`, and an `error` event
 * with no listener is re-thrown by Node as an uncaught exception, which **terminates the process**.
 *
 * On Render that means an idle overnight connection being closed by the database takes the whole web
 * service down, and the platform restarts it — a restart with no obvious cause, which then repeats.
 * The pool itself needs no rescue: it discards the broken client, and the next query opens a fresh
 * one. The only thing missing is a listener, so the event is observed instead of fatal.
 *
 * This is deliberately **not** request-level error handling. A query that fails inside a request
 * still rejects, still becomes `INTERNAL_ERROR`, and still returns the standard envelope; retrieval
 * results are untouched.
 */

/** `[D]` A closed internal code, like every other code that reaches a log line. */
export const RAG_POOL_IDLE_CLIENT_ERROR_CODE = "RAG_POOL_IDLE_CLIENT_ERROR";

export const RAG_POOL_ERROR_EVENT = "rag_pool_idle_client_error";

/**
 * The subset of `pg.Pool` this needs. Structural, so a test can drive the listener without a
 * database, and so nothing here can reach a query, a client, or a connection string.
 */
export type PoolErrorSource = {
  on: (event: "error", listener: (error: Error) => void) => unknown;
};

/**
 * A driver error's `message` is not safe to log: `pg` puts the failing SQL, a column name, or the
 * host and user from the connection string into it depending on the failure. Its `code` is not free
 * text — it is a PostgreSQL SQLSTATE (`57P01`) or a Node error code (`ECONNRESET`) — so it is the one
 * field worth keeping, and only when it looks like one. Anything else is dropped rather than
 * sanitized, because a partial redaction of an unknown string is a guess.
 */
const SAFE_DRIVER_CODE = /^[A-Z0-9_]{1,32}$/;

function safeDriverCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;

  return typeof code === "string" && SAFE_DRIVER_CODE.test(code) ? code : undefined;
}

/**
 * Registers the listener. Call once per pool, immediately after constructing it — before any query,
 * so there is no window in which an early failure is still fatal.
 */
export function registerRagPoolErrorLogging(pool: PoolErrorSource, logger: Logger): void {
  pool.on("error", (error: Error) => {
    const driverCode = safeDriverCode(error);

    logger.error(RAG_POOL_ERROR_EVENT, {
      errorCode: RAG_POOL_IDLE_CLIENT_ERROR_CODE,
      // A fixed sentence plus, at most, one closed code. No driver message, no `cause`, no stack, no
      // SQL, no connection string, no host, and no environment-variable value.
      message:
        driverCode === undefined
          ? "An idle PostgreSQL client failed and was discarded by the pool. The next query opens a new connection."
          : `An idle PostgreSQL client failed and was discarded by the pool (driver code ${driverCode}). The next query opens a new connection.`,
    });
  });
}

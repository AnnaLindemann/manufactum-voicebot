# Deployment Hardening Implementation Report

## Phase

Deployment hardening, taken after the read-only deployment-readiness audit and **before** the Render
service is created. Not a roadmap phase; a contained checkpoint like the Test Deployment itself.

## Summary

Five contained hardening changes to the retrieval-only RAG backend, plus documentation corrections:
idle-client error handling on the PostgreSQL pool, explicit and validated database TLS, a dedicated
rate limiter for `POST /api/rag/query`, a build-time embedding cache warm-up command, and `PORT`
validation. Recorded as `D-019`.

## Scope

- **Included:** deployment infrastructure, safety, configuration, tests, documentation.
- **Explicitly excluded, and verified untouched:** retrieval behaviour, embeddings, the embedding
  model and its pinned artifact, chunks, ranking, thresholds, `maxChunks`, the metadata projection,
  evaluation datasets, and Dialfire. No commit and no push were made.

## Files changed

Added:

- `src/config/database-ssl.ts`
- `src/config/port-config.ts`
- `src/config/rag-rate-limit-config.ts`
- `src/http/rag-rate-limit.ts`
- `src/rag/pool-error-logging.ts`
- `scripts/warm-embedding-cache.ts`
- `tests/unit/database-ssl.test.ts`
- `tests/unit/port-config.test.ts`
- `tests/unit/rag-pool-error-logging.test.ts`
- `tests/unit/rag-rate-limit-config.test.ts`
- `tests/unit/rag-retrieval-config.test.ts`
- `docs/deployment-hardening-implementation-report.md`

Modified:

- `src/app.ts`, `src/server.ts`, `src/config/rag-retrieval-config.ts`,
  `src/rag/rag-retrieval-dependencies.ts`
- `package.json` (one script: `rag:warm-embedding-cache`)
- `tests/integration/rag-query-route.test.ts`, `tests/integration/startup-configuration.test.ts`,
  `tests/helpers/rag-test-doubles.ts`, `tests/unit/rag-query-response.test.ts`
- `.env.example`, `README.md`, `docs/api-contracts.md`, `docs/deployment-preflight.md`,
  `docs/deployment-strategy.md`, `docs/project-decisions.md`

## Functionality added

1. **Pool idle-client error handling.** `registerRagPoolErrorLogging` attaches an `error` listener to
   the production pool. An idle-client failure becomes one structured log line
   (`rag_pool_idle_client_error`) with a closed internal code and, at most, a recognizable driver code
   (`57P01`, `ECONNRESET`); the driver message, SQL, host, and connection string are never logged. An
   unhandled pool `error` event previously terminated the process.
2. **Database TLS.** `DATABASE_SSL_MODE` (`disable` | `require` | `verify-full`) and
   `DATABASE_CA_CERT_PATH`. Unset passes no `ssl` option, preserving local development. `verify-full`
   reads the CA at startup and fails the deploy when it is missing, unreadable, or not PEM.
3. **RAG rate limiting.** `POST /api/rag/query` is limited to 10 requests per minute per client IP,
   configured separately within a bounded range (`RAG_RATE_LIMIT_MAX_REQUESTS` 1–60,
   `RAG_RATE_LIMIT_WINDOW_MS` 1000–600000). Rejections use the existing `RATE_LIMITED` envelope with
   `Retry-After`; admitted requests are unchanged.
4. **Embedding cache warm-up.** `npm run rag:warm-embedding-cache` loads the pinned artifact, runs one
   throwaway inference, honours `TRANSFORMERS_CACHE`, opens no database connection, writes nothing, and
   exits non-zero on failure.
5. **`PORT` validation.** An integer from 1 to 65535 when present; empty is treated as unset and takes
   the default 3000. `0` and non-numeric values now fail the deploy.

## Checks and tests run

| Check                                 | Result                                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| Type check (`npm run typecheck`)      | Pass                                                            |
| Lint (`npm run lint`)                 | Pass                                                            |
| Format check (`npm run format:check`) | Pass                                                            |
| Tests (`npm test`)                    | Pass — 38 files, 547 tests                                      |
| Build (`npm run build`)               | Pass                                                            |
| `npm run rag:warm-embedding-cache`    | Pass — exit 0; exit 1 when the artifact cannot load             |
| `npx tsx scripts/rag-db-preflight.ts` | Pass — read-only; 12 active chunks, 12 valid-profile embeddings |
| `npm run rag:smoke-retrieval`         | Pass — read-only; exact/paraphrased 3 chunks, irrelevant 0      |
| Live `POST /api/rag/query` (compiled) | Pass — `found`, scores identical to the recorded baseline       |

The destructive PostgreSQL suite ran against `manufactum_rag_test`, not the working database; the
disposable-database guard was verified before the run.

## Assumptions

- Render is the target platform; the commands documented are Render's three fields.
- The CA bundle is supplied by the operator as a Render Secret File. None is committed.
- 10 requests per minute is a conservative default for a controlled demo, not a tuned figure.

## Limitations

- Both rate limiters are in memory and per process. The deployment must run a **single** instance.
- The memory figures are development-machine evidence, not Render measurements.
- Whether the build-time warmed cache survives into Render's runtime filesystem cannot be verified
  from here.
- `require` mode encrypts without verifying the certificate; it is a documented stopgap.

## Unresolved questions

- The actual resident set size on Render, and therefore the correct instance size.
- Whether `TRANSFORMERS_CACHE` should point inside or outside the project directory on Render — it
  depends on whether the platform prunes dependencies between build and run.
- Total request duration is still unbounded (Phase 3 unresolved question 4), now also on the RAG path.
- The `0.8` retrieval threshold remains provisional and uncalibrated; unchanged here by design.

## Documentation updates

`.env.example` (complete inventory with Render guidance), `docs/deployment-preflight.md` (env table,
`RAG_TEST_DATABASE_URL` exclusion, TLS section, Render commands, `/health` vs RAG readiness, memory and
native-dependency and cache section, RAG smoke tests 10–15, the "Liste für später" limitation, C-7 to
C-11), `docs/deployment-strategy.md` (hosting requirements, build/start, transport, order),
`docs/api-contracts.md` (corrected response example, rate limiting, pool errors),
`docs/project-decisions.md` (`D-019`), `README.md` (operational startup instructions).

## Recommendation

Review and accept, then create the Render service using the documented build and start commands, with
`DATABASE_SSL_MODE=verify-full` and a CA Secret File. Run smoke tests 1–9 and 10–15 against the
deployed URL, and record the observed memory, first-query latency, and RAG scores back into
`deployment-preflight.md` § 2b.

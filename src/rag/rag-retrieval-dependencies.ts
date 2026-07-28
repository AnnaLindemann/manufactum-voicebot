import pg from "pg";
import { databaseSslPoolOptions } from "../config/database-ssl.js";
import { loadRagRetrievalConfig } from "../config/rag-retrieval-config.js";
import { consoleLogger, type Logger } from "../logging/logger.js";
import type { RagRetrievalDependencies } from "../services/rag-query-service.js";
import type { TransformersE5SmallPassageEmbeddingGeneratorOptions } from "./e5-passage-embeddings.js";
import { registerRagPoolErrorLogging } from "./pool-error-logging.js";
import { PostgresRagDocumentStore } from "./postgres-document-store.js";
import { createQueryEmbeddingProvider } from "./query-embedding-provider.js";

/**
 * Composition of the production retrieval infrastructure: the PostgreSQL/pgvector document store and
 * the configured query-embedding runtime, both configured exactly as the accepted offline retrieval
 * path configures them.
 *
 * The query-embedding runtime is the one part an operator selects, through
 * `RAG_QUERY_EMBEDDING_PROVIDER`. This is the only place that selection happens, it happens once per
 * process, and it happens from configuration that the startup check has already validated — so no
 * request can reach a different provider than the one the release booted with, and an invalid value
 * fails the deploy rather than the first caller.
 *
 * Built on first use rather than at import time. A connection pool opened at import would make
 * importing the app require `DATABASE_URL`, which would break `GET /health` and every test that never
 * touches RAG. The same reason keeps the local embedding model — a ~118 MB ONNX artifact loaded by
 * the generator on its first call — out of process start.
 *
 * Memoized, so the pool and the loaded model are shared by every request rather than rebuilt per call.
 * A failed build is not cached: the next request retries, so a database that was briefly unreachable
 * at the first query does not disable retrieval for the process lifetime.
 */
export function createDefaultRagRetrievalDependencies(
  logger: Logger = consoleLogger,
): () => Promise<RagRetrievalDependencies> {
  let dependencies: RagRetrievalDependencies | undefined;

  return function resolveRagRetrievalDependencies(): Promise<RagRetrievalDependencies> {
    dependencies ??= build(logger);
    return Promise.resolve(dependencies);
  };
}

function build(logger: Logger): RagRetrievalDependencies {
  const config = loadRagRetrievalConfig();

  // Read whatever the provider turns out to be, and used only by the local one. `TRANSFORMERS_CACHE`
  // and the offline flag describe the local model cache, which the hosted provider has no use for.
  const localOptions: TransformersE5SmallPassageEmbeddingGeneratorOptions = {
    localFilesOnly: config.embeddingLocalFilesOnly,
    ...(config.embeddingCacheDir === undefined ? {} : { cacheDir: config.embeddingCacheDir }),
  };

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Empty when no mode is configured, so the connection string's own `sslmode` keeps governing and
    // a local development database is unaffected. See `config/database-ssl.ts`.
    ...databaseSslPoolOptions(config.ssl),
  });

  // Before the store, so no query can be issued while an idle-client error would still be fatal.
  registerRagPoolErrorLogging(pool, logger);

  return {
    store: new PostgresRagDocumentStore(pool),
    generator: createQueryEmbeddingProvider(config.queryEmbedding, { logger, local: localOptions }),
    retrieval: { maxChunks: config.maxChunks, minScore: config.minScore },
  };
}

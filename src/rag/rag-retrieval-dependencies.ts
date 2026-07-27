import pg from "pg";
import { loadRagRetrievalConfig } from "../config/rag-retrieval-config.js";
import type { RagRetrievalDependencies } from "../services/rag-query-service.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "./e5-passage-embeddings.js";
import { PostgresRagDocumentStore } from "./postgres-document-store.js";

/**
 * Composition of the production retrieval infrastructure: the PostgreSQL/pgvector document store and
 * the local Transformers.js embedding runtime, both configured exactly as the accepted offline
 * retrieval path configures them.
 *
 * Built on first use rather than at import time. A connection pool opened at import would make
 * importing the app require `DATABASE_URL`, which would break `GET /health` and every test that never
 * touches RAG. The same reason keeps the embedding model — a ~118 MB ONNX artifact loaded by the
 * generator on its first call — out of process start.
 *
 * Memoized, so the pool and the loaded model are shared by every request rather than rebuilt per call.
 * A failed build is not cached: the next request retries, so a database that was briefly unreachable
 * at the first query does not disable retrieval for the process lifetime.
 */
export function createDefaultRagRetrievalDependencies(): () => Promise<RagRetrievalDependencies> {
  let dependencies: RagRetrievalDependencies | undefined;

  return function resolveRagRetrievalDependencies(): Promise<RagRetrievalDependencies> {
    dependencies ??= build();
    return Promise.resolve(dependencies);
  };
}

function build(): RagRetrievalDependencies {
  const config = loadRagRetrievalConfig();

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    localFilesOnly: config.embeddingLocalFilesOnly,
    ...(config.embeddingCacheDir === undefined ? {} : { cacheDir: config.embeddingCacheDir }),
  };

  return {
    store: new PostgresRagDocumentStore(new pg.Pool({ connectionString: config.databaseUrl })),
    generator: new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions),
    retrieval: { maxChunks: config.maxChunks, minScore: config.minScore },
  };
}

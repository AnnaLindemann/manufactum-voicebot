import { toRagQueryResponse, type RagQuery, type RagQueryResponse } from "../domain/rag-query.js";
import { AppError } from "../errors/app-error.js";
import type { RagDocumentStore } from "../rag/document-store.js";
import type { QueryEmbeddingGenerator } from "../rag/e5-passage-embeddings.js";
import { RagEmbeddingError } from "../rag/e5-passage-embeddings.js";
import { retrieveRelevantChunks } from "../rag/retrieve-relevant-chunks.js";
import { RagRetrievalError } from "../rag/retrieval-errors.js";
import type { Logger } from "../logging/logger.js";
import type { RequestContext } from "../observability/request-context.js";

/**
 * Application service for `POST /api/rag/query`.
 *
 * It performs **retrieval only**: embed the caller's question with the active profile, run the
 * existing `retrieveRelevantChunks` path, and project whatever survived the minimum-relevance filter
 * onto the response contract. No answer-generation model is called, no prompt is built, and no
 * dialogue state is kept — those belong to the external agent.
 *
 * It is read-only with respect to RAG storage: the only store method it can reach is
 * `searchRelevantChunks`, through `retrieveRelevantChunks`. It stages nothing, embeds nothing into
 * storage, and activates nothing.
 *
 * Retrieval configuration is supplied by the operator, never by the caller, so `maxChunks`, the
 * minimum score, the embedding profile and the active document version are identical for every
 * request. Retrieval behaviour, ranking and no-answer semantics are exactly those of the accepted
 * offline path; nothing is re-tuned here.
 */

/** What the use case needs. The infrastructure module decides how these are built. */
export type RagRetrievalDependencies = {
  store: RagDocumentStore;
  generator: QueryEmbeddingGenerator;
  retrieval: {
    maxChunks: number;
    minScore: number;
  };
};

export type RagQueryService = (
  query: RagQuery,
  context: RequestContext,
) => Promise<RagQueryResponse>;

/**
 * @param resolveDependencies resolved per request and expected to memoize, so the database pool and
 * the local embedding model are built once, on the first query, rather than at import time.
 */
export function createRagQueryService(
  resolveDependencies: () => Promise<RagRetrievalDependencies>,
  logger: Logger,
): RagQueryService {
  return async function answerRagQuery(
    query: RagQuery,
    context: RequestContext,
  ): Promise<RagQueryResponse> {
    let chunks;

    try {
      const { store, generator, retrieval } = await resolveDependencies();

      chunks = await retrieveRelevantChunks(store, generator, query.query, {
        maxChunks: retrieval.maxChunks,
        minScore: retrieval.minScore,
      });
    } catch (error) {
      // Every failure below this line becomes one INTERNAL_ERROR with a message assembled from a
      // fixed string and, at most, a closed error code. A raw driver message can carry the failing
      // SQL, a column name, or a connection string, and a model-load failure can carry a filesystem
      // path, so no upstream message and no `cause` is ever propagated.
      throw new AppError("INTERNAL_ERROR", technicalMessageFor(error));
    }

    // The question itself is not logged: it is caller-spoken text, and the contract keeps personal
    // data out of logs. The chunk count is enough to see whether the threshold rejected everything.
    logger.info("rag_query_completed", {
      correlationId: context.correlationId,
      endpoint: "POST /api/rag/query",
      resultCount: chunks.length,
    });

    return toRagQueryResponse(query.query, chunks);
  };
}

function technicalMessageFor(error: unknown): string {
  if (error instanceof RagRetrievalError) {
    return `RAG retrieval failed: ${error.code}.`;
  }

  if (error instanceof RagEmbeddingError) {
    return `RAG query embedding failed: ${error.code}.`;
  }

  // Includes a missing or malformed retrieval configuration. Its message names variables rather than
  // values, but it is still withheld: a caller learns nothing about our deployment from a 500.
  return "RAG retrieval failed with an unexpected error.";
}

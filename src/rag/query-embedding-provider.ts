import type { QueryEmbeddingProviderConfig } from "../config/query-embedding-provider-config.js";
import { consoleLogger, type Logger } from "../logging/logger.js";
import {
  TransformersE5SmallPassageEmbeddingGenerator,
  type QueryEmbeddingGenerator,
  type TransformersE5SmallPassageEmbeddingGeneratorOptions,
} from "./e5-passage-embeddings.js";
import { HuggingFaceQueryEmbeddingProvider } from "./huggingface-query-embedding-provider.js";

/**
 * The one seam between the retrieval path and whatever computes a query vector.
 *
 * It exists for a single reason, established by measurement rather than by design preference: the
 * local Transformers.js runtime cannot load its ~118 MB ONNX artifact inside a Render Free instance
 * (Gate 4), while the hosted Hugging Face endpoint returns a compatible 384-dimensional normalized
 * vector that retrieves equivalently across the frozen 96-query dataset (Experiment C, Gate 5).
 *
 * The seam is deliberately as narrow as the retrieval path actually needs. `retrieveRelevantChunks`
 * reads one field, `embedding`, and the accompanying `l2Norm` is the number both implementations
 * already measure while validating their own output. Nothing about tokenisation, model loading, or
 * input hashing crosses this boundary, because only one of the two runtimes can observe any of it —
 * a remote endpoint does not report a token count, and inventing one would be a fabricated number in
 * a retrieval trace.
 *
 * This is a *query*-side seam only. Passage embeddings, the stored vectors, the active document
 * version, ranking, the threshold, and `RAG_EMBEDDING_PROFILE` itself are untouched: a remote query
 * vector is a query against the local space, not a replacement for it.
 */
export type QueryEmbeddingProviderResult = {
  /** L2-normalized, in `RAG_EMBEDDING_PROFILE.dimension` dimensions. Validated by the producer. */
  embedding: number[];
  /** Measured, not assumed — it is what the producer checked before returning the vector. */
  l2Norm: number;
};

export interface QueryEmbeddingProvider {
  embedQuery(query: string): Promise<QueryEmbeddingProviderResult>;
}

/**
 * The accepted baseline runtime, unchanged.
 *
 * It owns no embedding logic of its own: it forwards to the existing
 * `TransformersE5SmallPassageEmbeddingGenerator` and returns exactly the object that generator
 * produced. The E5 query prefix, the tokenizer limit, the pooled tensor handling, the normalization
 * check, and the pinned model revision all stay where they already are, so selecting `local` runs
 * the same code path, in the same order, as before this abstraction existed.
 */
export class LocalQueryEmbeddingProvider implements QueryEmbeddingProvider {
  constructor(private readonly generator: QueryEmbeddingGenerator) {}

  async embedQuery(query: string): Promise<QueryEmbeddingProviderResult> {
    return await this.generator.embedQuery(query);
  }
}

export type CreateQueryEmbeddingProviderOptions = {
  logger?: Logger;
  /** Cache directory and offline flag for the local runtime; ignored by the hosted provider. */
  local?: TransformersE5SmallPassageEmbeddingGeneratorOptions;
  /** Injectable so a test can drive the hosted provider without a network. */
  fetchImplementation?: typeof fetch;
};

/**
 * Selects the provider from validated configuration and from nothing else.
 *
 * There is no fallback between the two. A hosted provider that fails is an error, not a reason to
 * quietly load a 118 MB model on an instance that was configured for the hosted one precisely
 * because it cannot hold that model — a fallback there would replace a clear failure with an
 * out-of-memory restart, and would make two different releases retrieve differently under load.
 *
 * Called once per process, from the memoized dependency builder. No request path reaches it, so the
 * provider cannot change between two queries of the same deployment.
 */
export function createQueryEmbeddingProvider(
  config: QueryEmbeddingProviderConfig,
  options: CreateQueryEmbeddingProviderOptions = {},
): QueryEmbeddingProvider {
  const logger = options.logger ?? consoleLogger;

  // The provider name is operator configuration and safe to record; the credential, the model, and
  // the endpoint are not recorded here. One line, at construction, so an operator can confirm from
  // the log which runtime a running release actually chose.
  logger.info("rag_query_embedding_provider_selected", {
    message: `RAG query embedding provider: ${config.provider}.`,
  });

  if (config.provider === "local") {
    return new LocalQueryEmbeddingProvider(
      new TransformersE5SmallPassageEmbeddingGenerator(options.local ?? {}),
    );
  }

  return new HuggingFaceQueryEmbeddingProvider({
    token: config.token,
    model: config.model,
    timeoutMs: config.timeoutMs,
    logger,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
  });
}

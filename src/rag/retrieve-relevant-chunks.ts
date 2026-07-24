import type { RagDocumentStore, RelevantChunkSearchResult } from "./document-store.js";
import {
  RAG_EMBEDDING_PROFILE,
  embeddingProfileModelRef,
  type RagEmbeddingProfile,
} from "./embedding-profile.js";
import type { QueryEmbeddingGenerator } from "./e5-passage-embeddings.js";
import { RagRetrievalError } from "./retrieval-errors.js";

export type RetrieveRelevantChunksOptions = {
  maxChunks: number;
  minScore: number;
  profile?: RagEmbeddingProfile;
};

export type RetrievedRelevantChunk = RelevantChunkSearchResult;

export async function retrieveRelevantChunks(
  store: RagDocumentStore,
  generator: QueryEmbeddingGenerator,
  query: string,
  options: RetrieveRelevantChunksOptions,
): Promise<RetrievedRelevantChunk[]> {
  const profile = options.profile ?? RAG_EMBEDDING_PROFILE;
  validateRetrievalOptions(options);

  const queryEmbedding = await generator.embedQuery(query);
  validateQueryEmbedding(queryEmbedding.embedding, profile.dimension);

  let candidates: RelevantChunkSearchResult[];
  try {
    candidates = await store.searchRelevantChunks({
      queryEmbedding: queryEmbedding.embedding,
      model: embeddingProfileModelRef(profile),
      maxChunks: options.maxChunks,
    });
  } catch (error) {
    if (error instanceof RagRetrievalError) {
      throw error;
    }
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_STORE_FAILED",
      "RAG retrieval storage query failed.",
      true,
      error,
    );
  }

  for (const candidate of candidates) {
    validateScore(candidate.score, candidate.chunkKey);
  }

  return candidates.filter((candidate) => candidate.score >= options.minScore);
}

export function validateRetrievalOptions(options: RetrieveRelevantChunksOptions): void {
  if (!Number.isInteger(options.maxChunks) || options.maxChunks < 1 || options.maxChunks > 5) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_CONFIGURATION",
      "RAG retrieval maxChunks must be an integer from 1 to 5.",
      false,
    );
  }
  if (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 1) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_CONFIGURATION",
      "RAG retrieval minScore must be a finite number from 0 to 1.",
      false,
    );
  }
}

function validateQueryEmbedding(vector: readonly number[], expectedDimension: number): void {
  if (vector.length !== expectedDimension || vector.some((value) => !Number.isFinite(value))) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_QUERY_VECTOR",
      `RAG query embedding must be a finite ${String(expectedDimension)}-dimensional vector.`,
      false,
    );
  }
}

function validateScore(score: number, chunkKey: string): void {
  if (!Number.isFinite(score) || score < -1.0001 || score > 1.0001) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_SCORE",
      `RAG retrieval returned an invalid score for ${chunkKey}.`,
      false,
    );
  }
}

import type {
  RagDocumentStore,
  RelevantChunkSearchOptions,
  RelevantChunkSearchResult,
} from "../../src/rag/document-store.js";
import { RAG_EMBEDDING_PROFILE } from "../../src/rag/embedding-profile.js";
import type {
  QueryEmbeddingGenerator,
  QueryEmbeddingResult,
} from "../../src/rag/e5-passage-embeddings.js";

/**
 * Test doubles for the RAG retrieval boundary.
 *
 * They stand in for the two genuinely external dependencies — the PostgreSQL/pgvector store and the
 * local embedding runtime — so the route, validation, service, threshold, and response mapping all
 * run for real without a database and without loading a 118 MB ONNX model.
 */

/**
 * A store whose only usable method is `searchRelevantChunks`. Every other method throws, so a test
 * that asserts the endpoint is read-only fails loudly if the request path ever reaches one, instead
 * of silently tolerating a write.
 */
export type RecordingRagDocumentStore = RagDocumentStore & {
  searchCalls: RelevantChunkSearchOptions[];
  invokedMethods: string[];
};

export function createRecordingRagDocumentStore(
  results: readonly RelevantChunkSearchResult[] | (() => Promise<RelevantChunkSearchResult[]>),
): RecordingRagDocumentStore {
  const searchCalls: RelevantChunkSearchOptions[] = [];
  const invokedMethods: string[] = [];

  function forbidden(method: string) {
    return () => {
      invokedMethods.push(method);
      return Promise.reject(
        new Error(`${method} must not be reachable from the RAG query endpoint.`),
      );
    };
  }

  return {
    searchCalls,
    invokedMethods,
    searchRelevantChunks: async (options) => {
      invokedMethods.push("searchRelevantChunks");
      searchCalls.push(options);

      const rows = typeof results === "function" ? await results() : [...results];

      // Mirrors the real stores: the width bound is applied by the store, not by the caller.
      return rows.slice(0, options.maxChunks);
    },
    getDocument: forbidden("getDocument"),
    getActiveVersion: forbidden("getActiveVersion"),
    getStagedVersion: forbidden("getStagedVersion"),
    getVersion: forbidden("getVersion"),
    listVersions: forbidden("listVersions"),
    getActiveChunks: forbidden("getActiveChunks"),
    getChunks: forbidden("getChunks"),
    getChunkEmbeddings: forbidden("getChunkEmbeddings"),
    stageVersion: forbidden("stageVersion"),
    saveChunkEmbeddings: forbidden("saveChunkEmbeddings"),
    activateVersion: forbidden("activateVersion"),
  };
}

export type RecordingQueryEmbeddingGenerator = QueryEmbeddingGenerator & {
  embeddedQueries: string[];
};

/**
 * Returns a fixed unit vector of the profile's dimension, so `retrieveRelevantChunks` runs its real
 * dimension and finiteness checks. The vector's direction is irrelevant: the stubbed store decides
 * which chunks come back.
 */
export function createStubQueryEmbeddingGenerator(
  behaviour: { failWith?: Error } = {},
): RecordingQueryEmbeddingGenerator {
  const embeddedQueries: string[] = [];

  return {
    embeddedQueries,
    embedQuery: (query: string): Promise<QueryEmbeddingResult> => {
      embeddedQueries.push(query);

      if (behaviour.failWith !== undefined) {
        return Promise.reject(behaviour.failWith);
      }

      const embedding = new Array<number>(RAG_EMBEDDING_PROFILE.dimension).fill(0);
      embedding[0] = 1;

      return Promise.resolve({
        embedding,
        inputHash: "0".repeat(64),
        tokenCount: 8,
        l2Norm: 1,
        prefixed: true,
      });
    },
  };
}

/** A retrieval result in the shape both stores produce. */
export function searchResult(
  overrides: Partial<RelevantChunkSearchResult> & { chunkKey: string; score: number },
): RelevantChunkSearchResult {
  return {
    content:
      "Frage: Welche Vorteile bietet mir ein Konto?\nAntwort: Sie sehen Ihre Bestellungen jederzeit ein.",
    question: "Welche Vorteile bietet mir ein Konto?",
    answer: "Sie sehen Ihre Bestellungen jederzeit ein.",
    documentKey: "mein-konto",
    documentVersion: 1,
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    title: "Mein Konto",
    documentType: "account-faq",
    language: "de",
    ...overrides,
  };
}

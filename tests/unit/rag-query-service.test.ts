import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
  RAG_RETRIEVAL_MAX_CHUNKS,
} from "../../src/config/rag-retrieval-config.js";
import { AppError } from "../../src/errors/app-error.js";
import { RagEmbeddingError } from "../../src/rag/e5-passage-embeddings.js";
import { embeddingProfileModelRef } from "../../src/rag/embedding-profile.js";
import { createRagQueryService } from "../../src/services/rag-query-service.js";
import { createRequestContext } from "../../src/observability/request-context.js";
import {
  createRecordingRagDocumentStore,
  createStubQueryEmbeddingGenerator,
  searchResult,
  type RecordingRagDocumentStore,
} from "../helpers/rag-test-doubles.js";
import { createRecordingLogger } from "../helpers/test-doubles.js";
import type { RelevantChunkSearchResult } from "../../src/rag/document-store.js";

/**
 * The application service runs the real `retrieveRelevantChunks` path against a stubbed store and a
 * stubbed embedding runtime, so the configured width, the minimum-relevance filter, and the error
 * mapping are all exercised for real.
 */
const RETRIEVAL = {
  maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
  minScore: DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
};

function createService(
  rows: readonly RelevantChunkSearchResult[] | (() => Promise<RelevantChunkSearchResult[]>),
  { embeddingError }: { embeddingError?: Error } = {},
) {
  const store = createRecordingRagDocumentStore(rows);
  const generator = createStubQueryEmbeddingGenerator(
    embeddingError === undefined ? {} : { failWith: embeddingError },
  );
  const logger = createRecordingLogger();

  const service = createRagQueryService(
    () => Promise.resolve({ store, generator, retrieval: RETRIEVAL }),
    logger,
  );

  return { service, store, generator, logger };
}

const CONTEXT = createRequestContext("cid-rag");

describe("createRagQueryService", () => {
  it("returns found evidence for a sufficiently relevant match", async () => {
    const { service, generator } = createService([
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.9123 }),
    ]);

    const response = await service({ query: "Welche Vorteile habe ich?" }, CONTEXT);

    expect(response.status).toBe("found");
    expect(response.query).toBe("Welche Vorteile habe ich?");
    expect(response.evidence).toHaveLength(1);
    expect(response.evidence[0]?.chunkKey).toBe("mein-konto:v1:chunk-001");
    // The query text is embedded verbatim; the E5 `query: ` prefix is the generator's own concern.
    expect(generator.embeddedQueries).toEqual(["Welche Vorteile habe ich?"]);
  });

  it("returns not_found rather than a weak top-1 when nothing reaches the minimum score", async () => {
    const { service, logger } = createService([
      searchResult({
        chunkKey: "mein-konto:v1:chunk-004",
        score: DEFAULT_RAG_RETRIEVAL_MIN_SCORE - 0.0001,
      }),
      searchResult({ chunkKey: "mein-konto:v1:chunk-007", score: 0.42 }),
    ]);

    const response = await service({ query: "Wie repariere ich eine Kaffeemühle?" }, CONTEXT);

    expect(response).toEqual({
      status: "not_found",
      query: "Wie repariere ich eine Kaffeemühle?",
      evidence: [],
    });
    expect(logger.entries).toContainEqual({
      level: "info",
      event: "rag_query_completed",
      fields: { correlationId: "cid-rag", endpoint: "POST /api/rag/query", resultCount: 0 },
    });
  });

  it("keeps a match exactly at the minimum score", async () => {
    const { service } = createService([
      searchResult({ chunkKey: "mein-konto:v1:chunk-002", score: DEFAULT_RAG_RETRIEVAL_MIN_SCORE }),
    ]);

    expect((await service({ query: "Frage?" }, CONTEXT)).status).toBe("found");
  });

  it("searches with the operator-configured width and the active embedding profile", async () => {
    const { service, store } = createService([]);

    await service({ query: "Frage?" }, CONTEXT);

    expect(store.searchCalls).toHaveLength(1);
    expect(store.searchCalls[0]?.maxChunks).toBe(RAG_RETRIEVAL_MAX_CHUNKS);
    expect(store.searchCalls[0]?.model).toEqual(embeddingProfileModelRef());
  });

  it("touches no storage method other than the search", async () => {
    const { service, store } = createService([
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.95 }),
    ]);

    await service({ query: "Frage?" }, CONTEXT);

    expect(store.invokedMethods).toEqual(["searchRelevantChunks"]);
  });

  it("maps a storage failure to INTERNAL_ERROR without leaking the driver message", async () => {
    const { service } = createService(() =>
      Promise.reject(new Error('relation "rag_chunks" does not exist; SELECT c.content FROM …')),
    );

    const error = await service({ query: "Frage?" }, CONTEXT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;

    expect(appError.code).toBe("INTERNAL_ERROR");
    expect(appError.status).toBe(500);
    expect(appError.message).toBe("RAG retrieval failed: RAG_RETRIEVAL_STORE_FAILED.");
    expect(appError.message).not.toContain("SELECT");
    expect(appError.message).not.toContain("rag_chunks");
  });

  it("maps an embedding failure to INTERNAL_ERROR without leaking the model path", async () => {
    const { service } = createService([], {
      embeddingError: new RagEmbeddingError(
        "RAG_EMBEDDING_MODEL_LOAD_FAILED",
        "Local embedding model load failed.",
        true,
        new Error("ENOENT: /home/anna/.cache/huggingface/model_quantized.onnx"),
      ),
    });

    const error = await service({ query: "Frage?" }, CONTEXT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe(
      "RAG query embedding failed: RAG_EMBEDDING_MODEL_LOAD_FAILED.",
    );
    expect((error as AppError).message).not.toContain("/home/");
  });

  it("maps a missing retrieval configuration to INTERNAL_ERROR", async () => {
    const service = createRagQueryService(
      () =>
        Promise.reject(new Error("Invalid or missing RAG retrieval configuration: DATABASE_URL")),
      createRecordingLogger(),
    );

    const error = await service({ query: "Frage?" }, CONTEXT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INTERNAL_ERROR");
    expect((error as AppError).message).toBe("RAG retrieval failed with an unexpected error.");
    expect((error as AppError).message).not.toContain("DATABASE_URL");
  });

  it("never logs the caller's question", async () => {
    const { service, logger } = createService([]);

    await service({ query: "Meine E-Mail-Adresse lautet kundin@example.test" }, CONTEXT);

    expect(JSON.stringify(logger.entries)).not.toContain("kundin@example.test");
  });
});

describe("recording store double", () => {
  it("rejects every mutating call, so a write would fail the read-only tests", async () => {
    const store: RecordingRagDocumentStore = createRecordingRagDocumentStore([]);

    await expect(store.stageVersion({ version: {} as never, chunks: [] })).rejects.toThrow(
      "stageVersion must not be reachable",
    );
  });
});

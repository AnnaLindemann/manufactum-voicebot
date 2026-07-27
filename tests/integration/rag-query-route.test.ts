import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
  RAG_RETRIEVAL_MAX_CHUNKS,
} from "../../src/config/rag-retrieval-config.js";
import { MAX_RAG_QUERY_LENGTH } from "../../src/http/validation/rag-query-request.js";
import { embeddingProfileModelRef } from "../../src/rag/embedding-profile.js";
import { createRagQueryService } from "../../src/services/rag-query-service.js";
import type { RelevantChunkSearchResult } from "../../src/rag/document-store.js";
import type { ErrorEnvelope } from "../../src/errors/app-error.js";
import type { RagQueryResponse } from "../../src/domain/rag-query.js";
import {
  createRecordingRagDocumentStore,
  createStubQueryEmbeddingGenerator,
  searchResult,
} from "../helpers/rag-test-doubles.js";
import { createRecordingLogger } from "../helpers/test-doubles.js";

/**
 * Integration tests drive the real route, JSON parsing, validation, service, retrieval path,
 * threshold, response mapping, and error middleware. Only the two external dependencies are stubbed:
 * the PostgreSQL/pgvector store and the local embedding runtime. No database is touched and no model
 * is loaded, so these tests never depend on a live service.
 */
function createTestApp(
  rows: readonly RelevantChunkSearchResult[] | (() => Promise<RelevantChunkSearchResult[]>) = [],
  { embeddingError }: { embeddingError?: Error } = {},
) {
  const store = createRecordingRagDocumentStore(rows);
  const generator = createStubQueryEmbeddingGenerator(
    embeddingError === undefined ? {} : { failWith: embeddingError },
  );
  const logger = createRecordingLogger();

  const app = createApp({
    logger,
    ragQueryService: createRagQueryService(
      () =>
        Promise.resolve({
          store,
          generator,
          retrieval: {
            maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
            minScore: DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
          },
        }),
      logger,
    ),
  });

  return { app, store, generator, logger };
}

function successBody(response: { body: unknown }): RagQueryResponse {
  return response.body as RagQueryResponse;
}

function errorBody(response: { body: unknown }): ErrorEnvelope {
  return response.body as ErrorEnvelope;
}

const MATCH = searchResult({ chunkKey: "mein-konto:v1:chunk-012", score: 0.918051 });

describe("POST /api/rag/query", () => {
  it("returns found evidence for a query with a sufficiently relevant match", async () => {
    const { app } = createTestApp([MATCH]);

    const response = await request(app)
      .post("/api/rag/query")
      .send({ query: "Welche Vorteile habe ich mit einem Kundenkonto?" });

    expect(response.status).toBe(200);
    expect(successBody(response)).toEqual({
      status: "found",
      query: "Welche Vorteile habe ich mit einem Kundenkonto?",
      evidence: [
        {
          chunkKey: "mein-konto:v1:chunk-012",
          question: "Welche Vorteile bietet mir ein Konto?",
          answer: "Sie sehen Ihre Bestellungen jederzeit ein.",
          score: 0.918051,
          source: {
            documentKey: "mein-konto",
            documentVersion: 1,
            title: "Mein Konto",
            sourceUrl: "https://www.manufactum.de/mein-konto-c201130/",
          },
        },
      ],
    });
  });

  it("returns not_found with empty evidence when no match reaches the minimum score", async () => {
    const { app } = createTestApp([
      searchResult({ chunkKey: "mein-konto:v1:chunk-004", score: 0.71 }),
    ]);

    const response = await request(app)
      .post("/api/rag/query")
      .send({ query: "Wie repariere ich eine Kaffeemühle?" });

    expect(response.status).toBe(200);
    expect(successBody(response)).toEqual({
      status: "not_found",
      query: "Wie repariere ich eine Kaffeemühle?",
      evidence: [],
    });
  });

  it.each([
    ["an empty query", { query: "" }],
    ["a whitespace-only query", { query: "   " }],
    ["a missing query", {}],
    ["a non-string query", { query: 7 }],
    ["a null query", { query: null }],
    ["an over-long query", { query: "a".repeat(MAX_RAG_QUERY_LENGTH + 1) }],
    ["an array body", [{ query: "Frage?" }]],
  ])("rejects %s with the INVALID_REQUEST envelope and performs no retrieval", async (_l, body) => {
    const { app, store, generator } = createTestApp([MATCH]);

    const response = await request(app).post("/api/rag/query").send(body);

    expect(response.status).toBe(400);
    const { correlationId, ...envelope } = errorBody(response);
    expect(envelope).toEqual({
      code: "INVALID_REQUEST",
      safeCustomerMessage: "Ich habe die Anfrage leider nicht verstanden.",
      retryable: false,
    });
    expect(correlationId).toEqual(expect.any(String));
    expect(store.invokedMethods).toEqual([]);
    expect(generator.embeddedQueries).toEqual([]);
  });

  it("rejects a body carrying retrieval-control fields instead of honouring them", async () => {
    const { app, store } = createTestApp([MATCH]);

    const response = await request(app).post("/api/rag/query").send({
      query: "Welche Vorteile habe ich mit einem Kundenkonto?",
      maxChunks: 50,
      minScore: 0,
      embeddingModel: "other/model",
      embeddingModelVersion: "deadbeef",
      documentKey: "anderes-dokument",
      documentVersion: 99,
      sql: "SELECT * FROM rag_chunks",
    });

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("INVALID_REQUEST");
    expect(store.searchCalls).toEqual([]);
  });

  it("retrieves with the configured width and active profile regardless of what a caller sends", async () => {
    const { app, store } = createTestApp([MATCH]);

    await request(app).post("/api/rag/query").send({ query: "Frage?" });
    await request(app)
      .post("/api/rag/query")
      .query({ maxChunks: "50", minScore: "0" })
      .set("x-rag-max-chunks", "50")
      .send({ query: "Frage?" });

    expect(store.searchCalls).toHaveLength(2);
    for (const call of store.searchCalls) {
      expect(call.maxChunks).toBe(RAG_RETRIEVAL_MAX_CHUNKS);
      expect(call.model).toEqual(embeddingProfileModelRef());
    }
  });

  it("rejects a malformed JSON body as INVALID_REQUEST rather than a server error", async () => {
    const { app, store } = createTestApp([MATCH]);

    const response = await request(app)
      .post("/api/rag/query")
      .set("content-type", "application/json")
      .send('{"query": "Frage?"');

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("INVALID_REQUEST");
    expect(store.invokedMethods).toEqual([]);
  });

  it("maps a retrieval storage failure to a safe INTERNAL_ERROR response", async () => {
    const { app, logger } = createTestApp(() =>
      Promise.reject(new Error('relation "rag_chunks" does not exist; SELECT c.content FROM …')),
    );

    const response = await request(app).post("/api/rag/query").send({ query: "Frage?" });

    expect(response.status).toBe(500);
    const { correlationId, ...envelope } = errorBody(response);
    expect(envelope).toEqual({
      code: "INTERNAL_ERROR",
      safeCustomerMessage:
        "Da ist etwas schiefgegangen. Ich kann die Anfrage gerade nicht bearbeiten.",
      retryable: false,
    });
    expect(correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(response.body)).not.toContain("SELECT");
    // The technical detail is withheld from the logs too: only the closed error code is recorded.
    expect(JSON.stringify(logger.entries)).not.toContain("rag_chunks");
  });

  it("maps an embedding-runtime failure to a safe INTERNAL_ERROR response", async () => {
    const { app } = createTestApp([MATCH], {
      embeddingError: new Error("ENOENT /home/anna/.cache/huggingface/model_quantized.onnx"),
    });

    const response = await request(app).post("/api/rag/query").send({ query: "Frage?" });

    expect(response.status).toBe(500);
    expect(errorBody(response).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("/home/");
  });

  it("exposes no embedding, no chunk content, and no storage internals", async () => {
    const { app } = createTestApp([MATCH]);

    const response = await request(app).post("/api/rag/query").send({ query: "Frage?" });

    const body = successBody(response);
    expect(Object.keys(body).sort()).toEqual(["evidence", "query", "status"]);
    for (const evidence of body.evidence) {
      expect(Object.keys(evidence).sort()).toEqual([
        "answer",
        "chunkKey",
        "question",
        "score",
        "source",
      ]);
      expect(Object.keys(evidence.source).sort()).toEqual([
        "documentKey",
        "documentVersion",
        "sourceUrl",
        "title",
      ]);
    }

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "embedding",
      "vector",
      "content",
      "contentHash",
      "inputHash",
      "SELECT",
      "DATABASE_URL",
      "documentType",
      "language",
      "Error",
      "at Object",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reads RAG storage and never writes to it", async () => {
    const { app, store } = createTestApp([MATCH]);

    await request(app).post("/api/rag/query").send({ query: "Frage?" });
    await request(app).post("/api/rag/query").send({ query: "Andere Frage?" });

    expect(store.invokedMethods).toEqual(["searchRelevantChunks", "searchRelevantChunks"]);
  });

  it("returns multiple evidence items in a stable, repeatable order", async () => {
    const ranked = [
      searchResult({ chunkKey: "mein-konto:v1:chunk-012", score: 0.918051 }),
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.900026 }),
      searchResult({ chunkKey: "mein-konto:v1:chunk-004", score: 0.88185 }),
    ];
    const { app } = createTestApp(ranked);

    const first = await request(app).post("/api/rag/query").send({ query: "Frage?" });
    const second = await request(app).post("/api/rag/query").send({ query: "Frage?" });

    expect(successBody(first).evidence.map((item) => item.chunkKey)).toEqual([
      "mein-konto:v1:chunk-012",
      "mein-konto:v1:chunk-001",
      "mein-konto:v1:chunk-004",
    ]);
    expect(successBody(second)).toEqual(successBody(first));
  });

  it("never returns more evidence than the configured width", async () => {
    const { app } = createTestApp(
      Array.from({ length: 10 }, (_unused, index) =>
        searchResult({ chunkKey: `mein-konto:v1:chunk-${String(index)}`, score: 0.95 }),
      ),
    );

    const response = await request(app).post("/api/rag/query").send({ query: "Frage?" });

    expect(successBody(response).evidence).toHaveLength(RAG_RETRIEVAL_MAX_CHUNKS);
  });

  it("rejects other methods on the path with the NOT_FOUND envelope", async () => {
    const { app, store } = createTestApp([MATCH]);

    const response = await request(app).get("/api/rag/query");

    expect(response.status).toBe(404);
    expect(errorBody(response).code).toBe("NOT_FOUND");
    expect(store.invokedMethods).toEqual([]);
  });

  it("echoes the correlation ID so a reported failure is traceable", async () => {
    const { app } = createTestApp([MATCH]);

    const response = await request(app)
      .post("/api/rag/query")
      .set("x-correlation-id", "rag-trace-1")
      .send({ query: "Frage?" });

    expect(response.headers["x-correlation-id"]).toBe("rag-trace-1");
  });
});

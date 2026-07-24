import { describe, expect, it } from "vitest";
import type {
  ChunkCore,
  ChunkEmbeddingCore,
  DocumentVersionCore,
  RagDocumentStore,
} from "../../src/rag/document-store.js";
import type { QueryEmbeddingGenerator } from "../../src/rag/e5-passage-embeddings.js";
import {
  embeddingProfileMetadata,
  embeddingProfileModelRef,
} from "../../src/rag/embedding-profile.js";
import { InMemoryRagDocumentStore } from "../../src/rag/in-memory-document-store.js";
import { retrieveRelevantChunks } from "../../src/rag/retrieve-relevant-chunks.js";

const PROFILE = embeddingProfileMetadata();
const MODEL = embeddingProfileModelRef();
const DEFAULT_OPTIONS = { maxChunks: 3, minScore: 0.8 };

function basis(index: number, value = 1): number[] {
  const vector = Array.from({ length: PROFILE.embeddingDim }, () => 0);
  vector[index] = value;
  return vector;
}

function germanParaphraseVector(): number[] {
  const vector = basis(0, 0.9);
  vector[1] = Math.sqrt(1 - 0.9 * 0.9);
  return vector;
}

function versionCore(
  version: number,
  overrides: Partial<DocumentVersionCore> = {},
): DocumentVersionCore {
  return {
    documentKey: "konto",
    version,
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    title: "Mein Konto",
    documentType: "account-faq",
    language: "de",
    content: `content-v${String(version)}`,
    contentHash: `hash-v${String(version)}`,
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function chunkCore(version: number, index: number, question: string, answer: string): ChunkCore {
  return {
    documentKey: "konto",
    documentVersion: version,
    chunkIndex: index,
    chunkKey: `konto:v${String(version)}:chunk-${String(index).padStart(3, "0")}`,
    question,
    answer,
    content: `Frage: ${question}\nAntwort: ${answer}`,
    contentHash: `hash-v${String(version)}-${String(index)}`,
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    title: "Mein Konto",
    documentType: "account-faq",
    language: "de",
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function embeddingCore(
  chunk: ChunkCore,
  vector: number[],
  overrides: Partial<ChunkEmbeddingCore> = {},
): ChunkEmbeddingCore {
  return {
    documentKey: chunk.documentKey,
    documentVersion: chunk.documentVersion,
    chunkIndex: chunk.chunkIndex,
    ...PROFILE,
    inputHash: `input-${chunk.chunkKey}`,
    chunkContentHash: chunk.contentHash,
    embedding: vector,
    createdAt: "2026-07-21T00:00:10.000Z",
    ...overrides,
  };
}

function generatorFor(queryVectors: Record<string, number[]>): QueryEmbeddingGenerator {
  return {
    embedQuery: (query: string) =>
      Promise.resolve({
        embedding: queryVectors[query] ?? basis(2),
        inputHash: `query-${query}`,
        tokenCount: 3,
        l2Norm: 1,
        prefixed: true,
      }),
  };
}

async function storeWithActiveFaq(): Promise<{
  store: InMemoryRagDocumentStore;
  registerChunk: ChunkCore;
}> {
  const store = new InMemoryRagDocumentStore();
  const registerChunk = chunkCore(
    1,
    1,
    "Wie kann ich mich registrieren?",
    "Sie registrieren sich über den Login-Bereich.",
  );
  const accountChunk = chunkCore(
    1,
    2,
    "Welche Vorteile bietet mir ein Kundenkonto?",
    "Im Kundenkonto finden Sie Bestellhistorie und gespeicherte Adressen.",
  );
  await store.stageVersion({ version: versionCore(1), chunks: [accountChunk, registerChunk] });
  await store.saveChunkEmbeddings([
    embeddingCore(registerChunk, basis(0)),
    embeddingCore(accountChunk, basis(1)),
  ]);
  await store.activateVersion("konto", 1, MODEL);
  return { store, registerChunk };
}

describe("internal RAG retrieval core", () => {
  it("returns the relevant chunk for an exact German question", async () => {
    const { store } = await storeWithActiveFaq();
    const results = await retrieveRelevantChunks(
      store,
      generatorFor({ "Wie kann ich mich registrieren?": basis(0) }),
      "Wie kann ich mich registrieren?",
      DEFAULT_OPTIONS,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      score: 1,
      documentKey: "konto",
      documentVersion: 1,
      chunkKey: "konto:v1:chunk-001",
      sourceUrl: "https://www.manufactum.de/konto-c201130/",
      title: "Mein Konto",
      documentType: "account-faq",
      language: "de",
    });
  });

  it("returns the same chunk for a paraphrased German question above the threshold", async () => {
    const { store } = await storeWithActiveFaq();
    const results = await retrieveRelevantChunks(
      store,
      generatorFor({ "Wo lege ich ein Kundenkonto an?": germanParaphraseVector() }),
      "Wo lege ich ein Kundenkonto an?",
      DEFAULT_OPTIONS,
    );

    expect(results.map((result) => result.chunkKey)).toEqual(["konto:v1:chunk-001"]);
    expect(results[0]?.score).toBeCloseTo(0.9, 6);
  });

  it("returns no-answer for an irrelevant question below the minimum threshold", async () => {
    const { store } = await storeWithActiveFaq();
    const results = await retrieveRelevantChunks(
      store,
      generatorFor({ "Wie lange ist ein Gutschein gueltig?": basis(3) }),
      "Wie lange ist ein Gutschein gueltig?",
      DEFAULT_OPTIONS,
    );

    expect(results).toEqual([]);
  });

  it("returns an empty no-answer result when there are no active versions", async () => {
    const store = new InMemoryRagDocumentStore();
    const chunk = chunkCore(1, 1, "Wie kann ich mich registrieren?", "Über den Login.");
    await store.stageVersion({ version: versionCore(1), chunks: [chunk] });
    await store.saveChunkEmbeddings([embeddingCore(chunk, basis(0))]);

    await expect(
      retrieveRelevantChunks(
        store,
        generatorFor({ "Wie kann ich mich registrieren?": basis(0) }),
        "Wie kann ich mich registrieren?",
        DEFAULT_OPTIONS,
      ),
    ).resolves.toEqual([]);
  });

  it("excludes inactive versions even when they match the query better", async () => {
    const { store } = await storeWithActiveFaq();
    const staged = chunkCore(
      2,
      1,
      "Wie ändere ich meine Rechnungsadresse?",
      "In der Kontoverwaltung.",
    );
    await store.stageVersion({ version: versionCore(2), chunks: [staged] });
    await store.saveChunkEmbeddings([embeddingCore(staged, basis(4))]);

    const results = await retrieveRelevantChunks(
      store,
      generatorFor({ "Wie ändere ich meine Rechnungsadresse?": basis(4) }),
      "Wie ändere ich meine Rechnungsadresse?",
      DEFAULT_OPTIONS,
    );

    expect(results).toEqual([]);
  });

  it("excludes embeddings with the wrong embedding profile", async () => {
    const store = new InMemoryRagDocumentStore();
    const chunk = chunkCore(1, 1, "Wie kann ich mich registrieren?", "Über den Login.");
    await store.stageVersion({ version: versionCore(1), chunks: [chunk] });
    await store.saveChunkEmbeddings([
      embeddingCore(chunk, basis(0), { embeddingProfileId: "other-profile" }),
      embeddingCore(chunk, basis(1)),
    ]);
    await store.activateVersion("konto", 1, MODEL);

    const results = await retrieveRelevantChunks(
      store,
      generatorFor({ "Wie kann ich mich registrieren?": basis(0) }),
      "Wie kann ich mich registrieren?",
      DEFAULT_OPTIONS,
    );

    expect(results).toEqual([]);
  });

  it("respects maxChunks and uses deterministic ordering for ties", async () => {
    const store = new InMemoryRagDocumentStore();
    const chunks = [
      chunkCore(1, 2, "Frage B", "Antwort B"),
      chunkCore(1, 1, "Frage A", "Antwort A"),
      chunkCore(1, 3, "Frage C", "Antwort C"),
    ];
    await store.stageVersion({ version: versionCore(1), chunks });
    await store.saveChunkEmbeddings(chunks.map((chunk) => embeddingCore(chunk, basis(0))));
    await store.activateVersion("konto", 1, MODEL);

    const results = await retrieveRelevantChunks(store, generatorFor({ Tie: basis(0) }), "Tie", {
      minScore: 0.8,
      maxChunks: 2,
    });

    expect(results.map((result) => result.chunkKey)).toEqual([
      "konto:v1:chunk-001",
      "konto:v1:chunk-002",
    ]);
  });

  it("rejects invalid configuration, query vectors, and scores", async () => {
    const { store } = await storeWithActiveFaq();
    const generator = generatorFor({ q: basis(0) });

    await expect(
      retrieveRelevantChunks(store, generator, "q", { minScore: -0.1, maxChunks: 3 }),
    ).rejects.toMatchObject({ code: "RAG_RETRIEVAL_INVALID_CONFIGURATION" });
    await expect(
      retrieveRelevantChunks(store, generator, "q", { minScore: 0.8, maxChunks: 6 }),
    ).rejects.toMatchObject({ code: "RAG_RETRIEVAL_INVALID_CONFIGURATION" });
    await expect(
      retrieveRelevantChunks(store, generatorFor({ bad: [Number.NaN] }), "bad", DEFAULT_OPTIONS),
    ).rejects.toMatchObject({ code: "RAG_RETRIEVAL_INVALID_QUERY_VECTOR" });

    const invalidScoreStore = new InMemoryRagDocumentStore();
    const chunk = chunkCore(1, 1, "q", "a");
    await invalidScoreStore.stageVersion({ version: versionCore(1), chunks: [chunk] });
    await invalidScoreStore.saveChunkEmbeddings([embeddingCore(chunk, basis(0, 2))]);
    await invalidScoreStore.activateVersion("konto", 1, MODEL);
    await expect(
      retrieveRelevantChunks(invalidScoreStore, generator, "q", DEFAULT_OPTIONS),
    ).rejects.toMatchObject({ code: "RAG_RETRIEVAL_INVALID_SCORE" });
  });

  it("maps a database failure to a safe structured retrieval error", async () => {
    const failingStore = {
      searchRelevantChunks: () =>
        Promise.reject(new Error("database exploded with unsafe details")),
    } as unknown as RagDocumentStore;

    await expect(
      retrieveRelevantChunks(failingStore, generatorFor({ q: basis(0) }), "q", DEFAULT_OPTIONS),
    ).rejects.toMatchObject({
      name: "RagRetrievalError",
      code: "RAG_RETRIEVAL_STORE_FAILED",
      retryable: true,
      message: "RAG retrieval storage query failed.",
    });
  });
});

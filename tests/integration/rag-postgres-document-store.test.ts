import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type {
  ChunkCore,
  ChunkEmbeddingCore,
  DocumentVersionCore,
  EmbeddingModelRef,
} from "../../src/rag/document-store.js";
import {
  embeddingProfileMetadata,
  embeddingProfileModelRef,
} from "../../src/rag/embedding-profile.js";
import { runMigrations } from "../../src/rag/migrate.js";
import { PostgresRagDocumentStore } from "../../src/rag/postgres-document-store.js";
import { RagStorageError } from "../../src/rag/in-memory-document-store.js";
import { ingestFaqPage, type IngestionMetadata } from "../../src/rag/ingest-faq-page.js";
import type { ExtractedFaqPage } from "../../src/rag/types.js";

/**
 * Integration tests for `PostgresRagDocumentStore`. They run **only** when `RAG_TEST_DATABASE_URL`
 * points at a disposable PostgreSQL database (with the pgvector extension available); otherwise the
 * whole suite is skipped, so `npm run check` never needs a database connection. The URL is read from
 * the environment and never printed.
 *
 * The database is treated as disposable: tables are truncated before each test.
 */
const DATABASE_URL = process.env.RAG_TEST_DATABASE_URL?.trim();

const MODEL: EmbeddingModelRef = embeddingProfileModelRef();
const PROFILE_METADATA = embeddingProfileMetadata();

function metadata(): IngestionMetadata {
  return {
    documentType: "account-faq",
    language: "de",
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
  };
}

function samplePage(): ExtractedFaqPage {
  return {
    documentKey: "mein-konto",
    pageTitle: "Mein Konto",
    category: "Mein Konto",
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    faqItems: [
      { question: "Wie kann ich mich registrieren?", answer: "Über den Login-Bereich." },
      {
        question: "Welche Vorteile bietet mir ein Konto?",
        answer: "Mit einem Konto genießen Sie:\n• Newsletter\n• Bestellhistorie",
      },
    ],
  };
}

/** A deterministic, incrementing clock so stored timestamps are stable and comparable. */
function fixedClock(start = 0): { now: () => string } {
  let tick = start;
  return { now: () => `2026-07-21T00:00:${String(tick++).padStart(2, "0")}.000Z` };
}

function versionCore(version: number): DocumentVersionCore {
  return {
    documentKey: "doc",
    version,
    sourceUrl: "https://example.test/doc",
    title: "Doc",
    documentType: "faq",
    language: "de",
    content: `content-v${String(version)}`,
    contentHash: `hash-v${String(version)}`,
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function chunkCore(version: number, index: number, chunkKey?: string): ChunkCore {
  return {
    documentKey: "doc",
    documentVersion: version,
    chunkIndex: index,
    chunkKey: chunkKey ?? `doc:v${String(version)}:chunk-00${String(index)}`,
    question: `q${String(index)}`,
    answer: `a${String(index)}`,
    content: `content-${String(index)}`,
    contentHash: `hash-${String(index)}`,
    sourceUrl: "https://example.test/doc",
    title: "Doc",
    documentType: "faq",
    language: "de",
    crawlerVersion: "crawler-1.0.0",
    extractorVersion: "extractor-1.0.0",
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function embeddingCore(
  version: number,
  index: number,
  overrides: Partial<ChunkEmbeddingCore> = {},
): ChunkEmbeddingCore {
  return {
    documentKey: "doc",
    documentVersion: version,
    chunkIndex: index,
    ...PROFILE_METADATA,
    inputHash: `input-hash-v${String(version)}-${String(index)}`,
    chunkContentHash: `hash-${String(index)}`,
    embedding: Array.from({ length: PROFILE_METADATA.embeddingDim }, () => 0.1),
    createdAt: "2026-07-21T00:00:10.000Z",
    ...overrides,
  };
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL.length === 0)(
  "PostgresRagDocumentStore (integration)",
  () => {
    let pool: pg.Pool;
    let store: PostgresRagDocumentStore;

    /** Embed every chunk of a staged version for MODEL, then activate it. */
    async function activate(documentKey: string, version: number): Promise<void> {
      const chunks = await store.getChunks(documentKey, version);
      await store.saveChunkEmbeddings(
        chunks.map((chunk) => embeddingCore(version, chunk.chunkIndex, { documentKey })),
      );
      await store.activateVersion(documentKey, version, MODEL);
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL });
      await runMigrations(pool);
      store = new PostgresRagDocumentStore(pool);
    });

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Disposable database: TRUNCATE bypasses the row-level immutability triggers.
      await pool.query(
        "TRUNCATE rag_chunk_embeddings, rag_chunks, rag_document_versions, rag_documents CASCADE",
      );
    });

    it("stages version 1 invisibly, then activates it after embedding", async () => {
      const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      expect(result.outcome).toBe("staged");
      expect(result.version).toBe(1);

      // Staged but not active: no document header, but the staged version is visible as staged.
      expect(await store.getDocument("mein-konto")).toBeUndefined();
      expect((await store.getStagedVersion("mein-konto"))?.version).toBe(1);
      expect(await store.getActiveChunks("mein-konto")).toEqual([]);

      await activate("mein-konto", 1);

      const doc = await store.getDocument("mein-konto");
      expect(doc?.currentVersion).toBe(1);
      expect(doc?.createdAt).toBe("2026-07-21T00:00:00.000Z");

      const chunks = await store.getActiveChunks("mein-konto");
      expect(chunks).toHaveLength(2);
      expect(chunks.every((chunk) => chunk.isActive)).toBe(true);
      expect(chunks.map((chunk) => chunk.chunkKey)).toEqual([
        "mein-konto:v1:chunk-001",
        "mein-konto:v1:chunk-002",
      ]);
    });

    it("round-trips embedding vectors and metadata through pgvector", async () => {
      await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      await activate("mein-konto", 1);

      const embeddings = await store.getChunkEmbeddings("mein-konto", 1);
      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]?.embedding).toHaveLength(PROFILE_METADATA.embeddingDim);
      expect(embeddings[0]?.embedding[0]).toBeCloseTo(0.1);
      expect(embeddings[0]?.embeddingProvider).toBe(PROFILE_METADATA.embeddingProvider);
      expect(embeddings[0]?.embeddingModel).toBe(MODEL.embeddingModel);
      expect(embeddings[0]?.embeddingModelVersion).toBe(MODEL.embeddingModelVersion);
      expect(embeddings[0]?.embeddingArtifact).toBe(PROFILE_METADATA.embeddingArtifact);
      expect(embeddings[0]?.embeddingDtype).toBe(PROFILE_METADATA.embeddingDtype);
      expect(embeddings[0]?.embeddingRuntime).toBe(PROFILE_METADATA.embeddingRuntime);
      expect(embeddings[0]?.embeddingProfileId).toBe(PROFILE_METADATA.embeddingProfileId);
      expect(embeddings[0]?.embeddingDim).toBe(PROFILE_METADATA.embeddingDim);
      expect(embeddings[0]?.normalized).toBe(true);
      expect(embeddings[0]?.inputRecipe).toBe("e5:passage:v1");
    });

    it("creates no new version when the content hash is unchanged", async () => {
      await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      await activate("mein-konto", 1);
      const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock(50));

      expect(result.outcome).toBe("unchanged");
      expect(await store.listVersions("mein-konto")).toHaveLength(1);
    });

    it("stages and activates version 2 on change, leaving version 1 stored and inactive", async () => {
      await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      await activate("mein-konto", 1);
      const v1ChunksBefore = await store.getChunks("mein-konto", 1);

      const changed = samplePage();
      changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
      const result = await ingestFaqPage(store, changed, metadata(), fixedClock(50));
      expect(result.version).toBe(2);

      // Version 1 stays active until version 2 is activated.
      expect((await store.getActiveVersion("mein-konto"))?.version).toBe(1);
      await activate("mein-konto", 2);
      expect((await store.getDocument("mein-konto"))?.currentVersion).toBe(2);
      expect((await store.getActiveVersion("mein-konto"))?.version).toBe(2);

      const v1ChunksAfter = await store.getChunks("mein-konto", 1);
      expect(v1ChunksAfter.every((chunk) => chunk.isActive === false)).toBe(true);
      expect(v1ChunksAfter.map((chunk) => ({ ...chunk, isActive: true }))).toEqual(v1ChunksBefore);
    });

    it("stages a version and its chunks atomically: a mid-transaction failure persists nothing", async () => {
      // Two chunks share a chunk_key, so the second INSERT violates the UNIQUE constraint and the
      // whole staging must roll back — no version row, no chunk row.
      const chunks = [chunkCore(1, 1, "doc:v1:chunk-001"), chunkCore(1, 2, "doc:v1:chunk-001")];
      await expect(store.stageVersion({ version: versionCore(1), chunks })).rejects.toThrow();

      expect(await store.getStagedVersion("doc")).toBeUndefined();
      expect(await store.listVersions("doc")).toEqual([]);
      expect(await store.getChunks("doc", 1)).toEqual([]);
    });

    it("rejects a non-contiguous next staged version", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await activate("doc", 1);
      await expect(
        store.stageVersion({ version: versionCore(3), chunks: [chunkCore(3, 1)] }),
      ).rejects.toThrow(RagStorageError);
      expect((await store.getDocument("doc"))?.currentVersion).toBe(1);
    });

    it("allows at most one staged version per document", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await activate("doc", 1);
      await store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] });
      // Version 2 is pending: a further staging is refused until it is activated.
      await expect(
        store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] }),
      ).rejects.toThrow(RagStorageError);
    });

    it("refuses to activate a version whose chunks are not fully embedded (readiness gate)", async () => {
      await store.stageVersion({
        version: versionCore(1),
        chunks: [chunkCore(1, 1), chunkCore(1, 2)],
      });
      await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
      await expect(store.activateVersion("doc", 1, MODEL)).rejects.toThrow(RagStorageError);
      // Still no active version.
      expect(await store.getDocument("doc")).toBeUndefined();

      // Embedding the missing chunk (chunk 1 idempotently skipped) unblocks activation.
      await store.saveChunkEmbeddings([embeddingCore(1, 1), embeddingCore(1, 2)]);
      await store.activateVersion("doc", 1, MODEL);
      expect((await store.getDocument("doc"))?.currentVersion).toBe(1);
    });

    it("is idempotent on an exact retry, including a fresh createdAt", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
      await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
      await store.saveChunkEmbeddings([
        embeddingCore(1, 1, { createdAt: "2026-07-21T09:30:00.000Z" }),
      ]);
      expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(1);

      // A different model version is a distinct row (safe re-embedding).
      await store.saveChunkEmbeddings([embeddingCore(1, 1, { embeddingModelVersion: "rev-2" })]);
      expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(2);
    });

    it("rejects a conflicting retry: same natural key, different content, not silently ignored", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
      // Same (chunk, model, model version) key but a different vector must fail, not DO NOTHING.
      await expect(
        store.saveChunkEmbeddings([
          embeddingCore(1, 1, {
            embedding: Array.from({ length: PROFILE_METADATA.embeddingDim }, () => 0.9),
          }),
        ]),
      ).rejects.toThrow(RagStorageError);
      // A different input hash also conflicts.
      await expect(
        store.saveChunkEmbeddings([embeddingCore(1, 1, { inputHash: "different-input-hash" })]),
      ).rejects.toThrow(RagStorageError);
      // The original row is preserved unchanged.
      const embeddings = await store.getChunkEmbeddings("doc", 1);
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]?.embedding).toHaveLength(PROFILE_METADATA.embeddingDim);
    });

    it("rejects an embedding for a non-existent chunk (foreign key)", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await expect(store.saveChunkEmbeddings([embeddingCore(1, 99)])).rejects.toThrow();
    });

    it("forbids an orphan document version: a version needs an existing document (foreign key)", async () => {
      // A raw insert of a version whose document_key has no rag_documents row must violate the
      // restored versions -> documents foreign key. Staging never produces this because it creates the
      // document header first.
      await expect(
        pool.query(
          `INSERT INTO rag_document_versions
             (document_key, version, source_url, title, document_type, language,
              content, content_hash, crawler_version, extractor_version, created_at)
           VALUES ('orphan-doc', 1, 'https://example.test/x', 'X', 'faq', 'de',
                   'c', 'h', 'crawler-1.0.0', 'extractor-1.0.0', '2026-07-21T00:00:00.000Z')`,
        ),
      ).rejects.toThrow();
      // Nothing leaked in.
      expect(await store.getStagedVersion("orphan-doc")).toBeUndefined();
    });

    it("rejects an embedding whose declared dimension mismatches the vector length", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await expect(
        store.saveChunkEmbeddings([embeddingCore(1, 1, { embeddingDim: 383 })]),
      ).rejects.toThrow(RagStorageError);
    });

    it("forbids updating a stored version at the database level (immutability)", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await expect(
        pool.query("UPDATE rag_document_versions SET title = 'x' WHERE document_key = 'doc'"),
      ).rejects.toThrow();
    });

    it("forbids updating or deleting a stored embedding at the database level (immutability)", async () => {
      await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
      await expect(
        pool.query("UPDATE rag_chunk_embeddings SET normalized = false WHERE document_key = 'doc'"),
      ).rejects.toThrow();
      await expect(
        pool.query("DELETE FROM rag_chunk_embeddings WHERE document_key = 'doc'"),
      ).rejects.toThrow();
    });
  },
);

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { ChunkCore, DocumentVersionCore } from "../../src/rag/document-store.js";
import { runMigrations } from "../../src/rag/migrate.js";
import { PostgresRagDocumentStore } from "../../src/rag/postgres-document-store.js";
import { RagStorageError } from "../../src/rag/in-memory-document-store.js";
import { ingestFaqPage, type IngestionMetadata } from "../../src/rag/ingest-faq-page.js";
import type { ExtractedFaqPage } from "../../src/rag/types.js";

/**
 * Integration tests for `PostgresRagDocumentStore`. They run **only** when `RAG_TEST_DATABASE_URL`
 * points at a disposable PostgreSQL database; otherwise the whole suite is skipped, so `npm run check`
 * never needs a database connection. The URL is read from the environment and never printed.
 *
 * The database is treated as disposable: tables are truncated before each test.
 */
const DATABASE_URL = process.env.RAG_TEST_DATABASE_URL?.trim();

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

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL.length === 0)(
  "PostgresRagDocumentStore (integration)",
  () => {
    let pool: pg.Pool;
    let store: PostgresRagDocumentStore;

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
      await pool.query("TRUNCATE rag_chunks, rag_document_versions, rag_documents CASCADE");
    });

    it("persists version 1 and its active chunks on the first ingest", async () => {
      const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      expect(result.outcome).toBe("created");
      expect(result.version).toBe(1);

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

    it("creates no new version when the content hash is unchanged", async () => {
      await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      const result = await ingestFaqPage(store, samplePage(), metadata(), fixedClock(50));

      expect(result.outcome).toBe("unchanged");
      expect(await store.listVersions("mein-konto")).toHaveLength(1);
    });

    it("creates version 2 on change, activates it, and leaves version 1 stored and inactive", async () => {
      await ingestFaqPage(store, samplePage(), metadata(), fixedClock());
      const v1ChunksBefore = await store.getChunks("mein-konto", 1);

      const changed = samplePage();
      changed.faqItems[0]!.answer = "Über das Registrierungsformular.";
      const result = await ingestFaqPage(store, changed, metadata(), fixedClock(50));

      expect(result.version).toBe(2);
      expect((await store.getDocument("mein-konto"))?.currentVersion).toBe(2);
      expect((await store.getActiveVersion("mein-konto"))?.version).toBe(2);

      // Version 1 remains, now inactive, byte-for-byte identical apart from the derived isActive flag.
      const v1ChunksAfter = await store.getChunks("mein-konto", 1);
      expect(v1ChunksAfter.every((chunk) => chunk.isActive === false)).toBe(true);
      expect(v1ChunksAfter.map((chunk) => ({ ...chunk, isActive: true }))).toEqual(v1ChunksBefore);
      expect((await store.getVersion("mein-konto", 1))?.isActive).toBe(false);
    });

    it("writes a version and its chunks atomically: a mid-transaction failure persists nothing", async () => {
      // Two chunks share a chunk_key, so the second INSERT violates the UNIQUE constraint and the
      // whole append must roll back — no document row, no version row, no chunk row.
      const chunks = [chunkCore(1, 1, "doc:v1:chunk-001"), chunkCore(1, 2, "doc:v1:chunk-001")];
      await expect(store.appendVersion({ version: versionCore(1), chunks })).rejects.toThrow();

      expect(await store.getDocument("doc")).toBeUndefined();
      expect(await store.listVersions("doc")).toEqual([]);
      expect(await store.getChunks("doc", 1)).toEqual([]);
    });

    it("rejects a non-contiguous next version", async () => {
      await store.appendVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await expect(
        store.appendVersion({ version: versionCore(3), chunks: [chunkCore(3, 1)] }),
      ).rejects.toThrow(RagStorageError);
      // The rejected append left the active version at 1.
      expect((await store.getDocument("doc"))?.currentVersion).toBe(1);
    });

    it("forbids updating a stored version at the database level (immutability)", async () => {
      await store.appendVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
      await expect(
        pool.query("UPDATE rag_document_versions SET title = 'x' WHERE document_key = 'doc'"),
      ).rejects.toThrow();
    });
  },
);

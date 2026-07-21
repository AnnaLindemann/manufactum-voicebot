import { describe, expect, it } from "vitest";
import type { ChunkCore, DocumentVersionCore } from "../../src/rag/document-store.js";
import {
  InMemoryRagDocumentStore,
  RagStorageError,
} from "../../src/rag/in-memory-document-store.js";

/** A minimal well-formed version core for storage-invariant tests. */
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

/** One chunk core belonging to the given version. */
function chunkCore(version: number, index: number): ChunkCore {
  return {
    documentKey: "doc",
    documentVersion: version,
    chunkIndex: index,
    chunkKey: `doc:v${String(version)}:chunk-00${String(index)}`,
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

describe("InMemoryRagDocumentStore — reads on an unknown key", () => {
  it("returns undefined/empty for a key that was never ingested", async () => {
    const store = new InMemoryRagDocumentStore();
    expect(await store.getDocument("missing")).toBeUndefined();
    expect(await store.getActiveVersion("missing")).toBeUndefined();
    expect(await store.getVersion("missing", 1)).toBeUndefined();
    expect(await store.listVersions("missing")).toEqual([]);
    expect(await store.getActiveChunks("missing")).toEqual([]);
    expect(await store.getChunks("missing", 1)).toEqual([]);
  });
});

describe("InMemoryRagDocumentStore — version numbering invariants", () => {
  it("rejects a first version that is not 1", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      store.appendVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] }),
    ).rejects.toThrow(RagStorageError);
  });

  it("rejects a non-contiguous next version", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.appendVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await expect(
      store.appendVersion({ version: versionCore(3), chunks: [chunkCore(3, 1)] }),
    ).rejects.toThrow(RagStorageError);
  });

  it("rejects re-appending an existing version, preserving immutability", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.appendVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    // Appending version 1 again is not the expected successor (2), so it is refused.
    await expect(
      store.appendVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] }),
    ).rejects.toThrow(RagStorageError);
  });

  it("rejects a chunk whose version or key does not match its version record", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      store.appendVersion({ version: versionCore(1), chunks: [chunkCore(2, 1)] }),
    ).rejects.toThrow(RagStorageError);
    const foreign: ChunkCore = { ...chunkCore(1, 1), documentKey: "other" };
    await expect(
      store.appendVersion({ version: versionCore(1), chunks: [foreign] }),
    ).rejects.toThrow(RagStorageError);
  });
});

describe("InMemoryRagDocumentStore — immutability of stored records", () => {
  it("does not reflect later mutations of the caller's input arrays or objects", async () => {
    const store = new InMemoryRagDocumentStore();
    const chunks = [chunkCore(1, 1)];
    await store.appendVersion({ version: versionCore(1), chunks });

    // Mutating the caller's array and object after the append must not affect stored state.
    chunks.push(chunkCore(1, 2));
    chunks[0]!.answer = "mutated";

    const stored = await store.getActiveChunks("doc");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.answer).toBe("a1");
  });

  it("orders chunks by ascending chunkIndex regardless of insertion order", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.appendVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 3), chunkCore(1, 1), chunkCore(1, 2)],
    });
    expect((await store.getActiveChunks("doc")).map((chunk) => chunk.chunkIndex)).toEqual([
      1, 2, 3,
    ]);
  });
});

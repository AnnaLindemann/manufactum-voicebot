import { describe, expect, it } from "vitest";
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
import {
  InMemoryRagDocumentStore,
  RagStorageError,
} from "../../src/rag/in-memory-document-store.js";

/** The active embedding model used throughout these tests. */
const MODEL: EmbeddingModelRef = embeddingProfileModelRef();
const PROFILE_METADATA = embeddingProfileMetadata();

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

/** One embedding core for the given chunk, using MODEL and a 384-dimensional vector. */
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
    embedding: vector384(0.1),
    createdAt: "2026-07-21T00:00:10.000Z",
    ...overrides,
  };
}

function vector384(value: number): number[] {
  return Array.from({ length: PROFILE_METADATA.embeddingDim }, () => value);
}

/** Stage version `n` with `count` chunks, embed all of them for MODEL, and activate it. */
async function stageEmbedActivate(
  store: InMemoryRagDocumentStore,
  version: number,
  count: number,
): Promise<void> {
  const chunks = Array.from({ length: count }, (_, i) => chunkCore(version, i + 1));
  await store.stageVersion({ version: versionCore(version), chunks });
  await store.saveChunkEmbeddings(chunks.map((chunk) => embeddingCore(version, chunk.chunkIndex)));
  await store.activateVersion("doc", version, MODEL);
}

describe("InMemoryRagDocumentStore — reads on an unknown key", () => {
  it("returns undefined/empty for a key that was never ingested", async () => {
    const store = new InMemoryRagDocumentStore();
    expect(await store.getDocument("missing")).toBeUndefined();
    expect(await store.getActiveVersion("missing")).toBeUndefined();
    expect(await store.getStagedVersion("missing")).toBeUndefined();
    expect(await store.getVersion("missing", 1)).toBeUndefined();
    expect(await store.listVersions("missing")).toEqual([]);
    expect(await store.getActiveChunks("missing")).toEqual([]);
    expect(await store.getChunks("missing", 1)).toEqual([]);
    expect(await store.getChunkEmbeddings("missing", 1)).toEqual([]);
  });
});

describe("InMemoryRagDocumentStore — staging without activation", () => {
  it("stages version 1 with no active version until it is activated", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });

    // Staged but not active: no document header, no active version, no active chunks.
    expect(await store.getDocument("doc")).toBeUndefined();
    expect(await store.getActiveVersion("doc")).toBeUndefined();
    expect(await store.getActiveChunks("doc")).toEqual([]);

    // The staged version is visible as staged (and inactive) and via listVersions/getVersion.
    const staged = await store.getStagedVersion("doc");
    expect(staged?.version).toBe(1);
    expect(staged?.isActive).toBe(false);
    expect((await store.getVersion("doc", 1))?.isActive).toBe(false);
    expect((await store.listVersions("doc")).map((v) => v.version)).toEqual([1]);
    expect((await store.getChunks("doc", 1)).every((chunk) => chunk.isActive === false)).toBe(true);
  });

  it("rejects a first staged version that is not 1", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] }),
    ).rejects.toThrow(RagStorageError);
  });

  it("rejects a chunk whose version or key does not match its version record", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      store.stageVersion({ version: versionCore(1), chunks: [chunkCore(2, 1)] }),
    ).rejects.toThrow(RagStorageError);
    const foreign: ChunkCore = { ...chunkCore(1, 1), documentKey: "other" };
    await expect(
      store.stageVersion({ version: versionCore(1), chunks: [foreign] }),
    ).rejects.toThrow(RagStorageError);
  });

  it("allows at most one staged version: staging N+2 over a pending N+1 is refused", async () => {
    const store = new InMemoryRagDocumentStore();
    await stageEmbedActivate(store, 1, 1); // active v1
    await store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] }); // staged v2

    // A second staged version cannot be created while v2 is pending, whatever its number.
    await expect(
      store.stageVersion({ version: versionCore(3), chunks: [chunkCore(3, 1)] }),
    ).rejects.toThrow(RagStorageError);
    await expect(
      store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] }),
    ).rejects.toThrow(RagStorageError);
  });
});

describe("InMemoryRagDocumentStore — embedding persistence", () => {
  it("rejects an embedding whose dimension does not match its vector length", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await expect(
      store.saveChunkEmbeddings([embeddingCore(1, 1, { embeddingDim: 383 })]),
    ).rejects.toThrow(RagStorageError);
  });

  it("rejects an embedding that references an unknown chunk", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await expect(store.saveChunkEmbeddings([embeddingCore(1, 99)])).rejects.toThrow(
      RagStorageError,
    );
  });

  it("is append-only and idempotent: an exact retry of the same row adds no duplicate", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);

    const embeddings = await store.getChunkEmbeddings("doc", 1);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.embedding).toHaveLength(384);
    expect(embeddings[0]?.embeddingModel).toBe(MODEL.embeddingModel);
  });

  it("treats a retry with identical content but a fresh createdAt as an idempotent no-op", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    // Same natural key and same content, only createdAt differs: still a no-op, keeping the first row.
    await store.saveChunkEmbeddings([
      embeddingCore(1, 1, { createdAt: "2026-07-21T09:30:00.000Z" }),
    ]);
    const embeddings = await store.getChunkEmbeddings("doc", 1);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.createdAt).toBe("2026-07-21T00:00:10.000Z");
  });

  it("rejects a conflicting retry: same natural key but a different vector", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await expect(
      store.saveChunkEmbeddings([embeddingCore(1, 1, { embedding: vector384(0.9) })]),
    ).rejects.toThrow(RagStorageError);
    // The original row is preserved unchanged.
    expect((await store.getChunkEmbeddings("doc", 1))[0]?.embedding).toHaveLength(384);
  });

  it("rejects a conflicting retry: same natural key but a different input hash", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await expect(
      store.saveChunkEmbeddings([embeddingCore(1, 1, { inputHash: "different-input-hash" })]),
    ).rejects.toThrow(RagStorageError);
  });

  it("keeps separate rows for two model versions of the same chunk (safe re-embedding)", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await store.saveChunkEmbeddings([embeddingCore(1, 1, { embeddingModelVersion: "rev-2" })]);

    const embeddings = await store.getChunkEmbeddings("doc", 1);
    expect(embeddings.map((e) => e.embeddingModelVersion)).toEqual([
      MODEL.embeddingModelVersion,
      "rev-2",
    ]);
  });
});

describe("InMemoryRagDocumentStore — activation and the readiness gate", () => {
  it("refuses to activate a version whose chunks are not fully embedded", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });
    // Only one of two chunks embedded: the gate must block activation.
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await expect(store.activateVersion("doc", 1, MODEL)).rejects.toThrow(RagStorageError);
    expect(await store.getActiveVersion("doc")).toBeUndefined();
  });

  it("refuses to activate against a model that has no embeddings", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await expect(
      store.activateVersion("doc", 1, {
        ...MODEL,
        embeddingModel: "other/model",
      }),
    ).rejects.toThrow(RagStorageError);
  });

  it("refuses to activate a version that was never staged", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(store.activateVersion("doc", 1, MODEL)).rejects.toThrow(RagStorageError);
  });

  it("activates version 1 once fully embedded, exposing it as the active version", async () => {
    const store = new InMemoryRagDocumentStore();
    await stageEmbedActivate(store, 1, 2);

    expect((await store.getDocument("doc"))?.currentVersion).toBe(1);
    expect((await store.getActiveVersion("doc"))?.version).toBe(1);
    expect(await store.getStagedVersion("doc")).toBeUndefined();
    const chunks = await store.getActiveChunks("doc");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.isActive)).toBe(true);
  });

  it("succeeds on a retry that fills in a missing embedding after a partial run", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });
    await store.saveChunkEmbeddings([embeddingCore(1, 1)]);
    await expect(store.activateVersion("doc", 1, MODEL)).rejects.toThrow(RagStorageError);

    // Re-run embeds only the missing chunk (chunk 1 is idempotently skipped) and activation succeeds.
    await store.saveChunkEmbeddings([embeddingCore(1, 1), embeddingCore(1, 2)]);
    expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(2);
    await store.activateVersion("doc", 1, MODEL);
    expect((await store.getActiveVersion("doc"))?.version).toBe(1);
  });

  it("rejects activating a non-successor version", async () => {
    const store = new InMemoryRagDocumentStore();
    await stageEmbedActivate(store, 1, 1); // active v1
    await store.stageVersion({ version: versionCore(2), chunks: [chunkCore(2, 1)] });
    await store.saveChunkEmbeddings([embeddingCore(2, 1)]);
    // Re-activating v1 is not the successor (2) and is refused.
    await expect(store.activateVersion("doc", 1, MODEL)).rejects.toThrow(RagStorageError);
  });
});

describe("InMemoryRagDocumentStore — versioning across activations", () => {
  it("activates version 2 and leaves version 1 stored, inactive, and unchanged", async () => {
    const store = new InMemoryRagDocumentStore();
    await stageEmbedActivate(store, 1, 2);
    const v1ChunksBefore = await store.getChunks("doc", 1);

    await stageEmbedActivate(store, 2, 2);

    expect((await store.getDocument("doc"))?.currentVersion).toBe(2);
    expect((await store.getVersion("doc", 1))?.isActive).toBe(false);
    expect((await store.getVersion("doc", 2))?.isActive).toBe(true);

    const v1ChunksAfter = await store.getChunks("doc", 1);
    expect(v1ChunksAfter.every((chunk) => chunk.isActive === false)).toBe(true);
    expect(v1ChunksAfter.map((chunk) => ({ ...chunk, isActive: true }))).toEqual(v1ChunksBefore);
  });
});

describe("InMemoryRagDocumentStore — immutability of stored records", () => {
  it("does not reflect later mutations of the caller's input arrays or objects", async () => {
    const store = new InMemoryRagDocumentStore();
    const chunks = [chunkCore(1, 1)];
    await store.stageVersion({ version: versionCore(1), chunks });

    // Mutating the caller's array and object after staging must not affect stored state.
    chunks.push(chunkCore(1, 2));
    chunks[0]!.answer = "mutated";

    const stored = await store.getChunks("doc", 1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.answer).toBe("a1");
  });

  it("does not reflect later mutation of a saved embedding's vector array", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({ version: versionCore(1), chunks: [chunkCore(1, 1)] });
    const embedding = embeddingCore(1, 1);
    await store.saveChunkEmbeddings([embedding]);

    embedding.embedding[0] = 9.9;
    expect((await store.getChunkEmbeddings("doc", 1))[0]?.embedding).toHaveLength(384);
  });

  it("orders chunks by ascending chunkIndex regardless of insertion order", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 3), chunkCore(1, 1), chunkCore(1, 2)],
    });
    expect((await store.getChunks("doc", 1)).map((chunk) => chunk.chunkIndex)).toEqual([1, 2, 3]);
  });
});

import { describe, expect, it } from "vitest";
import {
  embedAndActivateStagedVersion,
  embedStagedVersion,
} from "../../src/rag/embed-staged-version.js";
import type { ChunkCore, DocumentVersionCore } from "../../src/rag/document-store.js";
import type { PassageEmbeddingGenerator } from "../../src/rag/e5-passage-embeddings.js";
import {
  RAG_EMBEDDING_PROFILE,
  embeddingProfileMetadata,
} from "../../src/rag/embedding-profile.js";
import {
  InMemoryRagDocumentStore,
  RagStorageError,
} from "../../src/rag/in-memory-document-store.js";

const PROFILE_METADATA = embeddingProfileMetadata();

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

function vector(value: number): number[] {
  return Array.from({ length: RAG_EMBEDDING_PROFILE.dimension }, () => value);
}

describe("embedAndActivateStagedVersion", () => {
  it("generates missing staged chunk embeddings, persists exact profile metadata, and activates via the gate", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });
    const embeddedInputs: string[] = [];

    const result = await embedAndActivateStagedVersion(
      store,
      "doc",
      {
        embedPassage: (content: string) => {
          embeddedInputs.push(content);
          return Promise.resolve({
            embedding: vector(content.endsWith("1") ? 0.1 : 0.2),
            inputHash: `input-hash-${content}`,
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          });
        },
      },
      { now: () => "2026-07-21T00:00:10.000Z" },
    );

    expect(result).toEqual({
      documentKey: "doc",
      version: 1,
      chunkCount: 2,
      existingEmbeddingCount: 0,
      generatedEmbeddingCount: 2,
      activated: true,
    });
    expect(embeddedInputs).toEqual(["content-1", "content-2"]);
    expect((await store.getDocument("doc"))?.currentVersion).toBe(1);

    const embeddings = await store.getChunkEmbeddings("doc", 1);
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toMatchObject({
      ...PROFILE_METADATA,
      inputHash: "input-hash-content-1",
      chunkContentHash: "hash-1",
    });
  });

  it("resumes safely by embedding only chunks not already covered for the active profile", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });
    await store.saveChunkEmbeddings([
      {
        documentKey: "doc",
        documentVersion: 1,
        chunkIndex: 1,
        ...PROFILE_METADATA,
        inputHash: "input-hash-content-1",
        chunkContentHash: "hash-1",
        embedding: vector(0.1),
        createdAt: "2026-07-21T00:00:05.000Z",
      },
    ]);

    const generated: string[] = [];
    const result = await embedAndActivateStagedVersion(
      store,
      "doc",
      {
        embedPassage: (content: string) => {
          generated.push(content);
          return Promise.resolve({
            embedding: vector(0.2),
            inputHash: `input-hash-${content}`,
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          });
        },
      },
      { now: () => "2026-07-21T00:00:10.000Z" },
    );

    expect(result.existingEmbeddingCount).toBe(1);
    expect(result.generatedEmbeddingCount).toBe(1);
    expect(generated).toEqual(["content-2"]);
    expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(2);
    expect((await store.getActiveVersion("doc"))?.version).toBe(1);
  });

  it("does not activate when embedding generation fails before complete coverage is saved", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });

    await expect(
      embedAndActivateStagedVersion(store, "doc", {
        embedPassage: (content: string) => {
          if (content === "content-2") {
            return Promise.reject(new Error("model failed"));
          }
          return Promise.resolve({
            embedding: vector(0.1),
            inputHash: `input-hash-${content}`,
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          });
        },
      }),
    ).rejects.toThrow("model failed");

    expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(0);
    expect(await store.getActiveVersion("doc")).toBeUndefined();
  });

  it("rejects a document without a staged version", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      embedAndActivateStagedVersion(store, "doc", {
        embedPassage: () =>
          Promise.resolve({
            embedding: vector(0.1),
            inputHash: "hash",
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          }),
      }),
    ).rejects.toThrow(RagStorageError);
  });
});

describe("embedStagedVersion", () => {
  it("embeds the staged version without activating it", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });

    const result = await embedStagedVersion(
      store,
      "doc",
      {
        embedPassage: (content: string) =>
          Promise.resolve({
            embedding: vector(0.1),
            inputHash: `input-hash-${content}`,
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          }),
      },
      { now: () => "2026-07-21T00:00:10.000Z" },
    );

    expect(result).toEqual({
      documentKey: "doc",
      version: 1,
      chunkCount: 2,
      existingEmbeddingCount: 0,
      generatedEmbeddingCount: 2,
      activated: false,
    });
    expect(await store.getChunkEmbeddings("doc", 1)).toHaveLength(2);
    // The version stays staged: embedding alone must never advance the active pointer.
    expect(await store.getActiveVersion("doc")).toBeUndefined();
    expect(await store.getDocument("doc")).toBeUndefined();
    expect((await store.getStagedVersion("doc"))?.version).toBe(1);
  });

  it("is idempotent: a repeat run generates nothing and leaves the stored embeddings untouched", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.stageVersion({
      version: versionCore(1),
      chunks: [chunkCore(1, 1), chunkCore(1, 2)],
    });
    const generator: PassageEmbeddingGenerator = {
      embedPassage: (content: string) =>
        Promise.resolve({
          embedding: vector(0.1),
          inputHash: `input-hash-${content}`,
          tokenCount: 8,
          l2Norm: 1,
          prefixed: true,
        }),
    };
    const options = { now: () => "2026-07-21T00:00:10.000Z" };

    const first = await embedStagedVersion(store, "doc", generator, options);
    const afterFirst = await store.getChunkEmbeddings("doc", 1);

    const second = await embedStagedVersion(store, "doc", generator, options);

    expect(first.generatedEmbeddingCount).toBe(2);
    expect(second.generatedEmbeddingCount).toBe(0);
    expect(second.existingEmbeddingCount).toBe(2);
    expect(second.activated).toBe(false);
    expect(await store.getChunkEmbeddings("doc", 1)).toEqual(afterFirst);
    expect(await store.getActiveVersion("doc")).toBeUndefined();
  });

  it("rejects a document without a staged version", async () => {
    const store = new InMemoryRagDocumentStore();
    await expect(
      embedStagedVersion(store, "doc", {
        embedPassage: () =>
          Promise.resolve({
            embedding: vector(0.1),
            inputHash: "hash",
            tokenCount: 8,
            l2Norm: 1,
            prefixed: true,
          }),
      }),
    ).rejects.toThrow(RagStorageError);
  });
});

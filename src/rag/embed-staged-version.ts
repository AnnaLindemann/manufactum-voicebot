import type { ChunkEmbeddingCore, RagDocumentStore, StoredChunk } from "./document-store.js";
import type { PassageEmbeddingGenerator } from "./e5-passage-embeddings.js";
import {
  RAG_EMBEDDING_PROFILE,
  embeddingProfileMetadata,
  embeddingProfileModelRef,
  type RagEmbeddingProfile,
} from "./embedding-profile.js";
import { RagStorageError } from "./in-memory-document-store.js";

export type EmbedStagedVersionOptions = {
  now?: () => string;
  profile?: RagEmbeddingProfile;
};

export type EmbedStagedVersionResult = {
  documentKey: string;
  version: number;
  chunkCount: number;
  existingEmbeddingCount: number;
  generatedEmbeddingCount: number;
  activated: true;
};

export async function embedAndActivateStagedVersion(
  store: RagDocumentStore,
  documentKey: string,
  generator: PassageEmbeddingGenerator,
  options: EmbedStagedVersionOptions = {},
): Promise<EmbedStagedVersionResult> {
  const profile = options.profile ?? RAG_EMBEDDING_PROFILE;
  const profileMetadata = embeddingProfileMetadata(profile);
  const staged = await store.getStagedVersion(documentKey);
  if (staged === undefined) {
    throw new RagStorageError(`Document "${documentKey}" has no staged version to embed.`);
  }

  const chunks = await store.getChunks(documentKey, staged.version);
  const existing = await store.getChunkEmbeddings(documentKey, staged.version);
  const existingKeys = new Set(
    existing
      .filter(
        (embedding) =>
          embedding.embeddingProvider === profileMetadata.embeddingProvider &&
          embedding.embeddingModel === profileMetadata.embeddingModel &&
          embedding.embeddingModelVersion === profileMetadata.embeddingModelVersion &&
          embedding.embeddingArtifact === profileMetadata.embeddingArtifact &&
          embedding.embeddingDtype === profileMetadata.embeddingDtype &&
          embedding.embeddingRuntime === profileMetadata.embeddingRuntime &&
          embedding.embeddingProfileId === profileMetadata.embeddingProfileId,
      )
      .map((embedding) => embeddingKey(embedding.chunkIndex)),
  );

  const now = options.now ?? (() => new Date().toISOString());
  const missing = chunks.filter((chunk) => !existingKeys.has(embeddingKey(chunk.chunkIndex)));
  const generated: ChunkEmbeddingCore[] = [];

  for (const chunk of missing) {
    const result = await generator.embedPassage(chunk.content);
    generated.push(
      chunkEmbeddingFromResult(chunk, result.embedding, result.inputHash, now(), profile),
    );
  }

  if (generated.length > 0) {
    await store.saveChunkEmbeddings(generated);
  }

  await store.activateVersion(documentKey, staged.version, embeddingProfileModelRef(profile));

  return {
    documentKey,
    version: staged.version,
    chunkCount: chunks.length,
    existingEmbeddingCount: existingKeys.size,
    generatedEmbeddingCount: generated.length,
    activated: true,
  };
}

function chunkEmbeddingFromResult(
  chunk: StoredChunk,
  embedding: number[],
  inputHash: string,
  createdAt: string,
  profile: RagEmbeddingProfile,
): ChunkEmbeddingCore {
  return {
    documentKey: chunk.documentKey,
    documentVersion: chunk.documentVersion,
    chunkIndex: chunk.chunkIndex,
    ...embeddingProfileMetadata(profile),
    inputHash,
    chunkContentHash: chunk.contentHash,
    embedding,
    createdAt,
  };
}

function embeddingKey(chunkIndex: number): string {
  return String(chunkIndex);
}

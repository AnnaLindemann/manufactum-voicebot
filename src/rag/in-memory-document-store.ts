// The store methods are async only to satisfy the Promise-returning `RagDocumentStore` contract (which
// exists for persistent backends); this in-memory implementation resolves synchronously and has no
// `await` of its own. Throws still surface as rejected promises, as callers expect.
/* eslint-disable @typescript-eslint/require-await */
import type {
  ChunkCore,
  ChunkEmbeddingCore,
  DocumentVersionCore,
  EmbeddingModelRef,
  NewVersionInput,
  RagDocumentStore,
  RelevantChunkSearchOptions,
  RelevantChunkSearchResult,
  StoredChunk,
  StoredChunkEmbedding,
  StoredDocument,
  StoredDocumentVersion,
} from "./document-store.js";
import { RagRetrievalError } from "./retrieval-errors.js";

/**
 * In-memory implementation of `RagDocumentStore` (roadmap Phase 10–11, offline ingestion only).
 *
 * A single-process, non-persistent store used for ingestion development and tests. It exists so the
 * versioning, staging, embedding, and immutability rules of `rag-design.md` /
 * `rag-embeddings-and-retrieval-design.md` can be implemented and proven without PostgreSQL or
 * pgvector. The ingestion flow depends only on the interface, so swapping this for the PostgreSQL
 * implementation later is a drop-in change.
 *
 * Immutability is structural, not by convention: stored cores are frozen at write time and are never
 * handed back directly. Every read builds a fresh, frozen view object and computes `isActive` from
 * the document's active version, so activating a new version never mutates any stored record.
 *
 * Lifecycle (design §4). A version is first **staged** (stored, but not active — `activeVersion` is
 * left untouched, and a brand-new key gets no active pointer at all). Its chunk **embeddings** are
 * then stored, append-only and idempotently. Finally the version is **activated**, but only once every
 * chunk of that version has an embedding for the active model (the readiness gate).
 */

/** A storage invariant was violated, e.g. a non-contiguous version, a pending staged version, or an
 * activation attempted before all embeddings exist. */
export class RagStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RagStorageError";
  }
}

/**
 * Internal per-document state. `versions`/`chunks` are keyed by version number; both are append-only.
 * `activeVersion` is `undefined` for a staged-but-never-activated new key (no active pointer yet).
 * `embeddings` is an append-only list of embedding cores across all versions of this document.
 */
type DocumentEntry = {
  activeVersion: number | undefined;
  /** Creation time of version 1, used as the document's `createdAt`. */
  createdAt: string;
  versions: Map<number, DocumentVersionCore>;
  chunks: Map<number, ChunkCore[]>;
  embeddings: ChunkEmbeddingCore[];
};

export class InMemoryRagDocumentStore implements RagDocumentStore {
  private readonly documents = new Map<string, DocumentEntry>();

  async getDocument(documentKey: string): Promise<StoredDocument | undefined> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined || entry.activeVersion === undefined) {
      // No entry, or a staged-only document with no active version yet: invisible as a document.
      return undefined;
    }
    const active = entry.versions.get(entry.activeVersion);
    // An active entry always has its active version stored; this guard is defensive and never expected.
    if (active === undefined) {
      return undefined;
    }
    return Object.freeze({
      documentKey: active.documentKey,
      sourceUrl: active.sourceUrl,
      title: active.title,
      documentType: active.documentType,
      language: active.language,
      currentVersion: active.version,
      contentHash: active.contentHash,
      createdAt: entry.createdAt,
      lastChangedAt: active.createdAt,
    });
  }

  async getActiveVersion(documentKey: string): Promise<StoredDocumentVersion | undefined> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined || entry.activeVersion === undefined) {
      return undefined;
    }
    return this.viewVersion(entry, entry.activeVersion);
  }

  async getStagedVersion(documentKey: string): Promise<StoredDocumentVersion | undefined> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return undefined;
    }
    const staged = stagedVersionNumber(entry);
    return staged === undefined ? undefined : this.viewVersion(entry, staged);
  }

  async getVersion(
    documentKey: string,
    version: number,
  ): Promise<StoredDocumentVersion | undefined> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return undefined;
    }
    return this.viewVersion(entry, version);
  }

  async listVersions(documentKey: string): Promise<StoredDocumentVersion[]> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return [];
    }
    return [...entry.versions.keys()]
      .sort((a, b) => a - b)
      .map((version) => this.viewVersion(entry, version))
      .filter((version): version is StoredDocumentVersion => version !== undefined);
  }

  async getActiveChunks(documentKey: string): Promise<StoredChunk[]> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined || entry.activeVersion === undefined) {
      return [];
    }
    return this.viewChunks(entry, entry.activeVersion);
  }

  async getChunks(documentKey: string, version: number): Promise<StoredChunk[]> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return [];
    }
    return this.viewChunks(entry, version);
  }

  async getChunkEmbeddings(documentKey: string, version: number): Promise<StoredChunkEmbedding[]> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return [];
    }
    return entry.embeddings
      .filter((embedding) => embedding.documentVersion === version)
      .sort(compareEmbeddings)
      .map(viewEmbedding);
  }

  async stageVersion(input: NewVersionInput): Promise<void> {
    const { version, chunks } = input;
    const documentKey = version.documentKey;

    // Every chunk must belong to the version being staged: a mismatch would corrupt the immutable
    // one-version-per-chunk relationship, so it is rejected rather than silently stored.
    for (const chunk of chunks) {
      if (chunk.documentKey !== documentKey) {
        throw new RagStorageError(
          `Chunk documentKey "${chunk.documentKey}" does not match version documentKey "${documentKey}".`,
        );
      }
      if (chunk.documentVersion !== version.version) {
        throw new RagStorageError(
          `Chunk documentVersion ${String(chunk.documentVersion)} does not match version ${String(version.version)}.`,
        );
      }
    }

    const existing = this.documents.get(documentKey);

    if (existing === undefined) {
      if (version.version !== 1) {
        throw new RagStorageError(
          `First version for "${documentKey}" must be 1, received ${String(version.version)}.`,
        );
      }
      // Stage version 1 without an active pointer: the document is invisible until activated.
      this.documents.set(documentKey, {
        activeVersion: undefined,
        createdAt: version.createdAt,
        versions: new Map([[1, freezeVersion(version)]]),
        chunks: new Map([[1, freezeChunks(chunks)]]),
        embeddings: [],
      });
      return;
    }

    // At most one staged version per document: a pending staged version blocks staging another one.
    if (stagedVersionNumber(existing) !== undefined) {
      throw new RagStorageError(
        `Document "${documentKey}" already has a pending staged version; activate it before staging another.`,
      );
    }

    // Versions are contiguous and append-only. The next stageable version is exactly the successor of
    // the active version (or 1 when there is no active version yet).
    const expected = (existing.activeVersion ?? 0) + 1;
    if (version.version !== expected) {
      throw new RagStorageError(
        `Next version for "${documentKey}" must be ${String(expected)}, received ${String(version.version)}.`,
      );
    }
    existing.versions.set(version.version, freezeVersion(version));
    existing.chunks.set(version.version, freezeChunks(chunks));
  }

  async saveChunkEmbeddings(embeddings: ChunkEmbeddingCore[]): Promise<void> {
    for (const embedding of embeddings) {
      // The declared dimension must match the actual vector length (mirrors the DB's
      // CHECK (vector_dims(embedding) = embedding_dim)).
      if (embedding.embedding.length !== embedding.embeddingDim) {
        throw new RagStorageError(
          `Embedding dimension ${String(embedding.embeddingDim)} does not match vector length ${String(embedding.embedding.length)} for ${embedding.documentKey} v${String(embedding.documentVersion)} chunk ${String(embedding.chunkIndex)}.`,
        );
      }

      const entry = this.documents.get(embedding.documentKey);
      const versionChunks = entry?.chunks.get(embedding.documentVersion);
      const chunkExists =
        versionChunks?.some((chunk) => chunk.chunkIndex === embedding.chunkIndex) ?? false;
      // An embedding must reference an existing staged chunk (mirrors the DB foreign key).
      if (entry === undefined || !chunkExists) {
        throw new RagStorageError(
          `Embedding references unknown chunk ${embedding.documentKey} v${String(embedding.documentVersion)} chunk ${String(embedding.chunkIndex)}.`,
        );
      }

      // Append-only. A row already present for this (chunk, model, model version) natural key is a
      // no-op only if its content is identical (idempotent retry); a conflicting retry with the same
      // key but different vector/hashes/metadata must fail loudly rather than be silently ignored, so
      // an inconsistent re-embedding is never hidden.
      const existing = entry.embeddings.find(
        (candidate) =>
          candidate.documentVersion === embedding.documentVersion &&
          candidate.chunkIndex === embedding.chunkIndex &&
          candidate.embeddingProvider === embedding.embeddingProvider &&
          candidate.embeddingModel === embedding.embeddingModel &&
          candidate.embeddingModelVersion === embedding.embeddingModelVersion &&
          candidate.embeddingArtifact === embedding.embeddingArtifact &&
          candidate.embeddingDtype === embedding.embeddingDtype &&
          candidate.embeddingRuntime === embedding.embeddingRuntime &&
          candidate.embeddingProfileId === embedding.embeddingProfileId,
      );
      if (existing === undefined) {
        entry.embeddings.push(freezeEmbedding(embedding));
      } else if (!embeddingContentEqual(existing, embedding)) {
        throw new RagStorageError(
          `Conflicting embedding for existing key ${embedding.documentKey} v${String(embedding.documentVersion)} chunk ${String(embedding.chunkIndex)} (${embedding.embeddingModel}@${embedding.embeddingModelVersion}): a stored embedding with different content already exists and is immutable.`,
        );
      }
    }
  }

  async activateVersion(
    documentKey: string,
    version: number,
    model: EmbeddingModelRef,
  ): Promise<void> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined || !entry.versions.has(version)) {
      throw new RagStorageError(
        `Cannot activate version ${String(version)} of "${documentKey}": it is not staged.`,
      );
    }

    // Activation only ever moves the pointer forward by one, to the single staged version.
    const expected = (entry.activeVersion ?? 0) + 1;
    if (version !== expected) {
      throw new RagStorageError(
        `Next activatable version for "${documentKey}" is ${String(expected)}, received ${String(version)}.`,
      );
    }

    // Embedding readiness gate (design §4-C): every chunk of the target version must carry an
    // embedding for the active model before the version can become active.
    const missing = this.uncoveredChunkCount(entry, version, model);
    if (missing > 0) {
      throw new RagStorageError(
        `Cannot activate version ${String(version)} of "${documentKey}": ${String(missing)} chunk(s) lack an embedding for ${model.embeddingModel}@${model.embeddingModelVersion}.`,
      );
    }

    entry.activeVersion = version;
  }

  async searchRelevantChunks(
    options: RelevantChunkSearchOptions,
  ): Promise<RelevantChunkSearchResult[]> {
    const results: RelevantChunkSearchResult[] = [];
    for (const [documentKey, entry] of this.documents.entries()) {
      if (entry.activeVersion === undefined) {
        continue;
      }
      const chunks = entry.chunks.get(entry.activeVersion) ?? [];
      for (const chunk of chunks) {
        const embedding = entry.embeddings.find(
          (candidate) =>
            candidate.documentVersion === chunk.documentVersion &&
            candidate.chunkIndex === chunk.chunkIndex &&
            embeddingMatchesModel(candidate, options.model),
        );
        if (embedding === undefined) {
          continue;
        }
        const score = cosineSimilarity(options.queryEmbedding, embedding.embedding);
        if (!Number.isFinite(score) || score < -1.0001 || score > 1.0001) {
          throw new RagRetrievalError(
            "RAG_RETRIEVAL_INVALID_SCORE",
            `Invalid cosine similarity for ${documentKey} ${chunk.chunkKey}.`,
            false,
          );
        }
        results.push(
          Object.freeze({
            content: chunk.content,
            question: chunk.question,
            answer: chunk.answer,
            score,
            documentKey,
            documentVersion: chunk.documentVersion,
            chunkKey: chunk.chunkKey,
            sourceUrl: chunk.sourceUrl,
            title: chunk.title,
            documentType: chunk.documentType,
            language: chunk.language,
          }),
        );
      }
    }

    return results.sort(compareRetrievalResults).slice(0, options.maxChunks);
  }

  /** Count chunks of `version` that have no embedding for the given model (0 means fully covered). */
  private uncoveredChunkCount(
    entry: DocumentEntry,
    version: number,
    model: EmbeddingModelRef,
  ): number {
    const chunks = entry.chunks.get(version) ?? [];
    return chunks.filter(
      (chunk) =>
        !entry.embeddings.some(
          (embedding) =>
            embedding.documentVersion === version &&
            embedding.chunkIndex === chunk.chunkIndex &&
            embedding.embeddingProvider === model.embeddingProvider &&
            embedding.embeddingModel === model.embeddingModel &&
            embedding.embeddingModelVersion === model.embeddingModelVersion &&
            embedding.embeddingArtifact === model.embeddingArtifact &&
            embedding.embeddingDtype === model.embeddingDtype &&
            embedding.embeddingRuntime === model.embeddingRuntime &&
            embedding.embeddingProfileId === model.embeddingProfileId,
        ),
    ).length;
  }

  /** Build a frozen version view with `isActive` derived from the entry's active version. */
  private viewVersion(entry: DocumentEntry, version: number): StoredDocumentVersion | undefined {
    const core = entry.versions.get(version);
    if (core === undefined) {
      return undefined;
    }
    return Object.freeze({ ...core, isActive: version === entry.activeVersion });
  }

  /** Build frozen chunk views for one version, ascending by index, with derived `isActive`. */
  private viewChunks(entry: DocumentEntry, version: number): StoredChunk[] {
    const cores = entry.chunks.get(version);
    if (cores === undefined) {
      return [];
    }
    const isActive = version === entry.activeVersion;
    return cores
      .map((core) => Object.freeze({ ...core, isActive }))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }
}

function embeddingMatchesModel(embedding: ChunkEmbeddingCore, model: EmbeddingModelRef): boolean {
  return (
    embedding.embeddingProvider === model.embeddingProvider &&
    embedding.embeddingModel === model.embeddingModel &&
    embedding.embeddingModelVersion === model.embeddingModelVersion &&
    embedding.embeddingArtifact === model.embeddingArtifact &&
    embedding.embeddingDtype === model.embeddingDtype &&
    embedding.embeddingRuntime === model.embeddingRuntime &&
    embedding.embeddingProfileId === model.embeddingProfileId
  );
}

function cosineSimilarity(query: readonly number[], passage: readonly number[]): number {
  if (query.length !== passage.length) {
    throw new RagRetrievalError(
      "RAG_RETRIEVAL_INVALID_SCORE",
      `Cannot compare query dimension ${String(query.length)} with passage dimension ${String(passage.length)}.`,
      false,
    );
  }
  return query.reduce((sum, value, index) => sum + value * passage[index]!, 0);
}

function compareRetrievalResults(
  a: RelevantChunkSearchResult,
  b: RelevantChunkSearchResult,
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.documentKey !== b.documentKey) {
    return a.documentKey.localeCompare(b.documentKey);
  }
  if (a.documentVersion !== b.documentVersion) {
    return a.documentVersion - b.documentVersion;
  }
  return a.chunkKey.localeCompare(b.chunkKey);
}

/** The staged version number (greater than the active version), or `undefined` if none is pending. */
function stagedVersionNumber(entry: DocumentEntry): number | undefined {
  const active = entry.activeVersion ?? 0;
  const staged = [...entry.versions.keys()].filter((version) => version > active);
  // At most one staged version is ever allowed, so the array holds zero or one element.
  return staged.length === 0 ? undefined : Math.max(...staged);
}

/**
 * Whether two embeddings for the same natural key carry identical content: same vector (element-wise),
 * dimension, recipe, normalization, and both hashes. `createdAt` is excluded — it is a recording
 * timestamp, not embedding content, so a legitimate retry with a fresh timestamp stays idempotent.
 */
function embeddingContentEqual(a: ChunkEmbeddingCore, b: ChunkEmbeddingCore): boolean {
  return (
    a.embeddingDim === b.embeddingDim &&
    a.embeddingProvider === b.embeddingProvider &&
    a.embeddingArtifact === b.embeddingArtifact &&
    a.embeddingDtype === b.embeddingDtype &&
    a.embeddingRuntime === b.embeddingRuntime &&
    a.embeddingProfileId === b.embeddingProfileId &&
    a.inputRecipe === b.inputRecipe &&
    a.normalized === b.normalized &&
    a.inputHash === b.inputHash &&
    a.chunkContentHash === b.chunkContentHash &&
    a.embedding.length === b.embedding.length &&
    a.embedding.every((value, index) => value === b.embedding[index])
  );
}

/** Stable ordering for embeddings of one version: by chunk, then model, then model version. */
function compareEmbeddings(a: ChunkEmbeddingCore, b: ChunkEmbeddingCore): number {
  if (a.chunkIndex !== b.chunkIndex) {
    return a.chunkIndex - b.chunkIndex;
  }
  if (a.embeddingModel !== b.embeddingModel) {
    return a.embeddingModel.localeCompare(b.embeddingModel);
  }
  if (a.embeddingModelVersion !== b.embeddingModelVersion) {
    return a.embeddingModelVersion.localeCompare(b.embeddingModelVersion);
  }
  return a.embeddingProfileId.localeCompare(b.embeddingProfileId);
}

/** Freeze a defensive copy of a version core so no external reference can mutate the stored record. */
function freezeVersion(version: DocumentVersionCore): DocumentVersionCore {
  return Object.freeze({ ...version });
}

/** Freeze defensive copies of chunk cores and the array holding them. */
function freezeChunks(chunks: ChunkCore[]): ChunkCore[] {
  return Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))) as ChunkCore[];
}

/** Freeze a defensive copy of an embedding core, copying its vector so later input mutation is inert. */
function freezeEmbedding(embedding: ChunkEmbeddingCore): ChunkEmbeddingCore {
  return Object.freeze({ ...embedding, embedding: [...embedding.embedding] });
}

/** Build a frozen embedding view with its own vector copy. */
function viewEmbedding(embedding: ChunkEmbeddingCore): StoredChunkEmbedding {
  return Object.freeze({ ...embedding, embedding: [...embedding.embedding] });
}

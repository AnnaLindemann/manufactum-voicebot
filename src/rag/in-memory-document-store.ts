// The store methods are async only to satisfy the Promise-returning `RagDocumentStore` contract (which
// exists for persistent backends); this in-memory implementation resolves synchronously and has no
// `await` of its own. Throws in `appendVersion` still surface as rejected promises, as callers expect.
/* eslint-disable @typescript-eslint/require-await */
import type {
  ChunkCore,
  DocumentVersionCore,
  NewVersionInput,
  RagDocumentStore,
  StoredChunk,
  StoredDocument,
  StoredDocumentVersion,
} from "./document-store.js";

/**
 * In-memory implementation of `RagDocumentStore` (roadmap Phase 10–11, offline ingestion only).
 *
 * A single-process, non-persistent store used for ingestion development and tests. It exists so the
 * versioning and immutability rules of `rag-design.md`/`D-005` can be implemented and proven without
 * PostgreSQL, pgvector, or any new dependency (`D-003`/`D-004` keep the real database for a later
 * phase). The ingestion flow depends only on the interface, so swapping this for the PostgreSQL
 * implementation later is a drop-in change.
 *
 * Immutability is structural, not by convention: stored cores are frozen at write time and are never
 * handed back directly. Every read builds a fresh, frozen view object and computes `isActive` from
 * the document's current active version, so activating a new version never mutates any stored record.
 */

/** A storage invariant was violated, e.g. a non-contiguous or duplicate version append. */
export class RagStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RagStorageError";
  }
}

/** Internal per-document state. `versions`/`chunks` are keyed by version number; both are append-only. */
type DocumentEntry = {
  activeVersion: number;
  /** Creation time of version 1, used as the document's `createdAt`. */
  createdAt: string;
  versions: Map<number, DocumentVersionCore>;
  chunks: Map<number, ChunkCore[]>;
};

export class InMemoryRagDocumentStore implements RagDocumentStore {
  private readonly documents = new Map<string, DocumentEntry>();

  async getDocument(documentKey: string): Promise<StoredDocument | undefined> {
    const entry = this.documents.get(documentKey);
    if (entry === undefined) {
      return undefined;
    }
    const active = entry.versions.get(entry.activeVersion);
    // An entry always has its active version stored; this guard is defensive and never expected.
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
    if (entry === undefined) {
      return undefined;
    }
    return this.viewVersion(entry, entry.activeVersion);
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
    if (entry === undefined) {
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

  async appendVersion(input: NewVersionInput): Promise<void> {
    const { version, chunks } = input;
    const documentKey = version.documentKey;

    // Every chunk must belong to the version being appended: a mismatch would corrupt the immutable
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
      const entry: DocumentEntry = {
        activeVersion: 1,
        createdAt: version.createdAt,
        versions: new Map([[1, freezeVersion(version)]]),
        chunks: new Map([[1, freezeChunks(chunks)]]),
      };
      this.documents.set(documentKey, entry);
      return;
    }

    // Versions are contiguous and append-only. Requiring exactly the successor makes overwriting an
    // existing version (which would break immutability) impossible by construction.
    const expected = existing.activeVersion + 1;
    if (version.version !== expected) {
      throw new RagStorageError(
        `Next version for "${documentKey}" must be ${String(expected)}, received ${String(version.version)}.`,
      );
    }
    existing.versions.set(version.version, freezeVersion(version));
    existing.chunks.set(version.version, freezeChunks(chunks));
    existing.activeVersion = version.version;
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

/** Freeze a defensive copy of a version core so no external reference can mutate the stored record. */
function freezeVersion(version: DocumentVersionCore): DocumentVersionCore {
  return Object.freeze({ ...version });
}

/** Freeze defensive copies of chunk cores and the array holding them. */
function freezeChunks(chunks: ChunkCore[]): ChunkCore[] {
  return Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))) as ChunkCore[];
}

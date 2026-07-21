/**
 * Storage contract for versioned, immutable RAG knowledge documents (roadmap Phase 10–11, offline
 * ingestion only).
 *
 * This file defines the *interface* and the stored record shapes, deliberately kept apart from any
 * concrete implementation. The MVP ships one implementation — an in-memory store
 * (`in-memory-document-store.ts`) — but the ingestion flow (`ingest-faq-page.ts`) depends only on
 * this interface, so the planned PostgreSQL/pgvector implementation (`D-004`) can replace it without
 * touching the flow or its tests.
 *
 * Design rules encoded here, from `rag-design.md` and `D-005`:
 *
 * - every chunk belongs to exactly one immutable document version;
 * - versions and their chunks are **immutable** once stored — they are never edited, only superseded;
 * - a document has exactly one *active* version at a time; superseding a version leaves the previous
 *   version and its chunks stored but no longer active;
 * - `isActive` is therefore not a stored, mutable flag but a **derived** property: it is computed on
 *   read from the document's current active version, so making a new version active never mutates any
 *   previously stored record. Nothing here creates embeddings, retrieves, or exposes an HTTP surface.
 */

/**
 * The immutable core of one document version — everything that is fixed at creation time. It carries
 * no `isActive`, because activeness is derived on read (see `StoredDocumentVersion`).
 *
 * `content` and `contentHash` are the version-independent canonical content and its SHA-256 digest
 * (see `computeDocumentContentHash`). The traceability fields (`sourceUrl`, `title`, `documentType`,
 * `language`, `crawlerVersion`, `extractorVersion`, `createdAt`) satisfy the metadata list in
 * `rag-design.md`; none is invented by the store — each is supplied by the ingestion caller.
 */
export type DocumentVersionCore = {
  documentKey: string;
  version: number;
  sourceUrl: string;
  title: string;
  documentType: string;
  language: string;
  content: string;
  contentHash: string;
  crawlerVersion: string;
  extractorVersion: string;
  createdAt: string;
};

/** A document version as returned to callers: its immutable core plus the derived active flag. */
export type StoredDocumentVersion = DocumentVersionCore & { isActive: boolean };

/**
 * The immutable core of one stored chunk. Mirrors `PreparedChunk` and adds the traceability metadata
 * that the chunk must carry independently of its version record (`rag-design.md` § Required metadata).
 * Carries no `isActive`; activeness is derived on read.
 */
export type ChunkCore = {
  documentKey: string;
  documentVersion: number;
  chunkIndex: number;
  chunkKey: string;
  question: string;
  answer: string;
  content: string;
  contentHash: string;
  sourceUrl: string;
  title: string;
  documentType: string;
  language: string;
  crawlerVersion: string;
  extractorVersion: string;
  createdAt: string;
};

/** A chunk as returned to callers: its immutable core plus the derived active flag. */
export type StoredChunk = ChunkCore & { isActive: boolean };

/**
 * A document header, derived from its currently active version. `currentVersion` and `contentHash`
 * mirror the active version, so change detection compares an incoming page's hash against
 * `contentHash` here. `createdAt` is when version 1 was created; `lastChangedAt` is when the active
 * version was created.
 */
export type StoredDocument = {
  documentKey: string;
  sourceUrl: string;
  title: string;
  documentType: string;
  language: string;
  currentVersion: number;
  contentHash: string;
  createdAt: string;
  lastChangedAt: string;
};

/**
 * A fully-formed new version and its chunks, ready to be appended and made active. The ingestion flow
 * builds this — including deciding the `version` number — and the store only persists it. Keeping the
 * version number out of the store keeps `D-005`'s rule that *the flow*, not the caller and not the
 * store's internals, owns version numbering; the store merely enforces the numbering is contiguous
 * and never overwrites an existing version.
 */
export type NewVersionInput = {
  version: DocumentVersionCore;
  chunks: ChunkCore[];
};

/**
 * Persistence contract for versioned RAG documents. Reads return freshly built, immutable views with
 * the derived `isActive` flag; the store never hands back an internal reference a caller could mutate.
 * All list results are ordered ascending (versions by number, chunks by `chunkIndex`).
 *
 * Every method is asynchronous. The in-memory implementation resolves synchronously in practice, but
 * the contract is `Promise`-returning so a persistent backend (`PostgresRagDocumentStore`, `D-004`)
 * is a drop-in replacement without changing the ingestion flow or its tests.
 */
export interface RagDocumentStore {
  /** The document header derived from the active version, or `undefined` if the key was never ingested. */
  getDocument(documentKey: string): Promise<StoredDocument | undefined>;

  /** The active version, or `undefined` if the key is unknown. */
  getActiveVersion(documentKey: string): Promise<StoredDocumentVersion | undefined>;

  /** A specific version, or `undefined` if the key or version is unknown. */
  getVersion(documentKey: string, version: number): Promise<StoredDocumentVersion | undefined>;

  /** Every stored version for a key, ascending by version number; empty for an unknown key. */
  listVersions(documentKey: string): Promise<StoredDocumentVersion[]>;

  /** The chunks of the active version, ascending by `chunkIndex`; empty for an unknown key. */
  getActiveChunks(documentKey: string): Promise<StoredChunk[]>;

  /** The chunks of a specific version, ascending by `chunkIndex`; empty if key or version is unknown. */
  getChunks(documentKey: string, version: number): Promise<StoredChunk[]>;

  /**
   * Append a new immutable version and its chunks and make it the active version, atomically. Must
   * reject a version that is not exactly the successor of the current active version (or `1` for a new
   * key), so an already-stored version can never be overwritten and versioning stays contiguous. A
   * persistent implementation performs the version insert, chunk inserts, and `currentVersion` update
   * in a single transaction.
   */
  appendVersion(input: NewVersionInput): Promise<void>;
}

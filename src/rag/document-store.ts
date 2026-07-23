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
 *   previously stored record.
 *
 * Lifecycle split (`rag-embeddings-and-retrieval-design.md` §4). Appending a version is split into
 * three distinct steps so a version becomes active **only after** all its embeddings are stored:
 *
 * - **stage** (`stageVersion`) — insert the immutable version and its chunks **without** advancing the
 *   active pointer; for a brand-new key no `rag_documents` header is created yet, so the document is
 *   simply invisible to retrieval until activated;
 * - **embed** (`saveChunkEmbeddings`) — persist one immutable embedding row per (chunk × full embedding
 *   profile) into `rag_chunk_embeddings`; append-only and idempotent;
 * - **activate** (`activateVersion`) — under a per-document lock, verify every chunk of the target
 *   version has an embedding for the active model (readiness gate), then advance/create the active
 *   pointer atomically.
 *
 * This file still creates no embedding vectors, runs no retrieval, and exposes no HTTP surface: the
 * embedding vector is supplied by the caller; computing it is a later offline phase.
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
 * A fully-formed new version and its chunks, ready to be staged. The ingestion flow builds this —
 * including deciding the `version` number — and the store only persists it. Keeping the version number
 * out of the store keeps `D-005`'s rule that *the flow*, not the caller and not the store's internals,
 * owns version numbering; the store merely enforces the numbering is contiguous and never overwrites
 * an existing version.
 */
export type NewVersionInput = {
  version: DocumentVersionCore;
  chunks: ChunkCore[];
};

/**
 * The immutable core of one chunk embedding, as stored in `rag_chunk_embeddings`
 * (`rag-embeddings-and-retrieval-design.md` §2–3). It is self-describing: every field needed to know
 * *how* the vector was produced is stored on the row, so a future re-embedding is reproducible and
 * comparable without a join.
 *
 * The embedding is bound to exactly one immutable chunk of one document version via
 * `(documentKey, documentVersion, chunkIndex)`. Provider, model, pinned revision, artifact, dtype,
 * runtime, and profile ID identify the exact embedding profile; two profiles may yield different
 * vectors and must never be mixed in one search. `embeddingDim` must equal `embedding.length` (the DB
 * mirrors this with `CHECK (vector_dims(embedding) = embedding_dim)`). `inputRecipe` records the
 * input-string recipe including the E5 task prefix; `inputHash` is the SHA-256 of the exact string fed
 * to the model; `chunkContentHash` copies the chunk's `contentHash` at embedding time. `normalized`
 * records whether L2 normalization was applied. This module never computes the vector — the caller
 * supplies it.
 */
export type ChunkEmbeddingCore = {
  documentKey: string;
  documentVersion: number;
  chunkIndex: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingModelVersion: string;
  embeddingArtifact: string;
  embeddingDtype: string;
  embeddingRuntime: string;
  embeddingProfileId: string;
  embeddingDim: number;
  inputRecipe: string;
  normalized: boolean;
  inputHash: string;
  chunkContentHash: string;
  /** The vector itself. Its length must equal `embeddingDim`. */
  embedding: number[];
  createdAt: string;
};

/** A chunk embedding as returned to callers: the immutable core, handed back as a frozen copy. */
export type StoredChunkEmbedding = ChunkEmbeddingCore;

/**
 * The active embedding model identity used to gate activation and (later) to filter retrieval. The
 * active model is runtime configuration, not a stored flag: activation succeeds only when every chunk
 * of the target version carries an embedding for exactly this full embedding profile identity.
 */
export type EmbeddingModelRef = {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingModelVersion: string;
  embeddingArtifact: string;
  embeddingDtype: string;
  embeddingRuntime: string;
  embeddingProfileId: string;
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

  /** The active version, or `undefined` if the key is unknown or has no active version yet. */
  getActiveVersion(documentKey: string): Promise<StoredDocumentVersion | undefined>;

  /**
   * The staged (not-yet-active) version, or `undefined` if none is pending. A staged version is one
   * whose number is greater than the active version (for a brand-new key, a version whose document has
   * no active pointer yet). At most one staged version exists per document at any time.
   */
  getStagedVersion(documentKey: string): Promise<StoredDocumentVersion | undefined>;

  /** A specific version, or `undefined` if the key or version is unknown. */
  getVersion(documentKey: string, version: number): Promise<StoredDocumentVersion | undefined>;

  /** Every stored version for a key, ascending by version number; empty for an unknown key. */
  listVersions(documentKey: string): Promise<StoredDocumentVersion[]>;

  /** The chunks of the active version, ascending by `chunkIndex`; empty for an unknown key. */
  getActiveChunks(documentKey: string): Promise<StoredChunk[]>;

  /** The chunks of a specific version, ascending by `chunkIndex`; empty if key or version is unknown. */
  getChunks(documentKey: string, version: number): Promise<StoredChunk[]>;

  /**
   * The stored embeddings for a specific version, in a stable order. Empty if the key or version is
   * unknown or has no embeddings yet. Used to inspect embedding coverage; never mutates anything.
   */
  getChunkEmbeddings(documentKey: string, version: number): Promise<StoredChunkEmbedding[]>;

  /**
   * **Stage** a new immutable version and its chunks **without** activating it (design §4-A). The
   * active pointer is not advanced, and for a brand-new key no document header is created — a staged
   * document is invisible to retrieval until activated. Must reject a version that is not exactly the
   * successor of the current active version (or `1` for a new key), and must reject staging when a
   * different staged version is already pending for the document ("at most one staged version"). A
   * persistent implementation writes the version and chunk rows in a single transaction under a
   * per-document lock.
   */
  stageVersion(input: NewVersionInput): Promise<void>;

  /**
   * **Persist** embeddings for already-staged chunks (design §4-B). Append-only and idempotent: a row
   * that already exists for a `(chunk, full embedding profile)` is left untouched, so a
   * retry after a partial embedding run safely fills in only the missing rows. Every embedding must
   * reference an existing chunk and its `embedding.length` must equal `embeddingDim`.
   */
  saveChunkEmbeddings(embeddings: ChunkEmbeddingCore[]): Promise<void>;

  /**
   * **Activate** a staged version, making it the active version atomically (design §4-C). Under a
   * per-document lock this re-checks version contiguity and enforces the **embedding readiness gate**:
   * activation is refused unless every chunk of the target version carries an embedding for the given
   * active `model`. On success the active pointer is advanced (or created, for a new key); no prior
   * version, chunk, or embedding is ever mutated.
   */
  activateVersion(documentKey: string, version: number, model: EmbeddingModelRef): Promise<void>;
}

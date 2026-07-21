/**
 * Internal domain types for RAG FAQ extraction (roadmap Phase 10–11, offline ingestion only).
 *
 * These are pure, camelCase, and carry no HTML or Cheerio types. They describe the structured
 * result of extracting one approved FAQ page, preserving the semantic Question -> Answer pairing
 * required by `rag-design.md`. Nothing here touches embeddings, PostgreSQL, pgvector, or retrieval.
 */

/** One FAQ pair. Both fields are non-empty by construction of the extractor. */
export type FaqItem = {
  question: string;
  answer: string;
};

/**
 * The structured result of extracting one approved FAQ page.
 *
 * `pageTitle` is read from the page itself; `documentKey`, `category`, and `sourceUrl` are supplied
 * by the caller from the approved entry in `source-registry.md` — the extractor never invents them.
 */
export type ExtractedFaqPage = {
  documentKey: string;
  pageTitle: string;
  category: string;
  sourceUrl: string;
  faqItems: FaqItem[];
};

/**
 * Metadata the caller passes in from the approved source registry. Kept separate from the HTML so
 * extraction stays a pure function of `(html, metadata)` with no knowledge of the registry file.
 */
export type FaqSourceMetadata = {
  documentKey: string;
  category: string;
  sourceUrl: string;
};

/**
 * One logical retrieval chunk: exactly one FAQ question/answer pair, its position in the document,
 * and its identity within an immutable document version. Produced by `prepare-document.ts`.
 *
 * `question` and `answer` preserve the extractor's pairing; `content` is the canonical string that is
 * hashed (and, in a later phase, embedded). `contentHash` is the SHA-256 hex digest of `content`.
 * `pageTitle`, `category`, and `sourceUrl` are carried through unchanged so retrieval can cite them.
 */
export type PreparedChunk = {
  /** `{documentKey}:v{documentVersion}:chunk-{zero-padded 1-based index}`, e.g. `mein-konto:v1:chunk-001`. */
  chunkKey: string;
  /** 1-based position of the pair in `ExtractedFaqPage.faqItems`; stable for a given input. */
  chunkIndex: number;
  documentKey: string;
  documentVersion: number;
  question: string;
  answer: string;
  content: string;
  contentHash: string;
  pageTitle: string;
  category: string;
  sourceUrl: string;
};

/**
 * A whole approved page prepared for indexing: its canonical normalized content, the SHA-256 hash
 * used for change detection, and one chunk per FAQ pair in original order. Nothing here touches
 * embeddings, PostgreSQL, pgvector, or versioning storage — those are later phases.
 */
export type PreparedDocument = {
  documentKey: string;
  documentVersion: number;
  pageTitle: string;
  category: string;
  sourceUrl: string;
  /** Canonical normalized document content: every FAQ pair joined deterministically. */
  content: string;
  /** SHA-256 hex digest of `content`; equal iff the normalized content is byte-for-byte identical. */
  contentHash: string;
  chunks: PreparedChunk[];
};

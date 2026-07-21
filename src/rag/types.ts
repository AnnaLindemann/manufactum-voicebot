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

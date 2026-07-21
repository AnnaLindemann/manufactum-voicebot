import type { ChunkCore, DocumentVersionCore, RagDocumentStore } from "./document-store.js";
import { computeDocumentContentHash, prepareDocument } from "./prepare-document.js";
import type { ExtractedFaqPage } from "./types.js";

/**
 * Versioned ingestion flow for one extracted FAQ page (roadmap Phase 10–11, offline ingestion only).
 *
 * This is the orchestration layer between extraction and storage. It implements the change-detection
 * and versioning rules of `rag-design.md`/`D-005`, and it — not the caller and not the store — decides
 * the document version number:
 *
 * - a first ingest for a key creates active version 1 and its chunks;
 * - a re-ingest whose canonical content hash equals the active version's hash creates no new version
 *   and leaves the active version untouched;
 * - a re-ingest whose hash differs creates the next version, makes it (and its chunks) active, and
 *   leaves the previous version and its chunks stored but inactive.
 *
 * Versioned chunk keys are generated **only after** the version number is decided: `computeDocument
 * ContentHash` runs first for change detection, and `prepareDocument` (which stamps the version into
 * the chunk keys) runs only when a new version is warranted.
 *
 * Pure apart from the injected clock and the store it writes to: the input `page` and `metadata` are
 * read only and never mutated. Nothing here creates embeddings, retrieves, or crawls.
 */

/**
 * Traceability metadata the caller supplies from the approved source registry, covering the fields
 * that the extracted page itself does not carry. Per `rag-design.md` these values are never invented
 * by the pipeline; they come from the registry entry or are passed explicitly by the caller.
 */
export type IngestionMetadata = {
  documentType: string;
  language: string;
  crawlerVersion: string;
  extractorVersion: string;
};

/** How an ingest resolved. `unchanged` means the content hash matched the active version. */
export type IngestOutcome = "created" | "unchanged";

export type IngestResult = {
  outcome: IngestOutcome;
  documentKey: string;
  /** The active version after this ingest: the existing one on `unchanged`, the new one on `created`. */
  version: number;
  createdNewVersion: boolean;
};

export type IngestOptions = {
  /** Injectable clock returning an ISO-8601 timestamp; defaults to the system wall clock. */
  now?: () => string;
};

/** Guard that a required traceability field is a non-empty string, so no blank metadata is stored. */
function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`Ingestion metadata "${field}" must be a non-empty string.`);
  }
}

export function ingestFaqPage(
  store: RagDocumentStore,
  page: ExtractedFaqPage,
  metadata: IngestionMetadata,
  options: IngestOptions = {},
): IngestResult {
  requireNonEmpty(metadata.documentType, "documentType");
  requireNonEmpty(metadata.language, "language");
  requireNonEmpty(metadata.crawlerVersion, "crawlerVersion");
  requireNonEmpty(metadata.extractorVersion, "extractorVersion");

  const now = options.now ?? (() => new Date().toISOString());
  const documentKey = page.documentKey;

  // Change detection precedes any version decision, and is deliberately version-independent.
  const contentHash = computeDocumentContentHash(page);
  const existing = store.getDocument(documentKey);

  if (existing !== undefined && existing.contentHash === contentHash) {
    // Same content as the active version: no new version, active version unchanged.
    return {
      outcome: "unchanged",
      documentKey,
      version: existing.currentVersion,
      createdNewVersion: false,
    };
  }

  // Only now, with a change confirmed, is the next version number decided and stamped into chunk keys.
  const nextVersion = existing === undefined ? 1 : existing.currentVersion + 1;
  const prepared = prepareDocument(page, nextVersion);
  const createdAt = now();

  const versionCore: DocumentVersionCore = {
    documentKey,
    version: nextVersion,
    sourceUrl: page.sourceUrl,
    title: page.pageTitle,
    documentType: metadata.documentType,
    language: metadata.language,
    content: prepared.content,
    contentHash: prepared.contentHash,
    crawlerVersion: metadata.crawlerVersion,
    extractorVersion: metadata.extractorVersion,
    createdAt,
  };

  const chunkCores: ChunkCore[] = prepared.chunks.map((chunk) => ({
    documentKey,
    documentVersion: nextVersion,
    chunkIndex: chunk.chunkIndex,
    chunkKey: chunk.chunkKey,
    question: chunk.question,
    answer: chunk.answer,
    content: chunk.content,
    contentHash: chunk.contentHash,
    sourceUrl: page.sourceUrl,
    title: page.pageTitle,
    documentType: metadata.documentType,
    language: metadata.language,
    crawlerVersion: metadata.crawlerVersion,
    extractorVersion: metadata.extractorVersion,
    createdAt,
  }));

  store.appendVersion({ version: versionCore, chunks: chunkCores });

  return {
    outcome: "created",
    documentKey,
    version: nextVersion,
    createdNewVersion: true,
  };
}

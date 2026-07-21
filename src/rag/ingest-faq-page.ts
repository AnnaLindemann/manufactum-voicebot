import type { ChunkCore, DocumentVersionCore, RagDocumentStore } from "./document-store.js";
import { RagStorageError } from "./in-memory-document-store.js";
import { computeDocumentContentHash, prepareDocument } from "./prepare-document.js";
import type { ExtractedFaqPage } from "./types.js";

/**
 * Versioned ingestion flow for one extracted FAQ page (roadmap Phase 10–11, offline ingestion only).
 *
 * This is the orchestration layer between extraction and storage. It implements the change-detection
 * and versioning rules of `rag-design.md`/`D-005`, and it — not the caller and not the store — decides
 * the document version number.
 *
 * Since `rag-embeddings-and-retrieval-design.md` §4 split the lifecycle, ingestion performs only the
 * **staging** step: it stores a new version and its chunks but does **not** activate it. Activation
 * happens later, after every chunk has been embedded (the embedding and activation steps live outside
 * this flow). So:
 *
 * - a first ingest for a key stages version 1 and its chunks; the document has no active version yet
 *   and stays invisible to retrieval until activated;
 * - a re-ingest whose canonical content hash equals the active version's hash stages nothing and
 *   leaves the active version untouched (`unchanged`);
 * - a re-ingest whose hash equals the already-staged version's hash is a no-op (`unchanged`): the same
 *   content is already staged and waiting for embeddings/activation;
 * - a re-ingest whose hash differs from the active version stages the next version, leaving the
 *   previous version and its chunks stored and still active.
 *
 * Because at most one version may be staged per document, a re-ingest carrying content that differs
 * from a *pending* staged version is refused (the staged version must be activated first).
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

/**
 * How an ingest resolved. `staged` means a new version was staged (awaiting embeddings/activation);
 * `unchanged` means the content matched the active version, or was already staged, so nothing changed.
 */
export type IngestOutcome = "staged" | "unchanged";

export type IngestResult = {
  outcome: IngestOutcome;
  documentKey: string;
  /**
   * The relevant version number: the newly staged version on `staged`; on `unchanged`, the active
   * version (content matched active) or the already-staged version (content matched the staged one).
   */
  version: number;
  stagedNewVersion: boolean;
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

export async function ingestFaqPage(
  store: RagDocumentStore,
  page: ExtractedFaqPage,
  metadata: IngestionMetadata,
  options: IngestOptions = {},
): Promise<IngestResult> {
  requireNonEmpty(metadata.documentType, "documentType");
  requireNonEmpty(metadata.language, "language");
  requireNonEmpty(metadata.crawlerVersion, "crawlerVersion");
  requireNonEmpty(metadata.extractorVersion, "extractorVersion");

  const now = options.now ?? (() => new Date().toISOString());
  const documentKey = page.documentKey;

  // Change detection precedes any version decision, and is deliberately version-independent.
  const contentHash = computeDocumentContentHash(page);
  const existing = await store.getDocument(documentKey);

  if (existing !== undefined && existing.contentHash === contentHash) {
    // Same content as the active version: no new version, active version unchanged.
    return {
      outcome: "unchanged",
      documentKey,
      version: existing.currentVersion,
      stagedNewVersion: false,
    };
  }

  // A version may already be staged (awaiting embeddings/activation). Because at most one may be
  // pending, decide what to do about it before staging anything new.
  const staged = await store.getStagedVersion(documentKey);
  if (staged !== undefined) {
    if (staged.contentHash === contentHash) {
      // The identical content is already staged and waiting; re-staging would be a no-op.
      return {
        outcome: "unchanged",
        documentKey,
        version: staged.version,
        stagedNewVersion: false,
      };
    }
    // Different content cannot be staged while another staged version is pending activation.
    throw new RagStorageError(
      `Document "${documentKey}" already has a pending staged version ${String(staged.version)}; activate it before staging different content.`,
    );
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

  await store.stageVersion({ version: versionCore, chunks: chunkCores });

  return {
    outcome: "staged",
    documentKey,
    version: nextVersion,
    stagedNewVersion: true,
  };
}

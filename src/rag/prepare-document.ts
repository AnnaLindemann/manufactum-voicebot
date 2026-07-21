import { createHash } from "node:crypto";
import type { ExtractedFaqPage, FaqItem, PreparedChunk, PreparedDocument } from "./types.js";

/**
 * Deterministic document preparation and FAQ chunking (roadmap Phase 10–11, offline ingestion only).
 *
 * Turns one `ExtractedFaqPage` into a `PreparedDocument`: a canonical normalized content string, its
 * SHA-256 hash for change detection, and one immutable chunk per question/answer pair. Pure and
 * total: no I/O, no clock, no randomness, and the input page and its `faqItems` are never mutated —
 * every result object is freshly built. The same input therefore always yields the same output,
 * including identical hashes and chunk keys.
 *
 * Nothing here creates embeddings, touches PostgreSQL/pgvector, compares versions, or crawls. The
 * document version is supplied by the caller (change detection lives in a later phase); this function
 * only stamps it into the chunk keys.
 */

/** Zero-padding width for the chunk-index segment of a chunk key, matching `chunk-003` in rag-design.md. */
const CHUNK_INDEX_PAD_WIDTH = 3;

/** Label prefixes for the canonical chunk content, kept in the source language (German). */
const QUESTION_LABEL = "Frage:";
const ANSWER_LABEL = "Antwort:";

/** Separator between FAQ pairs in the canonical document content. Blank line keeps pairs distinct. */
const DOCUMENT_CONTENT_SEPARATOR = "\n\n";

/** SHA-256 hex digest of a UTF-8 string, via `node:crypto`. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonical content of a single FAQ pair:
 *
 *     Frage: <question>
 *     <blank line>
 *     Antwort: <answer>
 *
 * The question and answer are separated by exactly one blank line. The answer may itself contain
 * newlines (paragraphs and bullet lines from the extractor); those are preserved. This is the exact
 * string that is hashed and, in a later phase, embedded.
 */
export function chunkContent(item: FaqItem): string {
  return `${QUESTION_LABEL} ${item.question}\n\n${ANSWER_LABEL} ${item.answer}`;
}

/**
 * `{documentKey}:v{documentVersion}:chunk-{zero-padded 1-based index}`, e.g. `mein-konto:v1:chunk-001`.
 *
 * `documentVersion` and `chunkIndex` are both 1-based and must be integers ≥ 1; `chunk-000` never
 * occurs.
 */
export function chunkKey(documentKey: string, documentVersion: number, chunkIndex: number): string {
  if (!Number.isInteger(documentVersion) || documentVersion < 1) {
    throw new RangeError(
      `documentVersion must be a positive integer, received ${String(documentVersion)}.`,
    );
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 1) {
    throw new RangeError(`chunkIndex must be a positive integer, received ${String(chunkIndex)}.`);
  }
  const paddedIndex = String(chunkIndex).padStart(CHUNK_INDEX_PAD_WIDTH, "0");
  return `${documentKey}:v${documentVersion}:chunk-${paddedIndex}`;
}

export function prepareDocument(page: ExtractedFaqPage, documentVersion: number): PreparedDocument {
  if (!Number.isInteger(documentVersion) || documentVersion < 1) {
    throw new RangeError(
      `documentVersion must be a positive integer, received ${String(documentVersion)}.`,
    );
  }

  const chunks: PreparedChunk[] = page.faqItems.map((item, position) => {
    // Chunk indices are 1-based, so the first pair is `chunk-001`; `chunk-000` never occurs.
    const chunkIndex = position + 1;
    const content = chunkContent(item);
    return {
      chunkKey: chunkKey(page.documentKey, documentVersion, chunkIndex),
      chunkIndex,
      documentKey: page.documentKey,
      documentVersion,
      question: item.question,
      answer: item.answer,
      content,
      contentHash: sha256Hex(content),
      pageTitle: page.pageTitle,
      category: page.category,
      sourceUrl: page.sourceUrl,
    };
  });

  // The document content is the concatenation of the chunk contents in original order, so the
  // document hash changes iff any pair's text, or their order, changes.
  const content = chunks.map((chunk) => chunk.content).join(DOCUMENT_CONTENT_SEPARATOR);

  return {
    documentKey: page.documentKey,
    documentVersion,
    pageTitle: page.pageTitle,
    category: page.category,
    sourceUrl: page.sourceUrl,
    content,
    contentHash: sha256Hex(content),
    chunks,
  };
}

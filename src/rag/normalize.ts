/**
 * Pure text normalization for extracted FAQ content.
 *
 * Total and pure: no I/O, no clock, no throwing. Whitespace runs (including the newlines and
 * indentation of the source HTML) collapse to single spaces within a block, but German characters
 * and typographic quotation marks are never transliterated or stripped.
 */

/** Collapse internal whitespace to single spaces and trim. German characters are left unchanged. */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Join answer blocks (paragraphs and list items) with a single newline, preserving their order and
 * keeping unrelated blocks separate. Empty blocks are dropped so a stray whitespace-only node never
 * becomes a blank paragraph.
 */
export function joinAnswerBlocks(blocks: string[]): string {
  return blocks
    .map(normalizeText)
    .filter((block) => block.length > 0)
    .join("\n");
}

import * as cheerio from "cheerio";
import { FaqExtractionError } from "./errors.js";
import { joinAnswerBlocks, normalizeText } from "./normalize.js";
import type { ExtractedFaqPage, FaqItem, FaqSourceMetadata } from "./types.js";

/**
 * Deterministic extraction of FAQ question/answer pairs from one approved, server-rendered
 * Manufactum FAQ page (roadmap Phase 10–11, offline ingestion only).
 *
 * Pure and total apart from a controlled `FaqExtractionError` on unsupported markup: it performs no
 * I/O and does not read the clock. Downloading is a separate concern (`fetch-page.ts`), so this
 * function is a pure function of `(html, source)` and its tests need no network.
 *
 * Selection relies only on stable `data-test-*` hooks and ARIA relationships verified in the PoC.
 * The obfuscated `mf-*` CSS classes are never used as selectors — they are build artefacts and can
 * change without notice. Extraction is scoped to the accordion items, so the global header, footer,
 * left navigation, cookie UI, chat widget, and marketing sections are excluded by construction.
 */

const PAGE_TITLE_SELECTOR = "h1[data-test-stelar-headline]";
const ACCORDION_ITEM_SELECTOR = "[data-test-sell-element-accordion-element]";
const QUESTION_SELECTOR = "[data-test-sell-accordion-item-heading]";
/** The answer panel; its `id` pairs with the item button's `aria-controls`. */
const ANSWER_REGION_SELECTOR = 'div[role="region"]';
/** Block-level content inside an answer, taken in document order. */
const ANSWER_BLOCK_SELECTOR = "p, li";

export function extractFaqPage(html: string, source: FaqSourceMetadata): ExtractedFaqPage {
  const $ = cheerio.load(html);

  const pageTitle = normalizeText($(PAGE_TITLE_SELECTOR).first().text());
  if (pageTitle.length === 0) {
    throw new FaqExtractionError(`Page title not found via \`${PAGE_TITLE_SELECTOR}\`.`);
  }

  const itemElements = $(ACCORDION_ITEM_SELECTOR).toArray();
  if (itemElements.length === 0) {
    throw new FaqExtractionError(
      `No FAQ accordion items found via \`${ACCORDION_ITEM_SELECTOR}\`.`,
    );
  }

  const faqItems: FaqItem[] = [];
  const seenQuestions = new Set<string>();

  for (const element of itemElements) {
    const $item = $(element);

    const question = normalizeText($item.find(QUESTION_SELECTOR).first().text());
    // A malformed item without a question degrades to a skip, not a whole-page failure: one broken
    // accordion entry must not lose every other answer on the page.
    if (question.length === 0) {
      continue;
    }

    const $region = $item.find(ANSWER_REGION_SELECTOR).first();
    if ($region.length === 0) {
      continue;
    }

    const blocks: string[] = [];
    for (const block of $region.find(ANSWER_BLOCK_SELECTOR).toArray()) {
      const $block = $(block);

      // A `<p>` nested inside an `<li>` is already captured by that `<li>`; skip it so the same text
      // is not emitted twice.
      if (block.tagName === "p" && $block.closest("li").length > 0) {
        continue;
      }

      const text = normalizeText($block.text());
      if (text.length === 0) {
        continue;
      }

      // List items are prefixed so the six bullets of a list survive as distinct lines for later
      // chunking; link text is preserved because `.text()` keeps the anchor's inner text.
      blocks.push(block.tagName === "li" ? `• ${text}` : text);
    }

    const answer = joinAnswerBlocks(blocks);
    if (answer.length === 0) {
      continue;
    }

    // Duplicate FAQ items (same question) collapse to their first occurrence, so a page that renders
    // an accordion twice does not double every pair.
    if (seenQuestions.has(question)) {
      continue;
    }
    seenQuestions.add(question);

    faqItems.push({ question, answer });
  }

  if (faqItems.length === 0) {
    throw new FaqExtractionError(
      "No extractable FAQ items: every accordion item lacked a question or an answer.",
    );
  }

  return {
    documentKey: source.documentKey,
    pageTitle,
    category: source.category,
    sourceUrl: source.sourceUrl,
    faqItems,
  };
}

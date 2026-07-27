import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractFaqPage } from "../../src/rag/extract-faq.js";
import { joinAnswerBlocks, normalizeText } from "../../src/rag/normalize.js";
import { prepareDocument } from "../../src/rag/prepare-document.js";

type SourceSpanSelector = {
  selectorType: string;
  contentSelector: string;
  accordionItemSelector: string;
  questionSelector: string;
  answerSelector: string;
  ariaControls: string;
};

type InventoryIntent = {
  faqCategory: string;
  faqIntentId: string;
  evidenceId: string;
  documentKey: string;
  documentVersion: number;
  sourceUrl: string;
  sourceSpanSelector: SourceSpanSelector;
  normalizedSemanticEvidence: {
    question: string;
    answer: string;
  };
  supportingSourceSpanHash: string;
  semanticEvidenceHash: string;
  semanticEvidenceHashInputCanonicalization: string;
  intentEvidenceRelationship: {
    relationship: string;
    expectedEvidenceId: string;
    acceptableEvidenceIds: string[];
    rationale: string;
  };
  sourceProvenance: {
    sourceRegistryEntry: string;
    sourceFixture: string;
    sourceDocumentContentHash: string;
    pageTitle: string;
    documentType: string;
    language: string;
    extractorSelectors: Record<string, string>;
    extractorVersionObservedReadOnly: string;
    crawlerVersionObservedReadOnly: string;
  };
};

type Inventory = {
  schemaVersion: string;
  reviewStatus: string;
  independentReviewStatus: string;
  freezeStatus: string;
  scope: {
    faqCategory: string;
    documentKey: string;
    documentVersion: number;
    documentType: string;
    language: string;
    sourceUrl: string;
    sourceFixture: string;
    sourceRegistry: string;
    sourceDocumentContentHash: string;
    approvedFaqItemCount: number;
    activeChunkCountObservedReadOnly: number;
  };
  namingConvention: Record<string, string>;
  hashing: {
    hashAlgorithm: string;
    encoding: string;
    canonicalization: string;
    supportingSourceSpanHashType: string;
    supportingSourceSpanHashInput: string;
    semanticEvidenceRecordHashType: string;
    semanticEvidenceHashInput: string;
    hashType: string;
    hashTypeNote: string;
    hashDistinctions: Record<string, string>;
  };
  relationshipPolicy: Record<string, string>;
  intents: InventoryIntent[];
  draftFindings: Record<string, unknown>;
};

const CANDIDATE_SPECIFIC_FIELDS = new Set([
  "expectedChunkKey",
  "chunkKey",
  "chunkIndex",
  "chunkHash",
  "candidateChunkKey",
  "candidateChunkHash",
  "retrievalCandidate",
]);

const TOP_LEVEL_KEYS = [
  "draftFindings",
  "freezeStatus",
  "hashing",
  "independentReviewStatus",
  "intents",
  "namingConvention",
  "relationshipPolicy",
  "reviewStatus",
  "schemaVersion",
  "scope",
];
const SCOPE_KEYS = [
  "activeChunkCountObservedReadOnly",
  "approvedFaqItemCount",
  "documentKey",
  "documentType",
  "documentVersion",
  "faqCategory",
  "language",
  "sourceDocumentContentHash",
  "sourceFixture",
  "sourceRegistry",
  "sourceUrl",
];
const NAMING_CONVENTION_KEYS = [
  "documentKey",
  "documentVersion",
  "evidenceId",
  "faqIntentId",
  "sourceSpanSelector",
];
const HASHING_KEYS = [
  "canonicalization",
  "encoding",
  "hashAlgorithm",
  "hashDistinctions",
  "hashType",
  "hashTypeNote",
  "semanticEvidenceHashInput",
  "semanticEvidenceRecordHashType",
  "supportingSourceSpanHashInput",
  "supportingSourceSpanHashType",
];
const HASH_DISTINCTION_KEYS = [
  "candidateChunkContentHash",
  "semanticEvidenceHash",
  "supportingSourceSpanHash",
];
const RELATIONSHIP_POLICY_KEYS = ["acceptableEvidenceRule", "defaultRelationship"];
const INTENT_KEYS = [
  "documentKey",
  "documentVersion",
  "evidenceId",
  "faqCategory",
  "faqIntentId",
  "intentEvidenceRelationship",
  "normalizedSemanticEvidence",
  "semanticEvidenceHash",
  "semanticEvidenceHashInputCanonicalization",
  "sourceProvenance",
  "sourceSpanSelector",
  "sourceUrl",
  "supportingSourceSpanHash",
];
const SELECTOR_KEYS = [
  "accordionItemSelector",
  "answerSelector",
  "ariaControls",
  "contentSelector",
  "questionSelector",
  "selectorType",
];
const NORMALIZED_EVIDENCE_KEYS = ["answer", "question"];
const INTENT_RELATIONSHIP_KEYS = [
  "acceptableEvidenceIds",
  "expectedEvidenceId",
  "rationale",
  "relationship",
];
const SOURCE_PROVENANCE_KEYS = [
  "crawlerVersionObservedReadOnly",
  "documentType",
  "extractorSelectors",
  "extractorVersionObservedReadOnly",
  "language",
  "pageTitle",
  "sourceDocumentContentHash",
  "sourceFixture",
  "sourceRegistryEntry",
];
const EXTRACTOR_SELECTOR_KEYS = ["answer", "content", "pageTitle", "question"];
const DRAFT_FINDINGS_KEYS = [
  "ambiguousIntentNotes",
  "duplicateCanonicalQuestions",
  "duplicateEvidenceIds",
  "duplicateIntentIds",
  "duplicateNormalizedSemanticEvidenceHashes",
  "missingEvidence",
  "overlappingIntentNotes",
];

const INVENTORY_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-semantic-evidence-inventory.draft.json",
);
const SOURCE_FIXTURE_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "konto-c201130.html",
);

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function canonicalQuestionSlug(question: string): string {
  return question
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function expectExactKeys(value: unknown, keys: readonly string[]): void {
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...keys].sort());
}

function expectNoCandidateSpecificFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectNoCandidateSpecificFields(item);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    expect(CANDIDATE_SPECIFIC_FIELDS.has(key)).toBe(false);
    expectNoCandidateSpecificFields(nested);
  }
}

function extractAnswerFromAccordionItem(
  $: cheerio.CheerioAPI,
  item: ReturnType<cheerio.CheerioAPI>,
  answerSelector: string,
): string {
  const region = item.find(answerSelector);
  expect(region).toHaveLength(1);

  const blocks: string[] = [];
  for (const block of region.find("p, li").toArray()) {
    const blockElement = $(block);
    if (block.tagName === "p" && blockElement.closest("li").length > 0) {
      continue;
    }

    const text = normalizeText(blockElement.text());
    if (text.length === 0) {
      continue;
    }

    blocks.push(block.tagName === "li" ? `• ${text}` : text);
  }

  return joinAnswerBlocks(blocks);
}

function sourceSpanHashInput(question: string, answer: string): unknown {
  return {
    normalizedSourceSpan: {
      answer,
      question,
    },
  };
}

async function loadInventory(): Promise<Inventory> {
  return JSON.parse(await readFile(INVENTORY_PATH, "utf8")) as Inventory;
}

describe("mein-konto v1 draft semantic evidence inventory", () => {
  it("covers every approved FAQ intent once with deterministic source evidence", async () => {
    const inventory = await loadInventory();
    const html = await readFile(SOURCE_FIXTURE_PATH, "utf8");
    const extracted = extractFaqPage(html, {
      documentKey: "mein-konto",
      category: "account-faq",
      sourceUrl: "https://www.manufactum.de/konto-c201130/",
    });
    const prepared = prepareDocument(extracted, 1);

    expect(inventory.schemaVersion).toBe("rag-semantic-evidence-inventory-draft-v1");
    expect(inventory.reviewStatus).toBe("draft");
    expect(inventory.independentReviewStatus).toBe("not_reviewed");
    expect(inventory.freezeStatus).toBe("not_frozen");
    expect(inventory.scope).toMatchObject({
      faqCategory: "account-faq",
      documentKey: "mein-konto",
      documentVersion: 1,
      documentType: "account-faq",
      language: "de",
      sourceUrl: "https://www.manufactum.de/konto-c201130/",
      sourceFixture: "tests/fixtures/rag/konto-c201130.html",
      approvedFaqItemCount: 12,
    });
    expectExactKeys(inventory, TOP_LEVEL_KEYS);
    expectExactKeys(inventory.scope, SCOPE_KEYS);
    expectExactKeys(inventory.namingConvention, NAMING_CONVENTION_KEYS);
    expectExactKeys(inventory.hashing, HASHING_KEYS);
    expectExactKeys(inventory.hashing.hashDistinctions, HASH_DISTINCTION_KEYS);
    expectExactKeys(inventory.relationshipPolicy, RELATIONSHIP_POLICY_KEYS);
    expectExactKeys(inventory.draftFindings, DRAFT_FINDINGS_KEYS);
    expectNoCandidateSpecificFields(inventory);
    expect(inventory.hashing).toMatchObject({
      hashAlgorithm: "SHA-256",
      encoding: "UTF-8",
      supportingSourceSpanHashType: "supporting-source-span:v1",
      semanticEvidenceRecordHashType: "semantic-evidence-source-span:v1",
      hashType: "semantic-evidence-source-span:v1",
    });
    expect(inventory.scope.sourceDocumentContentHash).toBe(prepared.contentHash);
    expect(inventory.intents).toHaveLength(extracted.faqItems.length);
    expect(inventory.intents).toHaveLength(inventory.scope.approvedFaqItemCount);

    const intentIds = new Set<string>();
    const evidenceIds = new Set<string>();
    const evidenceHashes = new Set<string>();

    for (const [index, intent] of inventory.intents.entries()) {
      const sourceItem = extracted.faqItems[index]!;

      const expectedIntentId = `account-faq:${canonicalQuestionSlug(sourceItem.question)}`;
      const expectedEvidenceId = `${expectedIntentId}:evidence:primary`;

      expectExactKeys(intent, INTENT_KEYS);
      expectExactKeys(intent.sourceSpanSelector, SELECTOR_KEYS);
      expectExactKeys(intent.normalizedSemanticEvidence, NORMALIZED_EVIDENCE_KEYS);
      expectExactKeys(intent.intentEvidenceRelationship, INTENT_RELATIONSHIP_KEYS);
      expectExactKeys(intent.sourceProvenance, SOURCE_PROVENANCE_KEYS);
      expectExactKeys(intent.sourceProvenance.extractorSelectors, EXTRACTOR_SELECTOR_KEYS);
      expect(intent.faqCategory).toBe(inventory.scope.faqCategory);
      expect(intent.faqIntentId).toBe(expectedIntentId);
      expect(intent.evidenceId).toBe(expectedEvidenceId);
      expect(intent.documentKey).toBe(inventory.scope.documentKey);
      expect(intent.documentVersion).toBe(inventory.scope.documentVersion);
      expect(intent.sourceUrl).toBe(inventory.scope.sourceUrl);
      expect(intent.normalizedSemanticEvidence).toEqual(sourceItem);
      expect(intent.supportingSourceSpanHash).toBe(
        sha256Hex(canonicalJson(sourceSpanHashInput(sourceItem.question, sourceItem.answer))),
      );
      expect(intent.semanticEvidenceHashInputCanonicalization).toBe(
        "canonical-json-sorted-keys:utf8",
      );
      expect(intent.intentEvidenceRelationship.relationship).toBe(
        "expected_and_only_acceptable_evidence",
      );
      expect(intent.intentEvidenceRelationship.expectedEvidenceId).toBe(expectedEvidenceId);
      expect(intent.intentEvidenceRelationship.acceptableEvidenceIds).toEqual([expectedEvidenceId]);
      expect(intent.intentEvidenceRelationship.acceptableEvidenceIds).toContain(
        intent.intentEvidenceRelationship.expectedEvidenceId,
      );
      expect(intent.sourceProvenance).toMatchObject({
        sourceRegistryEntry: "docs/source-registry.md#mein-konto--account-faq",
        sourceFixture: "tests/fixtures/rag/konto-c201130.html",
        sourceDocumentContentHash: prepared.contentHash,
        pageTitle: "Mein Konto",
        documentType: "account-faq",
        language: "de",
      });

      const hashInput = {
        hashType: inventory.hashing.semanticEvidenceRecordHashType,
        faqCategory: intent.faqCategory,
        faqIntentId: intent.faqIntentId,
        evidenceId: intent.evidenceId,
        documentKey: intent.documentKey,
        documentVersion: intent.documentVersion,
        sourceUrl: intent.sourceUrl,
        sourceSpanSelector: intent.sourceSpanSelector,
        normalizedSemanticEvidence: intent.normalizedSemanticEvidence,
      };
      expect(intent.semanticEvidenceHash).toBe(sha256Hex(canonicalJson(hashInput)));
      // Secondary sanity checks only. Candidate independence is established by strict absence of
      // candidate-specific fields, selectors independent of chunk boundaries, and the source-derived
      // supportingSourceSpanHash above.
      expect(intent.semanticEvidenceHash).not.toBe(prepared.chunks[index]?.contentHash);
      expect(intent.supportingSourceSpanHash).not.toBe(prepared.chunks[index]?.contentHash);

      expect(intentIds.has(intent.faqIntentId)).toBe(false);
      expect(evidenceIds.has(intent.evidenceId)).toBe(false);
      expect(evidenceHashes.has(intent.semanticEvidenceHash)).toBe(false);
      intentIds.add(intent.faqIntentId);
      evidenceIds.add(intent.evidenceId);
      evidenceHashes.add(intent.semanticEvidenceHash);
    }

    const evidenceById = new Map(inventory.intents.map((intent) => [intent.evidenceId, intent]));
    for (const intent of inventory.intents) {
      const relationship = intent.intentEvidenceRelationship;
      expect(evidenceById.has(relationship.expectedEvidenceId)).toBe(true);
      for (const acceptableEvidenceId of relationship.acceptableEvidenceIds) {
        const acceptable = evidenceById.get(acceptableEvidenceId);
        expect(acceptable).toBeDefined();
        expect(acceptable?.faqIntentId).toBe(intent.faqIntentId);
        expect(acceptable?.documentKey).toBe(intent.documentKey);
        expect(acceptable?.documentVersion).toBe(intent.documentVersion);
      }
    }
  });

  it("resolves every source span selector against the immutable fixture", async () => {
    const inventory = await loadInventory();
    const html = await readFile(SOURCE_FIXTURE_PATH, "utf8");
    const $ = cheerio.load(html);

    for (const intent of inventory.intents) {
      const selector = intent.sourceSpanSelector;
      expect(selector.selectorType).toBe("manufactum-faq-accordion-aria-v1");
      expect(selector.contentSelector).toBe("[data-test-sell-element-accordion-element]");

      const item = $(selector.accordionItemSelector);
      expect(item).toHaveLength(1);
      expect(item.attr("data-test-sell-element-accordion-element")).toBe(selector.ariaControls);

      const button = item.find("button[aria-controls]");
      expect(button).toHaveLength(1);
      const answerRegion = item.find(selector.answerSelector);
      expect(answerRegion).toHaveLength(1);
      expect(button.first().attr("aria-controls")).toBe(selector.ariaControls);
      expect(answerRegion.first().attr("id")).toBe(selector.ariaControls);
      expect(answerRegion.first().attr("aria-labelledby")).toBe(button.first().attr("id"));

      const heading = item.find(selector.questionSelector);
      expect(heading).toHaveLength(1);
      const normalizedQuestion = normalizeText(heading.first().text());
      const normalizedAnswer = extractAnswerFromAccordionItem($, item, selector.answerSelector);
      expect(normalizedQuestion).toBe(intent.normalizedSemanticEvidence.question);
      expect(normalizedAnswer).toBe(intent.normalizedSemanticEvidence.answer);
      expect(intent.supportingSourceSpanHash).toBe(
        sha256Hex(canonicalJson(sourceSpanHashInput(normalizedQuestion, normalizedAnswer))),
      );
    }
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chunkContent,
  chunkKey,
  prepareDocument,
  sha256Hex,
} from "../../src/rag/prepare-document.js";
import type { ExtractedFaqPage } from "../../src/rag/types.js";

/** A small, fully deterministic page. German characters are included on purpose. */
function samplePage(): ExtractedFaqPage {
  return {
    documentKey: "mein-konto",
    pageTitle: "Mein Konto",
    category: "Mein Konto",
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    faqItems: [
      { question: "Wie kann ich mich registrieren?", answer: "Über den Login-Bereich." },
      {
        question: "Welche Vorteile bietet mir ein Konto?",
        answer: "Mit einem Konto genießen Sie:\n• Newsletter\n• Bestellhistorie",
      },
    ],
  };
}

/** A page with twelve FAQ pairs, mirroring the real approved source, for chunk-key range checks. */
function twelveItemPage(): ExtractedFaqPage {
  return {
    documentKey: "mein-konto",
    pageTitle: "Mein Konto",
    category: "Mein Konto",
    sourceUrl: "https://www.manufactum.de/konto-c201130/",
    faqItems: Array.from({ length: 12 }, (_, i) => ({
      question: `Frage ${i + 1}?`,
      answer: `Antwort ${i + 1}.`,
    })),
  };
}

describe("sha256Hex", () => {
  it("computes the SHA-256 hex digest of a UTF-8 string", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and distinguishes different inputs", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("chunkContent", () => {
  it("formats 'Frage: <q>', one blank line, then 'Antwort: <a>'", () => {
    expect(chunkContent({ question: "Wie geht das?", answer: "So geht das." })).toBe(
      "Frage: Wie geht das?\n\nAntwort: So geht das.",
    );
  });

  it("preserves paragraphs and bullet lines inside the answer", () => {
    expect(
      chunkContent({ question: "Vorteile?", answer: "Sie genießen:\n• Newsletter\n• Historie" }),
    ).toBe("Frage: Vorteile?\n\nAntwort: Sie genießen:\n• Newsletter\n• Historie");
  });
});

describe("chunkKey", () => {
  it("formats {documentKey}:v{version}:chunk-{zero-padded 1-based index}", () => {
    expect(chunkKey("returns-policy", 4, 3)).toBe("returns-policy:v4:chunk-003");
  });

  it("zero-pads the index to three digits and does not truncate larger indices", () => {
    expect(chunkKey("k", 1, 1)).toBe("k:v1:chunk-001");
    expect(chunkKey("k", 1, 12)).toBe("k:v1:chunk-012");
    expect(chunkKey("k", 1, 1234)).toBe("k:v1:chunk-1234");
  });

  it("rejects a non-positive or non-integer version or index", () => {
    expect(() => chunkKey("k", 0, 1)).toThrow(RangeError);
    expect(() => chunkKey("k", 1.5, 1)).toThrow(RangeError);
    expect(() => chunkKey("k", 1, 0)).toThrow(RangeError);
    expect(() => chunkKey("k", 1, -1)).toThrow(RangeError);
    expect(() => chunkKey("k", 1, 2.5)).toThrow(RangeError);
  });
});

describe("prepareDocument", () => {
  it("carries document metadata through unchanged", () => {
    const result = prepareDocument(samplePage(), 1);
    expect(result.documentKey).toBe("mein-konto");
    expect(result.documentVersion).toBe(1);
    expect(result.pageTitle).toBe("Mein Konto");
    expect(result.category).toBe("Mein Konto");
    expect(result.sourceUrl).toBe("https://www.manufactum.de/konto-c201130/");
  });

  it("produces exactly one chunk per FAQ pair, in original order with 1-based indices", () => {
    const result = prepareDocument(samplePage(), 1);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((chunk) => chunk.chunkIndex)).toEqual([1, 2]);
    expect(result.chunks[0]?.question).toBe("Wie kann ich mich registrieren?");
    expect(result.chunks[1]?.question).toBe("Welche Vorteile bietet mir ein Konto?");
  });

  it("gives the first pair the exact canonical content, with 'Frage:', 'Antwort:' and one blank line", () => {
    const result = prepareDocument(samplePage(), 1);
    expect(result.chunks[0]?.content).toBe(
      "Frage: Wie kann ich mich registrieren?\n\nAntwort: Über den Login-Bereich.",
    );
    expect(result.chunks[1]?.content).toBe(
      "Frage: Welche Vorteile bietet mir ein Konto?\n\nAntwort: Mit einem Konto genießen Sie:\n• Newsletter\n• Bestellhistorie",
    );
  });

  it("preserves the question/answer relationship on each chunk", () => {
    const result = prepareDocument(samplePage(), 1);
    expect(result.chunks[0]?.answer).toBe("Über den Login-Bereich.");
    expect(result.chunks[1]?.answer).toBe(
      "Mit einem Konto genießen Sie:\n• Newsletter\n• Bestellhistorie",
    );
  });

  it("stamps the document version into deterministic 1-based chunk keys", () => {
    const result = prepareDocument(samplePage(), 7);
    expect(result.chunks[0]?.chunkKey).toBe("mein-konto:v7:chunk-001");
    expect(result.chunks[1]?.chunkKey).toBe("mein-konto:v7:chunk-002");
    for (const chunk of result.chunks) {
      expect(chunk.documentVersion).toBe(7);
    }
  });

  it("numbers twelve pairs from chunk-001 to chunk-012 with no chunk-000", () => {
    const result = prepareDocument(twelveItemPage(), 1);
    expect(result.chunks).toHaveLength(12);
    expect(result.chunks[0]?.chunkKey).toBe("mein-konto:v1:chunk-001");
    expect(result.chunks.at(-1)?.chunkKey).toBe("mein-konto:v1:chunk-012");

    const keys = result.chunks.map((chunk) => chunk.chunkKey);
    expect(keys.some((key) => key.endsWith("chunk-000"))).toBe(false);
    expect(result.chunks.map((chunk) => chunk.chunkIndex)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("hashes each chunk's canonical content with SHA-256", () => {
    const result = prepareDocument(samplePage(), 1);
    for (const chunk of result.chunks) {
      const expected = createHash("sha256").update(chunk.content, "utf8").digest("hex");
      expect(chunk.contentHash).toBe(expected);
      expect(chunk.content).toBe(`Frage: ${chunk.question}\n\nAntwort: ${chunk.answer}`);
    }
  });

  it("carries source metadata onto every chunk", () => {
    const result = prepareDocument(samplePage(), 1);
    for (const chunk of result.chunks) {
      expect(chunk.documentKey).toBe("mein-konto");
      expect(chunk.pageTitle).toBe("Mein Konto");
      expect(chunk.category).toBe("Mein Konto");
      expect(chunk.sourceUrl).toBe("https://www.manufactum.de/konto-c201130/");
    }
  });

  it("builds canonical document content by joining chunk contents with a blank line", () => {
    const result = prepareDocument(samplePage(), 1);
    expect(result.content).toBe(result.chunks.map((chunk) => chunk.content).join("\n\n"));
    expect(result.contentHash).toBe(sha256Hex(result.content));
  });

  it("is fully deterministic: identical input yields identical hashes and keys", () => {
    const first = prepareDocument(samplePage(), 1);
    const second = prepareDocument(samplePage(), 1);
    expect(second).toEqual(first);
  });

  it("changes the chunk hash and the document hash when that pair's answer changes", () => {
    const base = prepareDocument(samplePage(), 1);

    const edited = samplePage();
    edited.faqItems[0]!.answer = "Über das Registrierungsformular.";
    const changed = prepareDocument(edited, 1);

    expect(changed.chunks[0]?.contentHash).not.toBe(base.chunks[0]?.contentHash);
    expect(changed.chunks[1]?.contentHash).toBe(base.chunks[1]?.contentHash);
    expect(changed.contentHash).not.toBe(base.contentHash);
  });

  it("changes the document hash when a pair's question changes", () => {
    const base = prepareDocument(samplePage(), 1);

    const edited = samplePage();
    edited.faqItems[0]!.question = "Wie registriere ich mich?";
    const changed = prepareDocument(edited, 1);

    expect(changed.contentHash).not.toBe(base.contentHash);
  });

  it("changes the document hash when the pair order changes, but not the version", () => {
    const base = prepareDocument(samplePage(), 1);

    const reordered = samplePage();
    reordered.faqItems.reverse();
    const changed = prepareDocument(reordered, 1);

    expect(changed.documentVersion).toBe(base.documentVersion);
    expect(changed.contentHash).not.toBe(base.contentHash);
  });

  it("does not mutate the input page or its faqItems", () => {
    const page = samplePage();
    const snapshot = structuredClone(page);
    prepareDocument(page, 3);
    expect(page).toEqual(snapshot);
  });

  it("rejects a non-positive or non-integer document version", () => {
    expect(() => prepareDocument(samplePage(), 0)).toThrow(RangeError);
    expect(() => prepareDocument(samplePage(), -1)).toThrow(RangeError);
    expect(() => prepareDocument(samplePage(), 1.5)).toThrow(RangeError);
  });
});

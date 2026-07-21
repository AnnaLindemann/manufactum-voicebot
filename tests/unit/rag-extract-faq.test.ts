import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FaqExtractionError } from "../../src/rag/errors.js";
import { extractFaqPage } from "../../src/rag/extract-faq.js";
import type { FaqSourceMetadata } from "../../src/rag/types.js";

const SOURCE: FaqSourceMetadata = {
  documentKey: "mein-konto",
  category: "Mein Konto",
  sourceUrl: "https://www.manufactum.de/konto-c201130/",
};

async function loadFixture(): Promise<string> {
  const fixturePath = path.join(import.meta.dirname, "..", "fixtures", "rag", "konto-c201130.html");
  return readFile(fixturePath, "utf8");
}

/** Minimal, hand-written pages for the failure and edge cases — network-free by construction. */
function accordionItem(question: string | null, answerHtml: string | null): string {
  const heading =
    question === null
      ? ""
      : `<h3><button aria-controls="option-x"><div data-test-sell-accordion-item-heading="true"><strong>${question}</strong></div></button></h3>`;
  const region = answerHtml === null ? "" : `<div role="region" id="option-x">${answerHtml}</div>`;
  return `<div data-test-sell-element-accordion-element="option-x">${heading}${region}</div>`;
}

function page(itemsHtml: string, options: { withTitle?: boolean } = {}): string {
  const title =
    options.withTitle === false ? "" : `<h1 data-test-stelar-headline="true">Mein Konto</h1>`;
  return `<html><body>${title}<main>${itemsHtml}</main></body></html>`;
}

describe("extractFaqPage — real fixture (konto-c201130.html)", () => {
  it("reads the page title from h1[data-test-stelar-headline]", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    expect(result.pageTitle).toBe("Mein Konto");
  });

  it("carries source metadata through unchanged", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    expect(result.documentKey).toBe("mein-konto");
    expect(result.category).toBe("Mein Konto");
    expect(result.sourceUrl).toBe("https://www.manufactum.de/konto-c201130/");
  });

  it("extracts exactly 12 FAQ items", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    expect(result.faqItems).toHaveLength(12);
  });

  it("gives every item a non-empty question and answer", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    for (const item of result.faqItems) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it("pairs the first question with the correct answer (collapsed, with link text preserved)", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    const first = result.faqItems[0];

    expect(first?.question).toBe("Wie kann ich mich bei Manufactum registrieren?");
    // The first item is visually collapsed (aria-hidden="true") yet its answer is in the raw HTML.
    // The `<a href="/login">Login-Bereich</a>` link text must survive.
    expect(first?.answer).toContain("Login-Bereich");
    expect(first?.answer).toContain("Registrierungsformular");
  });

  it("preserves all six list items in the 'Welche Vorteile' answer", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    const item = result.faqItems.find(
      (faq) => faq.question === "Welche Vorteile bietet mir ein Konto?",
    );

    expect(item).toBeDefined();
    const bulletLines = (item?.answer ?? "").split("\n").filter((line) => line.startsWith("• "));
    expect(bulletLines).toHaveLength(6);
    // Intro paragraph precedes the bullets; paragraph order is preserved.
    expect(item?.answer.startsWith("Mit einem Konto")).toBe(true);
    expect(item?.answer).toContain("• Sie können sich bequem zu unserem Newsletter");
  });

  it("keeps German characters and typographic quotation marks unchanged", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    const serialized = JSON.stringify(result.faqItems);
    expect(serialized).toContain("können");
    expect(serialized).toContain("genießen");
    expect(serialized).toContain("„Kundenkonto“");
  });

  it("excludes header, footer, navigation and marketing content", async () => {
    const result = extractFaqPage(await loadFixture(), SOURCE);
    const serialized = JSON.stringify(result.faqItems);

    // Both strings exist elsewhere in the fixture (footer/marketing and left navigation) but must
    // never leak into the scoped accordion extraction.
    expect(serialized).not.toContain("Über Manufactum");
    expect(serialized).not.toContain("Ersatzteile und Reparatur");
  });
});

describe("extractFaqPage — controlled failures", () => {
  it("throws FaqExtractionError when the page title is missing", () => {
    const html = page(accordionItem("Frage?", "<p>Antwort</p>"), { withTitle: false });
    expect(() => extractFaqPage(html, SOURCE)).toThrow(FaqExtractionError);
  });

  it("throws FaqExtractionError when no accordion container is present", () => {
    const html = page("<p>Kein Akkordeon hier.</p>");
    expect(() => extractFaqPage(html, SOURCE)).toThrow(FaqExtractionError);
  });

  it("throws FaqExtractionError when every item lacks a question or answer", () => {
    const html = page(accordionItem(null, "<p>Antwort ohne Frage</p>"));
    expect(() => extractFaqPage(html, SOURCE)).toThrow(FaqExtractionError);
  });
});

describe("extractFaqPage — per-item edge cases", () => {
  it("skips an item with a missing question but keeps valid items", () => {
    const html = page(
      accordionItem("Gültige Frage?", "<p>Gültige Antwort</p>") +
        accordionItem(null, "<p>Waise ohne Frage</p>"),
    );
    const result = extractFaqPage(html, SOURCE);

    expect(result.faqItems).toHaveLength(1);
    expect(result.faqItems[0]?.question).toBe("Gültige Frage?");
  });

  it("skips an item with a missing answer but keeps valid items", () => {
    const html = page(
      accordionItem("Gültige Frage?", "<p>Gültige Antwort</p>") +
        accordionItem("Frage ohne Antwort?", null),
    );
    const result = extractFaqPage(html, SOURCE);

    expect(result.faqItems).toHaveLength(1);
    expect(result.faqItems[0]?.question).toBe("Gültige Frage?");
  });

  it("deduplicates identical FAQ items to the first occurrence", () => {
    const html = page(
      accordionItem("Wiederholte Frage?", "<p>Antwort</p>") +
        accordionItem("Wiederholte Frage?", "<p>Antwort</p>"),
    );
    const result = extractFaqPage(html, SOURCE);

    expect(result.faqItems).toHaveLength(1);
  });

  it("preserves list items and does not merge unrelated paragraphs", () => {
    const html = page(
      accordionItem(
        "Wie funktioniert es?",
        "<p>Erster Absatz.</p><ul><li>Punkt eins</li><li>Punkt zwei</li></ul><p>Letzter Absatz.</p>",
      ),
    );
    const result = extractFaqPage(html, SOURCE);

    expect(result.faqItems[0]?.answer).toBe(
      "Erster Absatz.\n• Punkt eins\n• Punkt zwei\nLetzter Absatz.",
    );
  });

  it("extracts a <li> with a nested <p> once, without duplicating the text", () => {
    const html = page(accordionItem("Verschachtelt?", "<ul><li><p>Punkt mit Absatz</p></li></ul>"));
    const result = extractFaqPage(html, SOURCE);

    // The <p> nested inside the <li> is already captured by that <li> and must not be emitted a
    // second time as its own paragraph.
    expect(result.faqItems[0]?.answer).toBe("• Punkt mit Absatz");
  });

  it("skips an item whose answer is only whitespace", () => {
    const html = page(
      accordionItem("Gültige Frage?", "<p>Gültige Antwort</p>") +
        accordionItem("Leere Antwort?", "<p>   </p>"),
    );
    const result = extractFaqPage(html, SOURCE);

    expect(result.faqItems).toHaveLength(1);
    expect(result.faqItems[0]?.question).toBe("Gültige Frage?");
  });
});

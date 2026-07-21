import { describe, expect, it } from "vitest";
import { joinAnswerBlocks, normalizeText } from "../../src/rag/normalize.js";

describe("normalizeText", () => {
  it("collapses whitespace runs, including newlines and indentation, to single spaces", () => {
    expect(normalizeText("  Erster\n\t  Satz   hier ")).toBe("Erster Satz hier");
  });

  it("leaves German characters and typographic quotation marks unchanged", () => {
    expect(normalizeText("  Über „Kundenkonto“ genießen ")).toBe("Über „Kundenkonto“ genießen");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeText("   \n  ")).toBe("");
  });
});

describe("joinAnswerBlocks", () => {
  it("joins blocks with a single newline, preserving order", () => {
    expect(joinAnswerBlocks(["Absatz eins", "• Punkt", "Absatz zwei"])).toBe(
      "Absatz eins\n• Punkt\nAbsatz zwei",
    );
  });

  it("drops empty and whitespace-only blocks without merging the rest", () => {
    expect(joinAnswerBlocks(["a", "   ", "", "b"])).toBe("a\nb");
  });
});

import { describe, expect, it } from "vitest";
import { toRagQueryResponse } from "../../src/domain/rag-query.js";
import { searchResult } from "../helpers/rag-test-doubles.js";

/**
 * The projection from a retrieval result to the caller-visible response. It is the single place a
 * field can become public, so these tests pin down exactly which fields do.
 */
describe("toRagQueryResponse", () => {
  it("projects a retrieval result onto the evidence contract", () => {
    const response = toRagQueryResponse("Welche Vorteile habe ich mit einem Kundenkonto?", [
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.912345678 }),
    ]);

    expect(response).toEqual({
      status: "found",
      query: "Welche Vorteile habe ich mit einem Kundenkonto?",
      evidence: [
        {
          chunkKey: "mein-konto:v1:chunk-001",
          question: "Welche Vorteile bietet mir ein Konto?",
          answer: "Sie sehen Ihre Bestellungen jederzeit ein.",
          score: 0.912346,
          source: {
            documentKey: "mein-konto",
            documentVersion: 1,
            title: "Mein Konto",
            sourceUrl: "https://www.manufactum.de/mein-konto-c201130/",
          },
        },
      ],
    });
  });

  it("drops the canonical chunk content and every other internal retrieval field", () => {
    const [evidence] = toRagQueryResponse("Frage?", [
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.9 }),
    ]).evidence;

    expect(evidence).toBeDefined();
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      "answer",
      "chunkKey",
      "question",
      "score",
      "source",
    ]);
    expect(Object.keys(evidence?.source ?? {}).sort()).toEqual([
      "documentKey",
      "documentVersion",
      "sourceUrl",
      "title",
    ]);
  });

  it("reports not_found with empty evidence when nothing survived the relevance filter", () => {
    expect(toRagQueryResponse("Wie repariere ich eine Kaffeemühle?", [])).toEqual({
      status: "not_found",
      query: "Wie repariere ich eine Kaffeemühle?",
      evidence: [],
    });
  });

  it("preserves retrieval order rather than re-ranking", () => {
    const response = toRagQueryResponse("Frage?", [
      searchResult({ chunkKey: "mein-konto:v1:chunk-003", score: 0.9 }),
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.88 }),
      searchResult({ chunkKey: "mein-konto:v1:chunk-002", score: 0.87 }),
    ]);

    expect(response.evidence.map((item) => item.chunkKey)).toEqual([
      "mein-konto:v1:chunk-003",
      "mein-konto:v1:chunk-001",
      "mein-konto:v1:chunk-002",
    ]);
  });
});

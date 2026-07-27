import { describe, expect, it } from "vitest";
import {
  MAX_RAG_QUERY_LENGTH,
  parseRagQueryRequest,
} from "../../src/http/validation/rag-query-request.js";
import { AppError } from "../../src/errors/app-error.js";

/**
 * Request validation for `POST /api/rag/query`. Everything rejected here costs no embedding and no
 * database read, so these cases are the cheapest half of the endpoint's safety.
 */
describe("parseRagQueryRequest", () => {
  it("accepts a plain question and returns it trimmed", () => {
    expect(
      parseRagQueryRequest({ query: "  Welche Vorteile habe ich mit einem Kundenkonto?  " }),
    ).toEqual({ query: "Welche Vorteile habe ich mit einem Kundenkonto?" });
  });

  it("accepts a query at exactly the maximum length", () => {
    const query = "a".repeat(MAX_RAG_QUERY_LENGTH);

    expect(parseRagQueryRequest({ query })).toEqual({ query });
  });

  it.each([
    ["an empty query", { query: "" }],
    ["a whitespace-only query", { query: "   \t\n  " }],
    ["a missing query", {}],
    ["a null query", { query: null }],
    ["a numeric query", { query: 42 }],
    ["an array query", { query: ["a"] }],
    ["an object query", { query: { text: "a" } }],
    ["an over-long query", { query: "a".repeat(MAX_RAG_QUERY_LENGTH + 1) }],
    ["a null body", null],
    ["an array body", [{ query: "a" }]],
    ["a string body", "query"],
    ["an undefined body", undefined],
  ])("rejects %s as INVALID_REQUEST", (_label, body) => {
    expect(() => parseRagQueryRequest(body)).toThrow(AppError);
    expect(() => parseRagQueryRequest(body)).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST", status: 400 }),
    );
  });

  it.each([
    ["maxChunks", { query: "Frage?", maxChunks: 50 }],
    ["minScore", { query: "Frage?", minScore: 0 }],
    ["threshold", { query: "Frage?", threshold: 0.1 }],
    ["embeddingModel", { query: "Frage?", embeddingModel: "other/model" }],
    ["embeddingModelVersion", { query: "Frage?", embeddingModelVersion: "deadbeef" }],
    ["documentKey", { query: "Frage?", documentKey: "mein-konto" }],
    ["documentVersion", { query: "Frage?", documentVersion: 2 }],
    ["sql", { query: "Frage?", sql: "SELECT 1" }],
    ["filter", { query: "Frage?", filter: { language: "en" } }],
  ])("rejects a body carrying a %s retrieval-control field", (_label, body) => {
    expect(() => parseRagQueryRequest(body)).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps the technical detail out of the caller-facing message", () => {
    try {
      parseRagQueryRequest({ query: "" });
      expect.unreachable("validation must reject an empty query");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;

      expect(appError.safeCustomerMessage).toBe("Ich habe die Anfrage leider nicht verstanden.");
      expect(appError.safeCustomerMessage).not.toContain("query");
      expect(appError.retryable).toBe(false);
    }
  });
});

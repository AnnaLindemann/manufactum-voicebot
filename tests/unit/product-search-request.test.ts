import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/app-error.js";
import {
  DEFAULT_LIMIT,
  parseProductSearchRequest,
} from "../../src/http/validation/product-search-request.js";

function expectInvalid(query: unknown): void {
  let thrown: unknown;

  try {
    parseProductSearchRequest(query);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe("INVALID_REQUEST");
}

describe("parseProductSearchRequest", () => {
  it("accepts a minimal query and defaults limit to 5", () => {
    expect(parseProductSearchRequest({ q: "senf" })).toEqual({ q: "senf", limit: DEFAULT_LIMIT });
  });

  it("trims q and storeId", () => {
    expect(
      parseProductSearchRequest({
        q: "  senf  ",
        storeId: " MANUFACTUM_BERLIN_HAUS_HADENBERG ",
      }),
    ).toEqual({
      q: "senf",
      storeId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
      limit: DEFAULT_LIMIT,
    });
  });

  it("trims store and keeps its human-readable casing", () => {
    expect(parseProductSearchRequest({ q: "senf", store: "  Berlin  " })).toEqual({
      q: "senf",
      // Normalization for matching happens in the resolver; the query is echoed back verbatim.
      store: "Berlin",
      limit: DEFAULT_LIMIT,
    });
  });

  it("accepts a 200-character q and rejects a 201-character one", () => {
    expect(parseProductSearchRequest({ q: "a".repeat(200) }).q).toHaveLength(200);
    expectInvalid({ q: "a".repeat(201) });
  });

  it.each([undefined, "", "   ", "\t\n"])("rejects q of %o", (q) => {
    expectInvalid(q === undefined ? {} : { q });
  });

  it.each(["abc", "1.5", "0", "-1", "6", "100", "", " ", "1e1", "+2"])(
    "rejects limit of %o",
    (limit) => {
      expectInvalid({ q: "senf", limit });
    },
  );

  it.each(["1", "5"])("accepts limit of %s", (limit) => {
    expect(parseProductSearchRequest({ q: "senf", limit }).limit).toBe(Number(limit));
  });

  it("rejects a storeId longer than 64 characters", () => {
    expectInvalid({ q: "senf", storeId: "a".repeat(65) });
  });

  it("rejects a store query longer than 120 characters", () => {
    expectInvalid({ q: "senf", store: "a".repeat(121) });
  });

  it.each([
    ["", ""],
    ["   ", "   "],
  ])("rejects an empty store of %o and storeId of %o", (store, storeId) => {
    expectInvalid({ q: "senf", store });
    expectInvalid({ q: "senf", storeId });
  });

  it.each([
    ["store and storeId", { store: "Berlin", storeId: "MANUFACTUM_BERLIN_KGA" }],
    ["store and warehouseId", { store: "Berlin", warehouseId: "MANUFACTUM_BERLIN_KGA" }],
    ["storeId and warehouseId", { storeId: "MANUFACTUM_BERLIN_KGA", warehouseId: "MANUFACTUM_X" }],
    [
      "all three",
      { store: "Berlin", storeId: "MANUFACTUM_BERLIN_KGA", warehouseId: "MANUFACTUM_X" },
    ],
  ])("rejects %s supplied together", (_label, selectors) => {
    // Each expresses the same intent by different means. Honouring one silently would answer a
    // question the caller did not ask.
    expectInvalid({ q: "senf", ...selectors });
  });

  it("rejects storeId and warehouseId even when they carry the same value", () => {
    // Still rejected: agreement here would be luck, and the rule a caller has to reason about
    // should not depend on whether two values happen to coincide.
    expectInvalid({
      q: "senf",
      storeId: "MANUFACTUM_BERLIN_KGA",
      warehouseId: "MANUFACTUM_BERLIN_KGA",
    });
  });

  it.each(["store", "storeId"])("accepts %s on its own", (parameter) => {
    expect(parseProductSearchRequest({ q: "senf", [parameter]: "Berlin" })).toEqual({
      q: "senf",
      [parameter]: "Berlin",
      limit: DEFAULT_LIMIT,
    });
  });

  it("rejects a repeated query parameter, which arrives as an array", () => {
    expectInvalid({ q: ["senf", "salz"] });
  });

  it("ignores unknown query parameters rather than failing", () => {
    expect(parseProductSearchRequest({ q: "senf", mode: "exact" })).toEqual({
      q: "senf",
      limit: DEFAULT_LIMIT,
    });
  });

  it("accepts the deprecated warehouseId and normalizes it to storeId", () => {
    // The alias collapses at the boundary, so nothing downstream sees the older spelling.
    expect(
      parseProductSearchRequest({ q: "senf", warehouseId: " MANUFACTUM_BERLIN_KGA " }),
    ).toEqual({
      q: "senf",
      storeId: "MANUFACTUM_BERLIN_KGA",
      limit: DEFAULT_LIMIT,
    });
  });

  it("holds the deprecated alias to the same validation as storeId", () => {
    // An older spelling must not be a way around a current rule.
    expectInvalid({ q: "senf", warehouseId: "a".repeat(65) });
    expectInvalid({ q: "senf", warehouseId: "   " });
  });

  it("throws an AppError carrying the contracted status and retryable flag", () => {
    try {
      parseProductSearchRequest({});
      expect.unreachable("expected INVALID_REQUEST");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.status).toBe(400);
      expect(appError.retryable).toBe(false);
      expect(appError.safeCustomerMessage).not.toContain("q");
    }
  });
});

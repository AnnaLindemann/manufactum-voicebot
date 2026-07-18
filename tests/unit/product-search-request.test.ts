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

  it("trims q and warehouseId", () => {
    expect(parseProductSearchRequest({ q: "  senf  ", warehouseId: " 493024033844 " })).toEqual({
      q: "senf",
      warehouseId: "493024033844",
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

  it("rejects a warehouseId longer than 64 characters", () => {
    expectInvalid({ q: "senf", warehouseId: "a".repeat(65) });
  });

  it("rejects a repeated query parameter, which arrives as an array", () => {
    expectInvalid({ q: ["senf", "salz"] });
  });

  it("ignores unknown query parameters rather than failing", () => {
    expect(parseProductSearchRequest({ q: "senf", mode: "exact", storeId: "x" })).toEqual({
      q: "senf",
      limit: DEFAULT_LIMIT,
    });
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

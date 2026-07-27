import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RAG_RATE_LIMIT_WINDOW_MS,
  loadRagRateLimitConfig,
  MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS,
  MAX_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS,
  MIN_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS,
} from "../../src/config/rag-rate-limit-config.js";
import { RATE_LIMIT_MAX_REQUESTS } from "../../src/http/rate-limit.js";

describe("loadRagRateLimitConfig", () => {
  it("defaults to a conservative policy for a public test deployment", () => {
    expect(loadRagRateLimitConfig({})).toEqual({
      maxRequests: DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS,
      windowMs: DEFAULT_RAG_RATE_LIMIT_WINDOW_MS,
    });
  });

  it("is stricter than the product-search limiter, whose cost is upstream rather than local CPU", () => {
    expect(DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS).toBeLessThan(RATE_LIMIT_MAX_REQUESTS);
  });

  it("is configured separately from the product-search limiter", () => {
    const config = loadRagRateLimitConfig({
      RAG_RATE_LIMIT_MAX_REQUESTS: "4",
      RAG_RATE_LIMIT_WINDOW_MS: "30000",
    });

    expect(config).toEqual({ maxRequests: 4, windowMs: 30_000 });
    // The product-search policy is a code constant and must not move because this one did.
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(20);
  });

  it("treats an empty value as unset, which is what a cleared platform variable leaves", () => {
    expect(loadRagRateLimitConfig({ RAG_RATE_LIMIT_MAX_REQUESTS: "  " })).toEqual({
      maxRequests: DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS,
      windowMs: DEFAULT_RAG_RATE_LIMIT_WINDOW_MS,
    });
  });

  it("accepts the extremes of the permitted range", () => {
    expect(
      loadRagRateLimitConfig({
        RAG_RATE_LIMIT_MAX_REQUESTS: String(MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS),
        RAG_RATE_LIMIT_WINDOW_MS: String(MAX_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS),
      }).maxRequests,
    ).toBe(MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS);

    expect(
      loadRagRateLimitConfig({
        RAG_RATE_LIMIT_MAX_REQUESTS: "1",
        RAG_RATE_LIMIT_WINDOW_MS: String(MIN_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS),
      }),
    ).toEqual({ maxRequests: 1, windowMs: MIN_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS });
  });

  it.each([
    ["zero, which would switch the control off", "0"],
    ["a negative allowance", "-5"],
    ["a fractional allowance", "2.5"],
    ["a word", "unlimited"],
    ["a value beyond the ceiling", String(MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS + 1)],
  ])("rejects %s for RAG_RATE_LIMIT_MAX_REQUESTS", (_label, value) => {
    // The limiter can be tightened freely and loosened only within a bounded range: a security control
    // that an environment variable can widen without limit is one that eventually is.
    expect(() => loadRagRateLimitConfig({ RAG_RATE_LIMIT_MAX_REQUESTS: value })).toThrow(
      /RAG_RATE_LIMIT_MAX_REQUESTS/,
    );
  });

  it.each([
    ["a window shorter than the floor", "999"],
    ["a window longer than the ceiling", String(MAX_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS + 1)],
    ["a word", "eine Minute"],
  ])("rejects %s for RAG_RATE_LIMIT_WINDOW_MS", (_label, value) => {
    expect(() => loadRagRateLimitConfig({ RAG_RATE_LIMIT_WINDOW_MS: value })).toThrow(
      /RAG_RATE_LIMIT_WINDOW_MS/,
    );
  });

  it("reports both offending variables at once", () => {
    expect(() =>
      loadRagRateLimitConfig({
        RAG_RATE_LIMIT_MAX_REQUESTS: "viele",
        RAG_RATE_LIMIT_WINDOW_MS: "bald",
      }),
    ).toThrow(/RAG_RATE_LIMIT_MAX_REQUESTS, RAG_RATE_LIMIT_WINDOW_MS/);
  });
});

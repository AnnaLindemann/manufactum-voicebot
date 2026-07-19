import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  toErrorEnvelope,
  type ErrorCode,
} from "../../src/errors/app-error.js";

/** The agreed table from `api-contracts.md` § Error codes, asserted verbatim. */
const CONTRACT: Record<ErrorCode, { status: number; retryable: boolean }> = {
  INVALID_REQUEST: { status: 400, retryable: false },
  UPSTREAM_AUTH_FAILED: { status: 502, retryable: false },
  UPSTREAM_TIMEOUT: { status: 504, retryable: true },
  UPSTREAM_INVALID_RESPONSE: { status: 502, retryable: false },
  UPSTREAM_REJECTED_REQUEST: { status: 502, retryable: false },
  UPSTREAM_UNAVAILABLE: { status: 502, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
};

describe("AppError", () => {
  it.each(ERROR_CODES)("gives %s its contracted status and retryable flag", (code) => {
    const error = new AppError(code, "technical detail");

    expect(error.status).toBe(CONTRACT[code].status);
    expect(error.retryable).toBe(CONTRACT[code].retryable);
  });

  it("keeps the internal status set fixed at {400, 404, 429, 500, 502, 504}", () => {
    const statuses = new Set(ERROR_CODES.map((code) => new AppError(code, "x").status));

    // 429 was added by the Test Deployment checkpoint, with the rate limiter. The set is still
    // closed and still excludes any forwarded upstream status.
    expect([...statuses].sort((a, b) => a - b)).toEqual([400, 404, 429, 500, 502, 504]);
  });

  it.each(ERROR_CODES)("gives %s a safe customer message free of technical detail", (code) => {
    const error = new AppError(code, "upstream 403 at https://upstream.test/search?q=senf");

    expect(error.safeCustomerMessage.length).toBeGreaterThan(0);
    expect(error.safeCustomerMessage).not.toContain("http");
    expect(error.safeCustomerMessage).not.toContain(String(error.status));
    expect(error.safeCustomerMessage).not.toContain(code);
    expect(error.safeCustomerMessage).not.toBe(error.message);
  });

  it("builds an envelope carrying only the four contracted fields", () => {
    const envelope = toErrorEnvelope(new AppError("UPSTREAM_TIMEOUT", "aborted"), "cid-9");

    expect(envelope).toEqual({
      code: "UPSTREAM_TIMEOUT",
      safeCustomerMessage: envelope.safeCustomerMessage,
      retryable: true,
      correlationId: "cid-9",
    });
    expect(Object.keys(envelope).sort()).toEqual([
      "code",
      "correlationId",
      "retryable",
      "safeCustomerMessage",
    ]);
  });
});

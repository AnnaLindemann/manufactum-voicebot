import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/app-error.js";
import {
  createRateLimiter,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "../../src/http/rate-limit.js";

/**
 * Unit tests drive the limiter directly on a controlled clock, so window behaviour is asserted
 * without waiting a real minute. The HTTP-level behaviour is covered by the integration tests.
 */

type Outcome = { passed: boolean; error?: AppError; headers: Record<string, string> };

/**
 * `ip` is passed through exactly as given, including `undefined`. A default parameter would silently
 * substitute an address for the caller that has none, which is precisely the case worth testing.
 */
function callLimiterFrom(
  limiter: ReturnType<typeof createRateLimiter>,
  ip: string | undefined,
): Outcome {
  const headers: Record<string, string> = {};
  const outcome: Outcome = { passed: false, headers };

  const request = { ip } as Request;
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;

  const next = ((error?: unknown) => {
    if (error === undefined) {
      outcome.passed = true;
    } else {
      outcome.error = error as AppError;
    }
  }) as NextFunction;

  limiter(request, response, next);

  return outcome;
}

function callLimiter(limiter: ReturnType<typeof createRateLimiter>, ip = "203.0.113.1"): Outcome {
  return callLimiterFrom(limiter, ip);
}

describe("createRateLimiter", () => {
  it("uses the agreed policy of 20 requests per minute", () => {
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(20);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("admits exactly the limit within one window", () => {
    const limiter = createRateLimiter({ now: () => 1_000 });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      expect(callLimiter(limiter).passed, `request ${request} should pass`).toBe(true);
    }
  });

  it("rejects the request after the limit with a retryable RATE_LIMITED error", () => {
    const limiter = createRateLimiter({ now: () => 1_000 });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter);
    }

    const { passed, error } = callLimiter(limiter);

    expect(passed).toBe(false);
    expect(error).toBeInstanceOf(AppError);
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.status).toBe(429);
    // Waiting alone fixes this one, unlike every other non-2xx code.
    expect(error?.retryable).toBe(true);
  });

  it("counts each client IP separately", () => {
    const limiter = createRateLimiter({ now: () => 1_000 });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter, "203.0.113.1");
    }

    expect(callLimiter(limiter, "203.0.113.1").passed).toBe(false);
    // A second caller must be unaffected by the first one's exhausted budget.
    expect(callLimiter(limiter, "198.51.100.7").passed).toBe(true);
  });

  it("admits requests again once the window has elapsed", () => {
    let currentTime = 1_000;
    const limiter = createRateLimiter({ now: () => currentTime });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter);
    }

    expect(callLimiter(limiter).passed).toBe(false);

    currentTime += RATE_LIMIT_WINDOW_MS;

    expect(callLimiter(limiter).passed).toBe(true);
  });

  it("sets Retry-After to the whole seconds left in the window", () => {
    let currentTime = 1_000;
    const limiter = createRateLimiter({ now: () => currentTime });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter);
    }

    currentTime += 15_000;

    expect(callLimiter(limiter).headers["retry-after"]).toBe("45");
  });

  it("never sets Retry-After to 0, which would invite an immediate second rejection", () => {
    let currentTime = 1_000;
    const limiter = createRateLimiter({ now: () => currentTime });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter);
    }

    // One millisecond before the window closes.
    currentTime += RATE_LIMIT_WINDOW_MS - 1;

    expect(callLimiter(limiter).headers["retry-after"]).toBe("1");
  });

  it("groups requests with no resolvable IP rather than exempting them", () => {
    const limiter = createRateLimiter({ now: () => 1_000 });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      // Two distinct unidentifiable callers must share one budget, not each receive a full one.
      callLimiterFrom(limiter, undefined);
    }

    expect(callLimiterFrom(limiter, undefined).passed).toBe(false);
  });

  it("does not name the client in the technical message, which reaches the logs", () => {
    const limiter = createRateLimiter({ now: () => 1_000 });

    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      callLimiter(limiter, "203.0.113.1");
    }

    // An IP address is personal data, and `coding-standards.md` keeps it out of log lines.
    expect(callLimiter(limiter, "203.0.113.1").error?.message).not.toContain("203.0.113.1");
  });

  it("keeps many concurrent clients independent and still expires each one's window", () => {
    let currentTime = 1_000;
    const limiter = createRateLimiter({ now: () => currentTime });

    for (let client = 0; client < 500; client += 1) {
      expect(callLimiter(limiter, `198.51.100.${client}`).passed).toBe(true);
    }

    currentTime += RATE_LIMIT_WINDOW_MS * 2;

    // A returning client gets a fresh budget whether or not its bucket was swept in between. The
    // sweep itself is an internal memory concern and is deliberately not asserted here: doing so
    // would mean exposing the bucket map purely for a test.
    for (let request = 1; request <= RATE_LIMIT_MAX_REQUESTS; request += 1) {
      expect(callLimiter(limiter, "198.51.100.0").passed).toBe(true);
    }
  });
});

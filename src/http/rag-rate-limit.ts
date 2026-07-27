import type { NextFunction, Request, RequestHandler, Response } from "express";
import { loadRagRateLimitConfig } from "../config/rag-rate-limit-config.js";
import { createRateLimiter } from "./rate-limit.js";

/**
 * The limiter mounted on `POST /api/rag/query`.
 *
 * It is the same fixed-window counter as the product-search limiter — there is no second limiting
 * algorithm — configured from its own variables. Only the policy is separate, and it is separate
 * because the two endpoints are limited for different reasons; see `rag-rate-limit-config.ts`.
 *
 * The rejection path is identical to the product-search one on purpose: a `RATE_LIMITED` `AppError`
 * handed to the central error middleware, which produces HTTP `429`, the standard envelope with a
 * correlation ID, and a `Retry-After` header in whole seconds. An admitted request reaches the route
 * untouched, so the `found` / `not_found` success contract and every documented error response are
 * exactly what they were.
 *
 * **In memory, per process.** The counter lives in this process's heap. It does not survive a
 * restart and is not shared between instances, so the deployment must run a **single** Render
 * instance — with two, each caller gets the configured budget on every instance. This mirrors the
 * product-search limiter's accepted limitation (`D-018`), and it is recorded in
 * `deployment-preflight.md` as a deployment constraint rather than a code one.
 */
export function createRagQueryRateLimiter(): RequestHandler {
  let limiter: RequestHandler | undefined;

  /**
   * The configuration is read on the **first** request, not at import.
   *
   * That is the same lazy-read rule the Manufactum and RAG retrieval configurations follow, and it
   * exists for the same reason: importing the app for a test or a health check must not require any
   * environment at all. `server.ts` validates this configuration at startup, so a malformed value
   * fails the deploy long before a request could reach the lazy read.
   */
  return function ragRateLimit(request: Request, response: Response, next: NextFunction): void {
    limiter ??= createRateLimiter(loadRagRateLimitConfig());
    limiter(request, response, next);
  };
}

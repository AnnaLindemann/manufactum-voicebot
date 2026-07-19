import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error.js";

/**
 * Fixed-window rate limiting for the temporary public read-only deployment.
 *
 * `architecture.md` § Security rules requires public endpoints to be rate-limited. The Test
 * Deployment checkpoint makes `GET /api/products/search` publicly reachable without inbound
 * authentication — a shared token was rejected because Dialfire's secret storage is unconfirmed and
 * a token pasted into its script would not be secure. The limiter is therefore the only thing
 * standing between the public URL and our upstream Manufactum credential: every request that passes
 * it costs one real upstream call against a test key.
 *
 * The agreed policy is 20 requests per minute per client IP. It is deliberately a constant rather
 * than an environment variable: a security control that can be widened by an environment setting
 * tends to be widened.
 */

export const RATE_LIMIT_MAX_REQUESTS = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * A fixed window, not a sliding one. It admits up to twice the limit across a window boundary, which
 * is accepted here: the control exists to stop sustained abuse of an unauthenticated endpoint, and
 * sustained abuse cannot hide in one boundary. A sliding window would cost per-request timestamp
 * storage for a demo-scale deployment.
 */
type Bucket = { count: number; windowStartedAt: number };

export type RateLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
  /** Injectable so tests can advance time without waiting a real minute. */
  now?: () => number;
};

/**
 * The identity a limit is counted against.
 *
 * `request.ip` resolves to the socket peer unless Express's `trust proxy` is enabled, which
 * `server.ts` does only when `TRUST_PROXY` is set. Behind an un-configured proxy every caller
 * therefore shares one bucket and the limit becomes global — restrictive, never permissive. That is
 * the correct direction to fail for an unauthenticated endpoint: the opposite mistake, trusting
 * `X-Forwarded-For` where no proxy sets it, would let any caller spoof a fresh identity per request
 * and bypass the limiter entirely.
 *
 * A request with no resolvable IP shares the `unknown` bucket for the same reason.
 */
function clientKey(request: Request): string {
  return request.ip ?? "unknown";
}

export function createRateLimiter({
  maxRequests = RATE_LIMIT_MAX_REQUESTS,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now = () => Date.now(),
}: RateLimiterOptions = {}) {
  const buckets = new Map<string, Bucket>();
  let lastSweptAt = now();

  /**
   * Without this the map grows once per distinct source IP and never shrinks, which turns the
   * limiter itself into the memory-exhaustion vector it exists to prevent. Sweeping at most once per
   * window keeps the cost off the request path.
   */
  function sweepExpired(currentTime: number): void {
    if (currentTime - lastSweptAt < windowMs) {
      return;
    }

    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.windowStartedAt >= windowMs) {
        buckets.delete(key);
      }
    }

    lastSweptAt = currentTime;
  }

  return function rateLimit(request: Request, response: Response, next: NextFunction): void {
    const currentTime = now();

    sweepExpired(currentTime);

    const key = clientKey(request);
    const bucket = buckets.get(key);

    if (bucket === undefined || currentTime - bucket.windowStartedAt >= windowMs) {
      buckets.set(key, { count: 1, windowStartedAt: currentTime });
      next();
      return;
    }

    bucket.count += 1;

    if (bucket.count <= maxRequests) {
      next();
      return;
    }

    const retryAfterMs = bucket.windowStartedAt + windowMs - currentTime;

    // Set here rather than in the error middleware, which stays free of per-code special cases. At
    // least 1, because `Retry-After: 0` invites an immediate retry that would also be rejected.
    response.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));

    // Handed to the central error middleware, so a 429 leaves through the one place that builds the
    // envelope, exactly like every other non-2xx response. See `D-012`.
    next(
      new AppError(
        "RATE_LIMITED",
        `Rate limit of ${maxRequests} requests per ${windowMs} ms exceeded for one client.`,
      ),
    );
  };
}

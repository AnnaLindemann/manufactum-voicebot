import { z } from "zod";

/**
 * Rate-limit policy for `POST /api/rag/query`, kept separate from the product-search limiter.
 *
 * The two endpoints are limited for **different reasons**, so one shared number would be wrong for
 * both. `GET /api/products/search` is limited because every admitted request spends one paid upstream
 * call against our Manufactum credential (`D-018`). A RAG query spends no upstream call at all: it
 * costs local CPU for one embedding inference and one pgvector read of our own database. What it
 * threatens is the instance itself — on a small single-instance Render plan, concurrent inference on
 * a 118 MB quantized ONNX model is the heaviest thing the process does, and an unlimited public
 * endpoint that runs it is a denial-of-service surface, not a billing surface.
 *
 * `api-contracts.md` § POST /api/rag/query previously recorded that this endpoint is *not* limited,
 * with the explicit condition that the decision "must be revisited" if it is ever exposed publicly
 * alongside the product-search route. The public test deployment is exactly that, so it is revisited
 * here.
 */

/**
 * `[D]` Ten requests per minute per client IP: half the product-search allowance, which is the
 * conservative direction for an endpoint whose cost is CPU on a shared instance rather than an
 * upstream call. A voice agent asks one FAQ question per conversational turn; ten per minute is far
 * more than a single caller can produce by speaking, and any client that needs more than that during
 * a controlled test is either looping or is not the demo.
 */
export const DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS = 10;

export const DEFAULT_RAG_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * `[D]` The product-search limiter is a hard-coded constant, on the stated ground that "a security
 * control that can be widened by an environment setting tends to be widened". That ground is
 * respected rather than abandoned: this limiter is configurable, because a public test deployment has
 * to be tunable without a redeploy, but it is configurable **within a bounded range**. An operator
 * can tighten it freely and can loosen it only up to a ceiling that is still a limit. `0`, a negative
 * value, a fractional value, a wildly permissive value, and a window measured in milliseconds are all
 * configuration errors that fail the deploy, not quiet ways to switch the control off.
 */
export const MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS = 60;
export const MIN_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS = 1_000;
export const MAX_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS = 600_000;

const configSchema = z.object({
  maxRequests: z.number().int().min(1).max(MAX_CONFIGURABLE_RAG_RATE_LIMIT_MAX_REQUESTS),
  windowMs: z
    .number()
    .int()
    .min(MIN_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS)
    .max(MAX_CONFIGURABLE_RAG_RATE_LIMIT_WINDOW_MS),
});

export type RagRateLimitConfig = z.infer<typeof configSchema>;

/**
 * @throws {Error} when a variable is set but malformed or out of range. The message names the
 * variable only, in the same style as every other configuration loader.
 */
export function loadRagRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RagRateLimitConfig {
  const rawMaxRequests = nonEmpty(env.RAG_RATE_LIMIT_MAX_REQUESTS);
  const rawWindowMs = nonEmpty(env.RAG_RATE_LIMIT_WINDOW_MS);

  const result = configSchema.safeParse({
    // An unset variable takes the documented default; a set-but-malformed one is a configuration
    // error and must fail loudly rather than silently fall back to a policy nobody chose.
    maxRequests:
      rawMaxRequests === undefined ? DEFAULT_RAG_RATE_LIMIT_MAX_REQUESTS : Number(rawMaxRequests),
    windowMs: rawWindowMs === undefined ? DEFAULT_RAG_RATE_LIMIT_WINDOW_MS : Number(rawWindowMs),
  });

  if (!result.success) {
    const variables: Record<string, string> = {
      maxRequests: "RAG_RATE_LIMIT_MAX_REQUESTS",
      windowMs: "RAG_RATE_LIMIT_WINDOW_MS",
    };

    const invalid = [
      ...new Set(
        result.error.issues.map((issue) => variables[String(issue.path[0])] ?? "unknown variable"),
      ),
    ];

    throw new Error(`Invalid RAG rate limit configuration: ${invalid.join(", ")}`);
  }

  return result.data;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

import { z } from "zod";

/**
 * Upstream connection details come from environment variables only, per `D-011`. They are never
 * committed, never logged, and never included in an error message.
 */

/**
 * `[D]` The single source of truth for the internal upstream timeout. Raised from 5 s to 8 s in the
 * Phase 3 review: the observed cold upstream call took 4431 ms, which left too little safety margin
 * under a 5-second budget. Warm calls were 316–476 ms, so the raise costs nothing in the normal
 * case. It is still far tighter than the 10 s used by the Phase 1 discovery script, because a voice
 * call cannot wait indefinitely. No retry logic accompanies it. See `D-016`.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;

const configSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  apiKeyHeader: z.string().min(1),
  /** Overridable per environment so a slower environment can be tuned without a code change. */
  timeoutMs: z.number().int().positive(),
});

export type ManufactumConfig = z.infer<typeof configSchema>;

/**
 * Read lazily, at the first upstream call rather than at import time, so that importing the app —
 * for a health check or a test that never reaches upstream — does not require credentials.
 *
 * @throws {Error} when a variable is missing or malformed. The message names the variable only;
 * no value is ever included, because one of them is the API key.
 */
export function loadManufactumConfig(env: NodeJS.ProcessEnv = process.env): ManufactumConfig {
  const rawTimeout = env.MANUFACTUM_API_TIMEOUT_MS?.trim();

  const result = configSchema.safeParse({
    baseUrl: env.MANUFACTUM_API_BASE_URL?.trim(),
    apiKey: env.MANUFACTUM_API_KEY?.trim(),
    apiKeyHeader: env.MANUFACTUM_API_KEY_HEADER?.trim(),
    // An unset variable takes the documented default; a set-but-malformed one is a configuration
    // error and must fail loudly rather than silently fall back.
    timeoutMs:
      rawTimeout === undefined || rawTimeout === ""
        ? DEFAULT_UPSTREAM_TIMEOUT_MS
        : Number(rawTimeout),
  });

  if (!result.success) {
    const variables: Record<string, string> = {
      baseUrl: "MANUFACTUM_API_BASE_URL",
      apiKey: "MANUFACTUM_API_KEY",
      apiKeyHeader: "MANUFACTUM_API_KEY_HEADER",
      timeoutMs: "MANUFACTUM_API_TIMEOUT_MS",
    };

    const missing = [
      ...new Set(
        result.error.issues.map((issue) => variables[String(issue.path[0])] ?? "unknown variable"),
      ),
    ];

    throw new Error(`Invalid or missing environment configuration: ${missing.join(", ")}`);
  }

  return result.data;
}

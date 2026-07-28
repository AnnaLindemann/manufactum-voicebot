/**
 * Which runtime produces the **query** embedding for `POST /api/rag/query`.
 *
 * The passage side is not configurable and is not touched here: the stored vectors were produced by
 * the local int8 ONNX artifact pinned in `RAG_EMBEDDING_PROFILE`, and they stay that way. This
 * setting selects only the runtime that turns a caller's question into the 384-dimensional vector
 * that queries that space, because that is the one step Render Free cannot perform — loading the
 * ~118 MB model in a 512 MB instance is what the Gate 4 measurement showed running out of memory.
 *
 * Resolved as its own sub-configuration, in the shape `resolveDatabaseSslConfig` already uses, so it
 * is validated by the same startup check that validates the connection string and the TLS mode. A
 * release naming a provider that does not exist, or asking for the hosted provider without a
 * credential, therefore fails the deploy rather than answering every retrieval call with an
 * `INTERNAL_ERROR`.
 *
 * Nothing here is ever logged. `HF_TOKEN` is a bearer credential: the failure messages name
 * variables, never values, and the token is carried in the returned config and nowhere else.
 */

/**
 * `[D]` Exactly the two runtimes Experiments A–C compared, and no third. `local` is the accepted
 * baseline; `huggingface` is the hosted `feature-extraction` route validated in Experiment A and
 * measured over the frozen 96-query dataset in Experiment C.
 */
export const QUERY_EMBEDDING_PROVIDERS = ["local", "huggingface"] as const;

export type QueryEmbeddingProviderName = (typeof QUERY_EMBEDDING_PROVIDERS)[number];

/**
 * `[D]` Unset means `local`. The variable is new, so every existing deployment and every existing
 * test has no value for it, and the accepted baseline must be what they keep running. Making the
 * hosted provider the default would silently change the retrieval runtime of a release that changed
 * nothing.
 */
export const DEFAULT_QUERY_EMBEDDING_PROVIDER = "local";

/**
 * `[D]` The model Experiments A and C called. It is the `sentence-transformers` publication of the
 * same weights the local profile pins (`Xenova/multilingual-e5-small` is a conversion of
 * `intfloat/multilingual-e5-small`), which is why a remote query vector can address the local
 * passage space at all. Overridable, because the served revision is unpinnable (Gate 3) and an
 * operator may need to move to a differently published copy without a release.
 */
export const DEFAULT_HF_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";

/**
 * `[D]` Experiment C measured a 782 ms cold call and a 888 ms warm maximum from a development
 * machine, against a published provider latency of 5100 ms for this model. Ten seconds clears the
 * published figure with margin while still failing a stalled call inside a phone call's patience.
 * It is deliberately far below the 30 s the experiment scripts used: that value existed so a probe
 * would never mistake a slow warm-up for an outage, and it was recorded as explicitly not a
 * production value.
 */
export const DEFAULT_HF_EMBEDDING_TIMEOUT_MS = 10_000;

/**
 * Bounded so the timeout can be tightened freely and loosened only within a range that still fails.
 * Below a second nothing would ever complete; above thirty seconds a single hung call would outlive
 * any voice interaction it was serving.
 */
export const MIN_HF_EMBEDDING_TIMEOUT_MS = 1_000;
export const MAX_HF_EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * A Hugging Face repository identifier, `owner/name`. Validated rather than trusted because it is
 * interpolated into the request URL: an unchecked value could walk out of the models path with `..`
 * or append a query string of its own.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type QueryEmbeddingProviderConfig =
  | { provider: "local" }
  | { provider: "huggingface"; token: string; model: string; timeoutMs: number };

export type QueryEmbeddingProviderResolution =
  | { ok: true; config: QueryEmbeddingProviderConfig }
  /** Names the offending variables only, in the same style as the other configuration loaders. */
  | { ok: false; message: string };

export function resolveQueryEmbeddingProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): QueryEmbeddingProviderResolution {
  const requested = nonEmpty(env.RAG_QUERY_EMBEDDING_PROVIDER);

  if (requested === undefined) {
    return { ok: true, config: { provider: DEFAULT_QUERY_EMBEDDING_PROVIDER } };
  }

  if (!isProviderName(requested)) {
    return {
      ok: false,
      message: `RAG_QUERY_EMBEDDING_PROVIDER (must be one of ${QUERY_EMBEDDING_PROVIDERS.join(", ")})`,
    };
  }

  if (requested === "local") {
    // The `HF_*` variables are deliberately not read, let alone validated, on this branch. A
    // deployment rolling back to the local runtime must not be held up by a credential it no longer
    // uses.
    return { ok: true, config: { provider: "local" } };
  }

  // Collected rather than returned one at a time, so an operator sees every offending variable in
  // the single startup message instead of discovering the next one on the next deploy.
  const problems: string[] = [];

  const token = nonEmpty(env.HF_TOKEN);
  if (token === undefined) {
    problems.push("HF_TOKEN (required when RAG_QUERY_EMBEDDING_PROVIDER is huggingface)");
  }

  const model = nonEmpty(env.HF_EMBEDDING_MODEL) ?? DEFAULT_HF_EMBEDDING_MODEL;
  if (!MODEL_ID_PATTERN.test(model) || model.includes("..")) {
    problems.push("HF_EMBEDDING_MODEL (must be an owner/name Hugging Face repository identifier)");
  }

  const rawTimeout = nonEmpty(env.HF_EMBEDDING_TIMEOUT_MS);
  // An unset variable takes the documented default; a set-but-malformed one is a configuration
  // error and must fail loudly rather than silently fall back to a different timeout.
  const timeoutMs = rawTimeout === undefined ? DEFAULT_HF_EMBEDDING_TIMEOUT_MS : Number(rawTimeout);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_HF_EMBEDDING_TIMEOUT_MS ||
    timeoutMs > MAX_HF_EMBEDDING_TIMEOUT_MS
  ) {
    problems.push(
      `HF_EMBEDDING_TIMEOUT_MS (must be an integer from ${String(MIN_HF_EMBEDDING_TIMEOUT_MS)} to ${String(MAX_HF_EMBEDDING_TIMEOUT_MS)})`,
    );
  }

  if (problems.length > 0) {
    return { ok: false, message: problems.join(", ") };
  }

  if (token === undefined) {
    // Unreachable: a missing token is already in `problems`. Present so the narrowing below is
    // proved rather than asserted.
    return { ok: false, message: "HF_TOKEN" };
  }

  return { ok: true, config: { provider: "huggingface", token, model, timeoutMs } };
}

function isProviderName(value: string): value is QueryEmbeddingProviderName {
  return (QUERY_EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

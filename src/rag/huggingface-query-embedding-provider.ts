import type { Logger } from "../logging/logger.js";
import { RagEmbeddingError, vectorL2Norm } from "./e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, type RagEmbeddingProfile } from "./embedding-profile.js";
import type {
  QueryEmbeddingProvider,
  QueryEmbeddingProviderResult,
} from "./query-embedding-provider.js";

/**
 * The hosted query-embedding runtime, for deployments that cannot load the local ONNX artifact.
 *
 * It calls exactly the route Experiment A validated and Experiment C measured over the frozen
 * 96-query dataset, with exactly the request body those experiments sent, and it holds the returned
 * vector to exactly the standard the local generator holds its own output to. Nothing here re-tunes
 * retrieval: this class produces one query vector and hands it to the unchanged retrieval path.
 *
 * Safety properties this class is responsible for, and which its tests pin:
 *
 * - the bearer credential appears in one place, the request header, and in no error, log field, or
 *   thrown `cause`;
 * - no provider response body is ever parsed into a message, logged, or propagated — an unauthorized
 *   response from this route is a multi-kilobyte CloudFront HTML page, and a provider body can echo
 *   request content, which here is the caller's spoken question;
 * - every failure leaves as a `RagEmbeddingError` with a closed code, which the application service
 *   already maps to one `INTERNAL_ERROR` carrying nothing but that code.
 */

/**
 * `[D]` The current router host, established in Experiment A. The legacy `api-inference.huggingface.co`
 * hostname no longer resolves, and the OpenAI-compatible `router.huggingface.co/v1` surface is
 * chat-only — `POST /v1/embeddings` returns 404. This pipeline route is the only path that serves
 * this model.
 */
export const HUGGING_FACE_ENDPOINT_BASE = "https://router.huggingface.co/hf-inference/models";

/** Identifies the upstream call in a log line. Never the full URL: it carries the model identifier. */
const LOG_ENDPOINT = "POST hf-inference/pipeline/feature-extraction";

/**
 * `[D]` One retry, so exactly two attempts. A single transient provider blip should not fail a
 * caller's question, and a second failure in a row is not a blip — it is an outage, and retrying
 * further would only hold a voice call open while the same error accumulates.
 */
const MAX_ATTEMPTS = 2;

/**
 * `[D]` Retried: the failures that are *known* to be transient and *safe* to repeat. A timeout and a
 * 5xx are the provider being slow or briefly broken.
 *
 * Not retried, deliberately: `401` and `403` (a credential does not become valid 250 ms later),
 * `400` (a rejected request is rejected identically the second time), and `429` (a rate limit
 * answered with an immediate second call is the one response that makes it worse). A transport
 * failure that is not a timeout is also not retried: the accepted scope names the retryable set
 * explicitly, and this is not in it.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/**
 * Exponential backoff, `BASE * 2^(retry - 1)`. With one retry permitted it evaluates to a single
 * 250 ms pause; the form is written out rather than inlined so the growth law is the thing stated,
 * not a magic delay that happens to be the first term of it.
 */
const RETRY_BASE_DELAY_MS = 250;

/** The tolerance the local generator already applies to itself, so both providers are graded alike. */
const NORM_TOLERANCE = 0.001;

/** Below this a vector is degenerate: cosine similarity against it is undefined, not merely small. */
const ZERO_VECTOR_EPSILON = 1e-9;

export type HuggingFaceQueryEmbeddingProviderOptions = {
  token: string;
  model: string;
  timeoutMs: number;
  logger: Logger;
  profile?: RagEmbeddingProfile;
  /** Injectable so a test can drive every failure mode without a network. */
  fetchImplementation?: typeof fetch;
  /** Injectable so a test can observe the backoff without waiting for it. */
  delay?: (milliseconds: number) => Promise<void>;
};

export class HuggingFaceQueryEmbeddingProvider implements QueryEmbeddingProvider {
  private readonly profile: RagEmbeddingProfile;
  private readonly fetchImplementation: typeof fetch;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly url: string;

  constructor(private readonly options: HuggingFaceQueryEmbeddingProviderOptions) {
    this.profile = options.profile ?? RAG_EMBEDDING_PROFILE;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.url = `${HUGGING_FACE_ENDPOINT_BASE}/${options.model}/pipeline/feature-extraction`;
  }

  async embedQuery(query: string): Promise<QueryEmbeddingProviderResult> {
    const body = JSON.stringify({
      // The prefix comes from the frozen profile rather than a literal, so the query side cannot
      // drift away from the recipe the stored passages were embedded under. The API's own
      // `prompt_name` parameter is not usable here: it requires a `prompts` dictionary in the
      // repository's `config_sentence_transformers.json`, which this model does not publish.
      inputs: `${this.profile.queryPrefix}${query}`,
      normalize: true,
      truncate: true,
      truncation_direction: "right",
    });

    let lastError: RagEmbeddingError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await this.delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 2));
      }

      const outcome = await this.attempt(body);

      if (outcome.ok) {
        return outcome.result;
      }

      lastError = outcome.error;

      if (!outcome.retry || attempt === MAX_ATTEMPTS) {
        throw outcome.error;
      }
    }

    // Unreachable: the loop either returns, or throws on its final attempt. Present so the
    // exhaustiveness is proved rather than asserted.
    throw (
      lastError ??
      new RagEmbeddingError(
        "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED",
        "Hugging Face query embedding produced no attempt.",
        true,
      )
    );
  }

  /**
   * One request. Every failure mode — transport, timeout, HTTP status, unparseable body, unexpected
   * shape, unusable vector — resolves to a classified error here; nothing escapes as a raw fetch or
   * JSON exception, and no failure carries a provider body or a `cause` that could quote one.
   */
  private async attempt(body: string): Promise<AttemptOutcome> {
    const startedAt = Date.now();
    let response: Response;

    try {
      response = await this.fetchImplementation(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";

      return this.failed(
        new RagEmbeddingError(
          "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED",
          timedOut
            ? `Hugging Face query embedding timed out after ${String(this.options.timeoutMs)} ms.`
            : "Hugging Face query embedding request failed before a response arrived.",
          true,
        ),
        { retry: timedOut, latencyMs: Date.now() - startedAt },
      );
    }

    const latencyMs = Date.now() - startedAt;

    if (response.status !== 200) {
      // Read and discarded so the connection is released. The text is never inspected, logged, or
      // thrown: on this route a 401 body is a ~3 kB HTML error page and a provider body can echo the
      // request, which here is the caller's question.
      await response.text().catch(() => "");

      return this.failed(errorForStatus(response.status), {
        retry: RETRYABLE_STATUSES.has(response.status),
        latencyMs,
        status: response.status,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return this.failed(
        new RagEmbeddingError(
          "RAG_EMBEDDING_INVALID_OUTPUT",
          "Hugging Face query embedding response body could not be read.",
          true,
        ),
        { retry: false, latencyMs, status: response.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return this.failed(
        new RagEmbeddingError(
          "RAG_EMBEDDING_INVALID_OUTPUT",
          "Hugging Face query embedding response was not valid JSON.",
          false,
        ),
        { retry: false, latencyMs, status: response.status },
      );
    }

    const unwrapped = unwrapEmbedding(parsed);
    if (!unwrapped.ok) {
      return this.failed(
        new RagEmbeddingError("RAG_EMBEDDING_INVALID_OUTPUT", unwrapped.reason, false),
        { retry: false, latencyMs, status: response.status },
      );
    }

    const problem = vectorProblem(unwrapped.vector, this.profile.dimension);
    if (problem !== null) {
      return this.failed(new RagEmbeddingError("RAG_EMBEDDING_INVALID_OUTPUT", problem, false), {
        retry: false,
        latencyMs,
        status: response.status,
      });
    }

    return {
      ok: true,
      result: { embedding: unwrapped.vector, l2Norm: vectorL2Norm(unwrapped.vector) },
    };
  }

  /**
   * Records one failed attempt and classifies it.
   *
   * `error.retryable` and `retry` are different questions and are deliberately not merged. The
   * former is the error model's contract — whether this failure could ever succeed on a repeat, which
   * a rate limit and a non-timeout transport failure both could. The latter is what *this* class
   * does about it, which the accepted scope fixes to a named set.
   */
  private failed(
    error: RagEmbeddingError,
    outcome: { retry: boolean; latencyMs: number; status?: number },
  ): AttemptOutcome {
    // Every field is either a fixed string, a status code, or a measured duration. No response body,
    // no URL, no model identifier, and above all no credential can reach a log line from here.
    this.options.logger.warn("rag_query_embedding_provider_failed", {
      endpoint: LOG_ENDPOINT,
      ...(outcome.status === undefined ? {} : { upstreamStatus: outcome.status }),
      upstreamLatencyMs: outcome.latencyMs,
      errorCode: error.code,
      message: error.message,
    });

    return { ok: false, error, retry: outcome.retry };
  }
}

type AttemptOutcome =
  | { ok: true; result: QueryEmbeddingProviderResult }
  | { ok: false; error: RagEmbeddingError; retry: boolean };

/** Translates a provider status into a closed internal code. The status itself is never forwarded. */
function errorForStatus(status: number): RagEmbeddingError {
  if (status === 401 || status === 403) {
    return new RagEmbeddingError(
      "RAG_EMBEDDING_PROVIDER_AUTH_FAILED",
      `Hugging Face rejected the query embedding credential (HTTP ${String(status)}).`,
      false,
    );
  }

  if (status === 429) {
    return new RagEmbeddingError(
      "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED",
      "Hugging Face rate limited the query embedding request (HTTP 429).",
      true,
    );
  }

  if (status >= 500) {
    return new RagEmbeddingError(
      "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED",
      `Hugging Face query embedding failed upstream (HTTP ${String(status)}).`,
      true,
    );
  }

  return new RagEmbeddingError(
    "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED",
    `Hugging Face rejected the query embedding request (HTTP ${String(status)}).`,
    false,
  );
}

type UnwrappedEmbedding = { ok: true; vector: number[] } | { ok: false; reason: string };

/**
 * Accepts the two shapes that carry one pooled sentence embedding and rejects everything else.
 *
 * It deliberately does not flatten deeper nesting. A depth-3 response is token-level output — the
 * sentence-transformers pooling and normalization modules were bypassed — which is a different kind
 * of result, not a differently packaged one. Pooling it here would put a second, unproven pooling
 * implementation between the question and a vector space built by the first one.
 */
function unwrapEmbedding(value: unknown): UnwrappedEmbedding {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "Hugging Face query embedding response was not an array." };
  }

  const depth = nestingDepth(value);

  if (depth === 1) {
    return numericRow(value, "Hugging Face query embedding contained a non-numeric element.");
  }

  if (depth === 2) {
    if (value.length !== 1) {
      return {
        ok: false,
        reason: `Hugging Face returned ${String(value.length)} query embeddings, expected exactly 1.`,
      };
    }
    const first: unknown = value[0];
    if (!Array.isArray(first)) {
      return { ok: false, reason: "Hugging Face query embedding row was not an array." };
    }
    return numericRow(first, "Hugging Face query embedding contained a non-numeric element.");
  }

  return {
    ok: false,
    reason: `Hugging Face returned an unexpected nesting depth ${String(depth)}, not one pooled embedding.`,
  };
}

function numericRow(row: readonly unknown[], reason: string): UnwrappedEmbedding {
  const vector = row.filter((element): element is number => typeof element === "number");
  return vector.length === row.length ? { ok: true, vector } : { ok: false, reason };
}

function nestingDepth(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  const first: unknown = value[0];
  return 1 + nestingDepth(first);
}

/** Returns a reason when the vector cannot query the stored space, `null` when it is sound. */
function vectorProblem(vector: readonly number[], expectedDimension: number): string | null {
  if (vector.length !== expectedDimension) {
    return `Expected ${String(expectedDimension)} query embedding dimensions, received ${String(vector.length)}.`;
  }

  if (!vector.every((value) => Number.isFinite(value))) {
    return "Hugging Face query embedding contained NaN or Infinity.";
  }

  const l2Norm = vectorL2Norm(vector);

  if (l2Norm <= ZERO_VECTOR_EPSILON) {
    return "Hugging Face query embedding was the zero vector.";
  }

  if (Math.abs(l2Norm - 1) > NORM_TOLERANCE) {
    return `Expected an L2-normalized query embedding, received norm ${l2Norm.toFixed(6)}.`;
  }

  return null;
}

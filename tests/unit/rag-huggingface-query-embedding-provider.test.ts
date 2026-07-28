import { describe, expect, it } from "vitest";
import { RagEmbeddingError } from "../../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../../src/rag/embedding-profile.js";
import {
  HUGGING_FACE_ENDPOINT_BASE,
  HuggingFaceQueryEmbeddingProvider,
} from "../../src/rag/huggingface-query-embedding-provider.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/test-doubles.js";

/**
 * The hosted query-embedding runtime, driven entirely through a stubbed `fetch`, so every failure
 * mode is exercised without a network and without a credential.
 *
 * Three things are pinned here and nowhere else: the request is byte-for-byte the one Experiment C
 * measured, a vector that cannot query the stored space is refused rather than passed on, and no
 * credential and no provider body ever reaches a log line or an error message.
 */

/** Deliberately distinctive, so a test can assert it never escapes. */
const TOKEN = "hf_provider-test-token-never-real";

const MODEL = "intfloat/multilingual-e5-small";
const TIMEOUT_MS = 10_000;
const EXPECTED_URL = `${HUGGING_FACE_ENDPOINT_BASE}/${MODEL}/pipeline/feature-extraction`;

/** A body a provider could plausibly return and which must never be logged or forwarded. */
const SECRET_BODY = "internal-provider-trace-that-must-not-leak";

function normalizedVector(dimension: number = RAG_EMBEDDING_PROFILE.dimension): number[] {
  const value = 1 / Math.sqrt(dimension);
  return Array.from({ length: dimension }, () => value);
}

type Call = { url: string; init: RequestInit | undefined };

/**
 * A `fetch` stand-in that answers from a queue, so a retry can be given a different outcome than the
 * attempt before it. A queued function may reject, which is how transport failures are driven.
 */
function fetchQueue(responses: (() => Promise<Response>)[]): {
  fetchImplementation: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;

  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init });
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error("The provider made more requests than the test queued.");
    }
    return await next();
  }) as typeof fetch;

  return { fetchImplementation, calls };
}

function ok(body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

function status(code: number, body = SECRET_BODY): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status: code }));
}

function timeout(): () => Promise<Response> {
  return () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  };
}

function transportFailure(): () => Promise<Response> {
  return () => Promise.reject(new TypeError("fetch failed"));
}

function createProvider(responses: (() => Promise<Response>)[]): {
  provider: HuggingFaceQueryEmbeddingProvider;
  calls: Call[];
  logger: RecordingLogger;
  delays: number[];
} {
  const { fetchImplementation, calls } = fetchQueue(responses);
  const logger = createRecordingLogger();
  const delays: number[] = [];

  const provider = new HuggingFaceQueryEmbeddingProvider({
    token: TOKEN,
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    logger,
    fetchImplementation,
    delay: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });

  return { provider, calls, logger, delays };
}

/** The provider sends a serialized body; anything else is a defect this narrowing surfaces. */
function requestBody(call: Call | undefined): string {
  const body = call?.init?.body;
  return typeof body === "string" ? body : "";
}

async function failureOf(promise: Promise<unknown>): Promise<RagEmbeddingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RagEmbeddingError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the provider to fail.");
}

describe("HuggingFaceQueryEmbeddingProvider request", () => {
  it("calls the validated endpoint with the profile's query prefix and pooling flags", async () => {
    const { provider, calls } = createProvider([ok([normalizedVector()])]);

    await provider.embedQuery("Wie kann ich mich registrieren?");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPECTED_URL);
    expect(calls[0]?.init?.method).toBe("POST");

    // Byte-for-byte the request Experiment C measured. The prefix is taken from the frozen profile,
    // so the query side cannot drift away from the recipe the stored passages were embedded under.
    expect(JSON.parse(requestBody(calls[0]))).toEqual({
      inputs: "query: Wie kann ich mich registrieren?",
      normalize: true,
      truncate: true,
      truncation_direction: "right",
    });
  });

  it("sends the credential as a bearer header and in no other part of the request", async () => {
    const { provider, calls } = createProvider([ok([normalizedVector()])]);

    await provider.embedQuery("Frage");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(requestBody(calls[0])).not.toContain(TOKEN);
  });

  it("returns the vector and its measured norm for a well-formed depth-2 response", async () => {
    const { provider } = createProvider([ok([normalizedVector()])]);

    const result = await provider.embedQuery("Frage");

    expect(result.embedding).toHaveLength(RAG_EMBEDDING_PROFILE.dimension);
    expect(result.l2Norm).toBeCloseTo(1, 9);
  });

  it("accepts a bare depth-1 vector, which is the other shape that carries one pooled embedding", async () => {
    const { provider } = createProvider([ok(normalizedVector())]);

    const result = await provider.embedQuery("Frage");

    expect(result.embedding).toHaveLength(RAG_EMBEDDING_PROFILE.dimension);
  });

  it("makes exactly one request when the first attempt succeeds", async () => {
    const { provider, calls, delays } = createProvider([ok([normalizedVector()])]);

    await provider.embedQuery("Frage");

    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

describe("HuggingFaceQueryEmbeddingProvider response validation", () => {
  it.each([
    ["a wrong dimension", [normalizedVector(768)]],
    ["a NaN element", [[...normalizedVector().slice(1), Number.NaN]]],
    ["an Infinity element", [[...normalizedVector().slice(1), Number.POSITIVE_INFINITY]]],
    ["the zero vector", [new Array<number>(RAG_EMBEDDING_PROFILE.dimension).fill(0)]],
    ["an unnormalized vector", [new Array<number>(RAG_EMBEDDING_PROFILE.dimension).fill(0.5)]],
    ["token-level output", [[normalizedVector(), normalizedVector()]]],
    ["a batch of two embeddings", [normalizedVector(), normalizedVector()]],
    ["a non-numeric element", [["nicht eine Zahl", ...normalizedVector().slice(1)]]],
    ["an object instead of an array", { embedding: normalizedVector() }],
    ["an empty array", []],
  ])("refuses %s rather than querying the stored space with it", async (_label, body) => {
    const { provider } = createProvider([ok(body)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.code).toBe("RAG_EMBEDDING_INVALID_OUTPUT");
    expect(error.retryable).toBe(false);
  });

  it("refuses a 200 whose body is not JSON", async () => {
    const { provider } = createProvider([
      () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
    ]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.code).toBe("RAG_EMBEDDING_INVALID_OUTPUT");
  });

  it("does not retry an invalid payload, which would fail identically", async () => {
    const { provider, calls } = createProvider([ok([normalizedVector(768)])]);

    await failureOf(provider.embedQuery("Frage"));

    expect(calls).toHaveLength(1);
  });
});

describe("HuggingFaceQueryEmbeddingProvider error model", () => {
  it.each([401, 403])(
    "maps HTTP %i to a credential failure and does not retry it",
    async (code) => {
      const { provider, calls } = createProvider([status(code)]);

      const error = await failureOf(provider.embedQuery("Frage"));

      // A credential does not become valid 250 ms later.
      expect(error.code).toBe("RAG_EMBEDDING_PROVIDER_AUTH_FAILED");
      expect(error.retryable).toBe(false);
      expect(calls).toHaveLength(1);
    },
  );

  it("does not retry HTTP 400, which would be rejected identically", async () => {
    const { provider, calls } = createProvider([status(400)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.code).toBe("RAG_EMBEDDING_PROVIDER_REQUEST_FAILED");
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not retry HTTP 429, because an immediate second call makes a rate limit worse", async () => {
    const { provider, calls } = createProvider([status(429)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.code).toBe("RAG_EMBEDDING_PROVIDER_REQUEST_FAILED");
    // Retryable as an error-model fact — just not by this class, and not immediately.
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not retry an unexpected 4xx", async () => {
    const { provider, calls } = createProvider([status(404)]);

    await failureOf(provider.embedQuery("Frage"));

    expect(calls).toHaveLength(1);
  });

  it("fails without retrying when the transport fails for a reason other than a timeout", async () => {
    const { provider, calls } = createProvider([transportFailure()]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.code).toBe("RAG_EMBEDDING_PROVIDER_REQUEST_FAILED");
    expect(calls).toHaveLength(1);
  });

  it("never carries a provider response body in the thrown error", async () => {
    const { provider } = createProvider([status(500, SECRET_BODY)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    // A provider body can echo request content, which here is the caller's spoken question.
    expect(error.message).not.toContain(SECRET_BODY);
    expect(error.cause).toBeUndefined();
  });

  it("never carries the credential in the thrown error", async () => {
    const { provider } = createProvider([status(401, `token ${TOKEN} rejected`)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(error.message).not.toContain(TOKEN);
  });
});

describe("HuggingFaceQueryEmbeddingProvider retries", () => {
  it.each([500, 502, 503, 504])("retries HTTP %i exactly once", async (code) => {
    const { provider, calls, delays } = createProvider([status(code), status(code)]);

    const error = await failureOf(provider.embedQuery("Frage"));

    // Two attempts, never three: a second failure in a row is an outage, not a blip, and further
    // retries would only hold a voice call open while the same error accumulates.
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([250]);
    expect(error.code).toBe("RAG_EMBEDDING_PROVIDER_REQUEST_FAILED");
  });

  it("returns the vector when the retry succeeds", async () => {
    const { provider, calls } = createProvider([status(503), ok([normalizedVector()])]);

    const result = await provider.embedQuery("Frage");

    expect(result.embedding).toHaveLength(RAG_EMBEDDING_PROFILE.dimension);
    expect(calls).toHaveLength(2);
  });

  it("retries a timeout exactly once and reports the configured bound", async () => {
    const { provider, calls, delays } = createProvider([timeout(), timeout()]);

    const error = await failureOf(provider.embedQuery("Frage"));

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([250]);
    expect(error.message).toContain(String(TIMEOUT_MS));
  });

  it("bounds each attempt with its own timeout signal", async () => {
    const { provider, calls } = createProvider([timeout(), ok([normalizedVector()])]);

    await provider.embedQuery("Frage");

    // Otherwise the retry would inherit an already-aborted signal and fail instantly.
    expect(calls[0]?.init?.signal).not.toBe(calls[1]?.init?.signal);
    expect(calls[1]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("backs off before the retry rather than calling straight back", async () => {
    const { provider, delays } = createProvider([status(500), status(500)]);

    await failureOf(provider.embedQuery("Frage"));

    expect(delays).toEqual([250]);
  });
});

describe("HuggingFaceQueryEmbeddingProvider logging", () => {
  it("records a failed attempt as one structured entry with a closed error code", async () => {
    const { provider, logger } = createProvider([status(503), status(503)]);

    await failureOf(provider.embedQuery("Frage"));

    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[0]).toMatchObject({
      level: "warn",
      event: "rag_query_embedding_provider_failed",
      fields: { upstreamStatus: 503, errorCode: "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED" },
    });
    expect(typeof logger.entries[0]?.fields.upstreamLatencyMs).toBe("number");
  });

  it("never logs the credential, the endpoint, or the provider body", async () => {
    const { provider, logger } = createProvider([status(401, `bearer ${TOKEN}: ${SECRET_BODY}`)]);

    await failureOf(provider.embedQuery("Frage"));

    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Authorization");
    expect(logged).not.toContain(SECRET_BODY);
    expect(logged).not.toContain(HUGGING_FACE_ENDPOINT_BASE);
  });

  it("never logs the query or the vector", async () => {
    const { provider, logger } = createProvider([status(500), status(500)]);

    await failureOf(provider.embedQuery("Wie storniere ich meine Bestellung?"));

    // The question is caller-spoken text and the contract keeps personal data out of logs.
    expect(JSON.stringify(logger.entries)).not.toContain("storniere");
  });

  it("logs nothing on a successful embedding", async () => {
    const { provider, logger } = createProvider([ok([normalizedVector()])]);

    await provider.embedQuery("Frage");

    // The application service already logs the completed query; a second per-request line would be
    // noise on the only path that always runs.
    expect(logger.entries).toEqual([]);
  });
});

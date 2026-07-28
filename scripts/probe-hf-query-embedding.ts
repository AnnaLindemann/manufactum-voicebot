import "dotenv/config";

/**
 * Experiment A — Hugging Face query-embedding availability probe (Gate 3).
 *
 * Standalone and deliberately isolated. It imports no production retrieval code, opens no database
 * connection, constructs no provider abstraction, and writes no file. Its only job is to answer one
 * question that no amount of documentation reading can settle: does the current Hugging Face hosted
 * endpoint return a single, pooled, L2-normalized 384-dimensional vector for an E5 query input?
 *
 * Everything downstream of Gate 3 — the provider abstraction, the local/remote comparison, the frozen
 * 96-query evaluation — is contingent on that one observation, so this script exists to make it before
 * a single line of production code is touched.
 *
 * Scope note. The endpoint is `hf-inference`'s `feature-extraction` pipeline route. The model's
 * declared provider task is `sentence-similarity`, not `feature-extraction`; Hugging Face's own client
 * (`huggingface.js`, `providers/hf-inference.ts`) routes both through `models/{id}/pipeline/{task}` and
 * comments that the two "are automatically compatible with one another" on this provider. That is the
 * inference this probe is here to confirm or refute empirically.
 *
 * Safety. The token is read from the environment, used once as a bearer credential, and never printed.
 * Every line this script emits passes through `redact()`. The vector is summarised — first five and
 * last five elements — and never printed in full. Response bodies are summarised to a bounded length
 * and never dumped, because the observed unauthenticated 401 body is ~3 kB of CloudFront HTML and a
 * provider body can echo request content.
 */

/**
 * `[D]` The current router host. The legacy `api-inference.huggingface.co` hostname no longer resolves
 * in DNS, and the OpenAI-compatible `router.huggingface.co/v1` surface is chat-only — `POST /v1/embeddings`
 * returns 404. This pipeline route is the only path that serves this model.
 */
const ENDPOINT_BASE = "https://router.huggingface.co/hf-inference/models";

const DEFAULT_MODEL = "intfloat/multilingual-e5-small";

/**
 * `[D]` The exact input fixed by the experiment plan. It carries the `query: ` prefix of the active
 * embedding profile's `e5:query:v1` recipe, prepended here rather than requested through the API's
 * `prompt_name` parameter: that parameter requires a `prompts` dictionary in the repository's
 * `config_sentence_transformers.json`, and this model has no such file.
 */
const PROBE_QUERY = "query: Wie kann ich mich registrieren?";

/** The active embedding profile's dimension. A vector of any other width cannot query the stored space. */
const EXPECTED_DIMENSION = 384;

/**
 * `[D]` The same tolerance the local generator applies to its own output, so both providers are held to
 * one standard rather than the remote one being graded more leniently.
 */
const NORM_TOLERANCE = 0.001;

/** Below this a vector is degenerate: cosine similarity against it is undefined, not merely small. */
const ZERO_VECTOR_EPSILON = 1e-9;

/**
 * `[D]` Generous on purpose, and NOT a proposed production value. Hugging Face's own published latency
 * for this model is 5100 ms, and a first call may additionally pay a cold start. A probe that times out
 * before the endpoint answers would report "unavailable" for something that merely warms slowly, which
 * is the one wrong answer this script must not give.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Timing-only repeat calls, made after the validated call. Cold and warm latency are separate facts and
 * Gate 3's verdict distinguishes them: a 5 s cold start with sub-second warm calls is a very different
 * finding from a 5 s steady state. These calls validate nothing — cross-call repeatability is Gate 4.
 */
const WARM_CALL_COUNT = 3;

/** Bounded so a diagnostic stays a diagnostic and never becomes a body dump. */
const BODY_SUMMARY_LIMIT = 200;

/** Elements shown at each end of the vector. The full vector is never printed. */
const VECTOR_PREVIEW_COUNT = 5;

const REQUEST_BODY = {
  inputs: PROBE_QUERY,
  normalize: true,
  truncate: true,
  truncation_direction: "right",
} as const;

/** Headers worth recording: two are Gate 3 criteria, the third makes a support request possible. */
const REPORTED_HEADERS = [
  "x-repo-commit",
  "ratelimit",
  "ratelimit-policy",
  "x-request-id",
] as const;

type ProbeCall = {
  status: number;
  contentType: string;
  latencyMs: number;
  headers: Record<string, string | undefined>;
  bodyText: string;
  bodyBytes: number;
};

type Check = {
  label: string;
  passed: boolean;
  detail: string;
};

async function main(): Promise<void> {
  const token = requiredEnv("HF_TOKEN");
  const model = nonEmpty(process.env.HF_EMBEDDING_MODEL) ?? DEFAULT_MODEL;
  const url = `${ENDPOINT_BASE}/${model}/pipeline/feature-extraction`;

  heading("Experiment A — Hugging Face query-embedding availability probe (Gate 3)");
  line("model", model);
  line("endpoint", url);
  line("input", JSON.stringify(PROBE_QUERY));
  line("request body", JSON.stringify(REQUEST_BODY));
  line("token", `present (${String(token.length)} characters, value never printed)`);

  heading("1. Request");
  const call = await callEndpoint(url, token);
  if (call === null) {
    return;
  }

  line("HTTP status", String(call.status));
  line("Content-Type", call.contentType === "" ? "(absent)" : call.contentType);
  line("latency (cold)", `${String(call.latencyMs)} ms`);
  line("body size", `${String(call.bodyBytes)} bytes`);

  heading("2. Headers");
  for (const name of REPORTED_HEADERS) {
    const value = call.headers[name];
    line(name, value === undefined ? "ABSENT" : redact(value));
  }
  line(
    "X-Repo-Commit present",
    call.headers["x-repo-commit"] === undefined ? "NO — served revision is not observable" : "YES",
  );
  line(
    "RateLimit headers present",
    call.headers["ratelimit"] === undefined && call.headers["ratelimit-policy"] === undefined
      ? "NO"
      : "YES",
  );

  const parsed = parseJson(call.bodyText);

  if (call.status !== 200) {
    reportNonSuccess(call, parsed);
    verdict(false, "the endpoint did not return HTTP 200");
    return;
  }

  heading("3. Response shape");
  if (!parsed.ok) {
    line("JSON parse", `FAILED — ${parsed.reason}`);
    line("body summary", summariseBody(call));
    verdict(false, "the 200 response body was not valid JSON");
    return;
  }

  const depth = nestingDepth(parsed.value);
  line("nesting depth", String(depth));
  line("shape", describeShape(parsed.value));

  const unwrapped = unwrapEmbedding(parsed.value, depth);
  if (!unwrapped.ok) {
    line("unwrap", `FAILED — ${unwrapped.reason}`);
    diagnoseShape(parsed.value, depth);
    verdict(false, unwrapped.reason);
    return;
  }

  const vector = unwrapped.vector;
  line("embeddings returned", String(unwrapped.embeddingCount));

  heading("4. Vector");
  const finite = vector.every((value) => Number.isFinite(value));
  const l2Norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const minValue = vector.reduce(
    (min, value) => (value < min ? value : min),
    Number.POSITIVE_INFINITY,
  );
  const maxValue = vector.reduce(
    (max, value) => (value > max ? value : max),
    Number.NEGATIVE_INFINITY,
  );

  line("dimension", String(vector.length));
  line("L2 norm", finite ? l2Norm.toFixed(9) : "not computable (non-finite elements)");
  line("min value", finite ? minValue.toFixed(9) : "not computable");
  line("max value", finite ? maxValue.toFixed(9) : "not computable");
  line("all elements finite", finite ? "YES" : "NO");
  line("first five", preview(vector.slice(0, VECTOR_PREVIEW_COUNT)));
  line("last five", preview(vector.slice(-VECTOR_PREVIEW_COUNT)));

  heading("5. Validation");
  const checks = validate(unwrapped.embeddingCount, vector, finite, l2Norm);
  for (const check of checks) {
    console.log(`  [${check.passed ? "PASS" : "FAIL"}] ${check.label} — ${check.detail}`);
  }

  heading("6. Latency");
  line("cold call", `${String(call.latencyMs)} ms`);
  const warmLatencies = await measureWarmLatencies(url, token);
  line(
    "warm calls",
    warmLatencies.length === 0
      ? "none completed"
      : warmLatencies.map((value) => `${String(value)} ms`).join(", "),
  );
  if (warmLatencies.length > 0) {
    const slowest = warmLatencies.reduce((max, value) => (value > max ? value : max), 0);
    const total = warmLatencies.reduce((sum, value) => sum + value, 0);
    line("warm mean", `${String(Math.round(total / warmLatencies.length))} ms`);
    line("warm slowest", `${String(slowest)} ms`);
  }

  const failed = checks.filter((check) => !check.passed);
  verdict(failed.length === 0, failed.map((check) => check.label).join("; "));
}

function validate(
  embeddingCount: number,
  vector: readonly number[],
  finite: boolean,
  l2Norm: number,
): Check[] {
  const nonZero = finite && l2Norm > ZERO_VECTOR_EPSILON;
  const normalized = finite && Math.abs(l2Norm - 1) <= NORM_TOLERANCE;

  return [
    {
      label: "exactly one embedding",
      passed: embeddingCount === 1,
      detail: `received ${String(embeddingCount)}`,
    },
    {
      label: `dimension is ${String(EXPECTED_DIMENSION)}`,
      passed: vector.length === EXPECTED_DIMENSION,
      detail: `received ${String(vector.length)}`,
    },
    {
      label: "every element is a finite number",
      passed: finite,
      detail: finite ? "no NaN and no Infinity" : "at least one non-finite element",
    },
    {
      label: "vector is non-zero",
      passed: nonZero,
      detail: finite ? `L2 norm ${l2Norm.toFixed(9)}` : "not computable",
    },
    {
      label: `L2 norm within 1 ± ${String(NORM_TOLERANCE)}`,
      passed: normalized,
      detail: finite ? `deviation ${Math.abs(l2Norm - 1).toExponential(3)}` : "not computable",
    },
  ];
}

/** Returns `null` after reporting, when the request itself never produced a response. */
async function callEndpoint(url: string, token: string): Promise<ProbeCall | null> {
  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(REQUEST_BODY),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const name = error instanceof Error ? error.name : "UnknownError";
    line("HTTP status", "none — the request failed before a response arrived");
    line("failure", name === "TimeoutError" ? `timed out after ${String(latencyMs)} ms` : name);
    line("detail", redact(error instanceof Error ? error.message : "unknown transport failure"));
    verdict(false, name === "TimeoutError" ? "the request timed out" : "the request failed");
    return null;
  }

  const bodyText = await response.text();
  const latencyMs = Date.now() - startedAt;

  const headers: Record<string, string | undefined> = {};
  for (const name of REPORTED_HEADERS) {
    headers[name] = response.headers.get(name) ?? undefined;
  }

  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    latencyMs,
    headers,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
  };
}

/** Timing only. A failed warm call is recorded as skipped rather than failing the probe. */
async function measureWarmLatencies(url: string, token: string): Promise<number[]> {
  const latencies: number[] = [];
  for (let attempt = 0; attempt < WARM_CALL_COUNT; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.text();
      if (response.status === 200) {
        latencies.push(Date.now() - startedAt);
      }
    } catch {
      // Deliberately swallowed: this loop measures, it does not validate.
    }
  }
  return latencies;
}

function reportNonSuccess(call: ProbeCall, parsed: ParsedBody): void {
  heading("3. Non-success diagnostic");
  line("HTTP status", String(call.status));
  line("Content-Type", call.contentType === "" ? "(absent)" : call.contentType);
  line("body shape", parsed.ok ? describeShape(parsed.value) : `non-JSON (${parsed.reason})`);
  line("safe error summary", summariseBody(call));
  line("interpretation", interpretStatus(call));
}

function interpretStatus(call: ProbeCall): string {
  if (call.status === 401) {
    return call.contentType.includes("html")
      ? "401 with an HTML body — the credential did not reach the API layer at all."
      : "401 from the API layer — the token was rejected as invalid.";
  }
  if (call.status === 403) {
    return "403 — the token is valid but lacks the 'Make calls to Inference Providers' permission, or credits are exhausted.";
  }
  if (call.status === 404) {
    return "404 — the model or the pipeline route does not exist for this provider.";
  }
  if (call.status === 429) {
    return "429 — rate limited or out of monthly credits. Check the RateLimit headers above and the billing page.";
  }
  if (call.status === 503) {
    return "503 — the model is loading (cold start) or the provider is temporarily unavailable.";
  }
  if (call.status >= 500) {
    return `${String(call.status)} — provider-side failure.`;
  }
  return `Unexpected status ${String(call.status)}.`;
}

/**
 * A bounded, redacted summary. For JSON, only the conventional error fields are surfaced; for anything
 * else, the type and size are reported and the body itself is withheld.
 */
function summariseBody(call: ProbeCall): string {
  const parsed = parseJson(call.bodyText);

  if (!parsed.ok) {
    const kind = call.contentType.includes("html") ? "HTML" : "non-JSON";
    return `${kind} body withheld (${String(call.bodyBytes)} bytes)`;
  }

  const value = parsed.value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const field = record[key];
      if (typeof field === "string") {
        return redact(truncate(field));
      }
    }
    return `JSON object with keys: ${Object.keys(record).join(", ")}`;
  }

  return `JSON ${typeof value} body withheld (${String(call.bodyBytes)} bytes)`;
}

/** Detail printed only when the shape is not what the retrieval path can consume. */
function diagnoseShape(value: unknown, depth: number): void {
  heading("Shape diagnostic");
  line("observed depth", String(depth));
  line("observed shape", describeShape(value));
  line("expected", "number[] (depth 1), or number[][] with exactly one row (depth 2)");
  line(
    "depth 3 means",
    "token-level output — the sentence-transformers Pooling and Normalize modules were bypassed. " +
      "Client-side pooling is NOT an acceptable workaround: it would be a second, unproven pooling " +
      "implementation sitting between the query and a vector space built by the first one.",
  );
  if (Array.isArray(value)) {
    line("outer length", String(value.length));
    const first: unknown = value[0];
    if (Array.isArray(first)) {
      line("inner length", String(first.length));
    }
  }
}

type ParsedBody = { ok: true; value: unknown } | { ok: false; reason: string };

function parseJson(text: string): ParsedBody {
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty body" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "parse failure" };
  }
}

type Unwrapped =
  { ok: true; vector: number[]; embeddingCount: number } | { ok: false; reason: string };

/**
 * Accepts the two shapes that carry one pooled sentence embedding and rejects everything else. It
 * deliberately does not flatten deeper nesting: a depth-3 response is a different kind of output, not a
 * differently packaged one, and silently flattening it would hide exactly the failure worth catching.
 */
function unwrapEmbedding(value: unknown, depth: number): Unwrapped {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `response is ${typeof value}, expected an array` };
  }

  if (depth === 1) {
    const vector = value.filter((element): element is number => typeof element === "number");
    if (vector.length !== value.length) {
      return { ok: false, reason: "depth-1 array contains non-numeric elements" };
    }
    return { ok: true, vector, embeddingCount: 1 };
  }

  if (depth === 2) {
    if (value.length !== 1) {
      return {
        ok: false,
        reason: `depth-2 array holds ${String(value.length)} embeddings, expected exactly 1`,
      };
    }
    const first: unknown = value[0];
    if (!Array.isArray(first)) {
      return { ok: false, reason: "depth-2 array row is not an array" };
    }
    const vector = first.filter((element): element is number => typeof element === "number");
    if (vector.length !== first.length) {
      return { ok: false, reason: "embedding row contains non-numeric elements" };
    }
    return { ok: true, vector, embeddingCount: 1 };
  }

  return {
    ok: false,
    reason: `unexpected nesting depth ${String(depth)} — token-level or batched output, not one pooled embedding`,
  };
}

function nestingDepth(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  const first: unknown = value[0];
  return 1 + nestingDepth(first);
}

function describeShape(value: unknown): string {
  if (!Array.isArray(value)) {
    return value === null ? "null" : typeof value;
  }
  const first: unknown = value[0];
  return `array[${String(value.length)}] of ${describeShape(first)}`;
}

function preview(values: readonly number[]): string {
  return `[${values.map((value) => value.toFixed(6)).join(", ")}]`;
}

function verdict(passed: boolean, reason: string): void {
  heading("Verdict");
  console.log(`  ${passed ? "PASS" : "FAIL"}`);
  if (!passed && reason.length > 0) {
    console.log(`  reason: ${redact(reason)}`);
  }
  if (!passed) {
    process.exitCode = 1;
  }
}

function heading(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${redact(value)}`);
}

/**
 * Last line of defence. Every printed string passes through here, so a credential that reached a
 * message by an unforeseen route — a provider echoing the Authorization header, a transport error
 * quoting the request — is masked rather than written to the terminal.
 */
function redact(text: string): string {
  const token = process.env.HF_TOKEN?.trim();
  const masked =
    token !== undefined && token.length > 0 ? text.split(token).join("[REDACTED]") : text;
  return masked.replace(/hf_[A-Za-z0-9]{8,}/g, "[REDACTED]");
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= BODY_SUMMARY_LIMIT
    ? collapsed
    : `${collapsed.slice(0, BODY_SUMMARY_LIMIT)}… (truncated)`;
}

function requiredEnv(name: string): string {
  const value = nonEmpty(process.env[name]);
  if (value === undefined) {
    console.error(
      `${name} must be set to run the Hugging Face availability probe.\n` +
        "Create a fine-grained token with the 'Make calls to Inference Providers' permission at\n" +
        "https://huggingface.co/settings/tokens and put it in .env as HF_TOKEN=…\n" +
        "The value is never printed by this script and .env is git-ignored.",
    );
    process.exit(1);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

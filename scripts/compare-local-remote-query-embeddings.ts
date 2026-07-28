import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
  RAG_RETRIEVAL_MAX_CHUNKS,
} from "../src/config/rag-retrieval-config.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";

/**
 * Experiment B — local vs remote query embedding comparison (Gate 4).
 *
 * Experiment A (`scripts/probe-hf-query-embedding.ts`) established that the Hugging Face hosted
 * endpoint answers with a single, pooled, L2-normalized 384-dimensional vector. That says the remote
 * vector is *well formed*. It says nothing about whether it is the *same* vector space as the one the
 * stored passage embeddings live in, and geometry alone would not settle that either: two vectors can
 * be 0.99 similar and still rank a twelve-chunk corpus differently.
 *
 * So this script asks the only question that matters for retrieval: **fed into the existing retrieval
 * SQL against the existing frozen passage embeddings, does the remote query vector return the same
 * chunks, in the same order, on the same side of the same threshold, as the local one?**
 *
 * It is a measurement, not a migration.
 *
 * - It builds no provider abstraction. The remote call is a local function in this file; nothing in
 *   `src/` is touched, and no code here is meant to survive into production.
 * - It changes nothing about the retrieval space. The SQL passage-embedding filter always binds the
 *   frozen `RAG_EMBEDDING_PROFILE` identity. The Hugging Face model, revision, provider, and dtype
 *   never enter that filter — the remote vector is a *query* against the local space, and treating it
 *   as anything else would compare the local space against nothing at all.
 * - It uses the production retrieval path (`PostgresRagDocumentStore.searchRelevantChunks`) with the
 *   production `maxChunks` and threshold, rather than a second ranking query written for this script,
 *   so a disagreement found here is a disagreement production would have had.
 *
 * Labels are read, never authored. The queries are named by fixture id; their text and their expected
 * chunk key are resolved at run time from the frozen development dataset and the accepted baseline
 * evidence→chunk mapping. This file therefore cannot silently relabel the sample.
 *
 * Safety. The database session is read-only and asserted to be so before any read. No file is
 * written. The token is read from `.env`, used once as a bearer credential, and never printed —
 * every emitted line passes through `redact()`. Vectors are summarised numerically and never printed.
 * Provider bodies are never dumped.
 */

/** The router host and route proven reachable by Experiment A. Unchanged here on purpose. */
const ENDPOINT_BASE = "https://router.huggingface.co/hf-inference/models";

/**
 * `[D]` The upstream `intfloat` repository, not the `Xenova` ONNX mirror the local profile pins. That
 * asymmetry is the *subject* of the experiment, not an oversight: the hosted endpoint serves the
 * original float weights, the local runtime serves an int8 ONNX export of them, and the whole point is
 * to measure what that difference does to retrieval.
 */
const REMOTE_MODEL = "intfloat/multilingual-e5-small";

/** Repeat calls per query. Fixed by the experiment plan; repeatability is this gate's own question. */
const REMOTE_CALL_COUNT = 3;

/** As in Experiment A: generous enough that a slow warm-up is never misreported as unavailability. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The tolerance the local generator already applies to itself, so both providers are graded alike. */
const NORM_TOLERANCE = 0.001;

/** Below this a vector is degenerate: cosine similarity against it is undefined, not merely small. */
const ZERO_VECTOR_EPSILON = 1e-9;

/** Bounded so a diagnostic stays a diagnostic and never becomes a body dump. */
const BODY_SUMMARY_LIMIT = 200;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const DATASET_PATH = "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json";

/**
 * `[D]` The accepted baseline mapping is the only sanctioned evidence→chunk translation. The frozen
 * dataset labels an *evidence id*; the retrieval path returns a *chunk key*. Deriving the bridge here
 * — by intent name, by chunk index, by anything — would be inventing a label. It is read instead.
 */
const MAPPING_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json";

const SMOKE_PROBE_SOURCE = "scripts/smoke-rag-retrieval.ts";

/**
 * `[D]` Ten labelled records from the frozen 96-query development dataset, chosen to cover every query
 * shape the plan names — exact, paraphrased, short, conversational, and two hard negatives — with two
 * intents (`chunk-001`/`chunk-006`/`chunk-011`) deliberately reached from more than one query shape, so
 * a divergence can be attributed to the query form rather than to one unlucky sentence.
 *
 * Only the ids are fixed here. The query text and the expected chunk key are resolved from the frozen
 * fixtures at run time.
 */
const DATASET_FIXTURE_IDS = [
  "mein-konto-v1-dev-001",
  "mein-konto-v1-dev-006",
  "mein-konto-v1-dev-013",
  "mein-konto-v1-dev-034",
  "mein-konto-v1-dev-041",
  "mein-konto-v1-dev-047",
  "mein-konto-v1-dev-054",
  "mein-konto-v1-dev-057",
  "mein-konto-v1-dev-079",
  "mein-konto-v1-dev-090",
] as const;

/**
 * `[D]` Two queries carried over verbatim from the existing retrieval smoke probe. They appear in
 * neither labelled dataset, so they carry **no** expected chunk key: writing one would be exactly the
 * invented label the plan forbids. They still earn their place — they are the two sentences the
 * project has actually been running against this database — but they contribute only to local↔remote
 * agreement, never to expected-Top-1 correctness.
 */
const SMOKE_PROBES = [
  { id: "smoke-exact", queryType: "exact", query: "Wie kann ich mich registrieren?" },
  { id: "smoke-irrelevant", queryType: "irrelevant", query: "Wie repariere ich eine Kaffeemühle?" },
] as const;

type Answerability = "answerable" | "unanswerable" | "unlabelled";

type ExperimentQuery = {
  id: string;
  sourceFixture: string;
  queryType: string;
  answerability: Answerability;
  query: string;
  expectedChunkKey: string | null;
};

type DatasetRecord = {
  id: string;
  query: string;
  queryType: string;
  answerability: string;
  expectedEvidenceId: string | null;
};

type EvidenceMapping = { evidenceId: string; fullCoverageChunkKeys: string[] };

type RankedChunk = { chunkKey: string; score: number };

type Retrieval = {
  ranking: RankedChunk[];
  accepted: boolean;
  acceptedChunkKeys: string[];
};

type RemoteAttempt =
  | { ok: true; vector: number[]; l2Norm: number; latencyMs: number }
  | { ok: false; reason: string; latencyMs: number };

type QueryOutcome = {
  spec: ExperimentQuery;
  cosine: number;
  localNorm: number;
  remoteNorm: number;
  localLatencyMs: number;
  remoteLatenciesMs: number[];
  bitIdentical: boolean;
  maxRepeatElementDelta: number;
  repeatRankingIdentical: boolean;
  local: Retrieval;
  remote: Retrieval;
  remoteRepeats: Retrieval[];
  chunkDeltas: { chunkKey: string; localScore: number | null; remoteScore: number | null }[];
  topOneAgrees: boolean;
  acceptAgrees: boolean;
  /** Same chunks in the same order, all the way down the returned Top-k. */
  rankingIdentical: boolean;
  /** Same chunks in the returned Top-k, order aside. */
  chunkSetIdentical: boolean;
};

async function main(): Promise<void> {
  const token = requiredEnv(
    "HF_TOKEN",
    "Create a fine-grained token with the 'Make calls to Inference Providers' permission at\n" +
      "https://huggingface.co/settings/tokens and put it in .env as HF_TOKEN=…\n" +
      "The value is never printed by this script and .env is git-ignored.",
  );
  const connectionString = requiredEnv(
    "DATABASE_URL",
    "Point it at the database holding the active mein-konto v1 chunks and their frozen embeddings.\n" +
      "This experiment only reads; the session is set read-only before the first query.",
  );
  const url = `${ENDPOINT_BASE}/${REMOTE_MODEL}/pipeline/feature-extraction`;

  heading("Experiment B — local vs remote query embedding comparison (Gate 4)");
  line("local profile id", RAG_EMBEDDING_PROFILE.id);
  line("local model", `${RAG_EMBEDDING_PROFILE.modelId}@${RAG_EMBEDDING_PROFILE.modelRevision}`);
  line("local artifact", `${RAG_EMBEDDING_PROFILE.artifact} (${RAG_EMBEDDING_PROFILE.dtype})`);
  line("local query prefix", JSON.stringify(RAG_EMBEDDING_PROFILE.queryPrefix));
  line("remote endpoint", url);
  line("remote model", REMOTE_MODEL);
  line("SQL profile filter", `${RAG_EMBEDDING_PROFILE.id} (frozen, never the remote identity)`);
  line("maxChunks", String(RAG_RETRIEVAL_MAX_CHUNKS));
  line("threshold (minScore)", DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2));
  line("remote calls per query", String(REMOTE_CALL_COUNT));
  line("HF_TOKEN", `present (${String(token.length)} characters, value never printed)`);

  const queries = await loadQueries();

  heading("1. Query set");
  line("dataset fixture", DATASET_PATH);
  line("evidence→chunk mapping", MAPPING_PATH);
  line("smoke probe fixture", SMOKE_PROBE_SOURCE);
  console.log("");
  console.log(
    `  ${"fixture id".padEnd(24)} ${"type".padEnd(15)} ${"answerability".padEnd(13)} ${"expected chunk".padEnd(23)} query`,
  );
  for (const spec of queries) {
    console.log(
      `  ${spec.id.padEnd(24)} ${spec.queryType.padEnd(15)} ${spec.answerability.padEnd(13)} ` +
        `${(spec.expectedChunkKey ?? "— (unlabelled)").padEnd(23)} ${redact(spec.query)}`,
    );
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const outcomes: QueryOutcome[] = [];
  try {
    await assertReadOnlySession(pool);
    const store = new PostgresRagDocumentStore(pool);
    const generator = buildLocalGenerator();
    await assertStoredCorpus(pool);

    heading("2. Per-query comparison");
    for (const spec of queries) {
      const outcome = await compareQuery(pool, store, generator, url, token, spec);
      if (outcome === null) {
        verdict("INCONCLUSIVE", [`query ${spec.id} could not be compared`]);
        return;
      }
      outcomes.push(outcome);
      reportQuery(outcome);
    }
  } finally {
    await pool.end();
  }

  reportSummary(outcomes);
  reportVerdict(outcomes);
}

// ---------------------------------------------------------------------------------------------
// Query set
// ---------------------------------------------------------------------------------------------

async function loadQueries(): Promise<ExperimentQuery[]> {
  const dataset = parseDataset(await readJson(DATASET_PATH));
  const mappings = parseEvidenceMappings(await readJson(MAPPING_PATH));

  const queries: ExperimentQuery[] = DATASET_FIXTURE_IDS.map((id) => {
    const record = dataset.find((item) => item.id === id);
    if (record === undefined) {
      throw new Error(`Fixture ${id} is not present in ${DATASET_PATH}.`);
    }
    return {
      id: record.id,
      sourceFixture: DATASET_PATH,
      queryType: record.queryType,
      answerability: record.answerability === "answerable" ? "answerable" : "unanswerable",
      query: record.query,
      expectedChunkKey: expectedChunkKey(record, mappings),
    };
  });

  for (const probe of SMOKE_PROBES) {
    queries.push({
      id: probe.id,
      sourceFixture: SMOKE_PROBE_SOURCE,
      queryType: probe.queryType,
      answerability: "unlabelled",
      query: probe.query,
      expectedChunkKey: null,
    });
  }

  return queries;
}

/**
 * An answerable record's expected chunk key is the single fully covering chunk recorded for its
 * expected evidence unit. A mapping that covers no chunk, or more than one, is not silently collapsed:
 * it would mean the sample is being scored against something the accepted mapping does not actually
 * say.
 */
function expectedChunkKey(record: DatasetRecord, mappings: EvidenceMapping[]): string | null {
  if (record.expectedEvidenceId === null) {
    return null;
  }
  const mapping = mappings.find((item) => item.evidenceId === record.expectedEvidenceId);
  if (mapping === undefined) {
    throw new Error(`Evidence ${record.expectedEvidenceId} has no entry in ${MAPPING_PATH}.`);
  }
  const chunkKeys = mapping.fullCoverageChunkKeys;
  const first = chunkKeys[0];
  if (chunkKeys.length !== 1 || first === undefined) {
    throw new Error(
      `Evidence ${record.expectedEvidenceId} maps to ${String(chunkKeys.length)} fully covering chunks; ` +
        "this experiment scores Top-1 against exactly one.",
    );
  }
  return first;
}

async function readJson(relativePath: string): Promise<unknown> {
  const text = await readFile(path.join(REPO_ROOT, relativePath), "utf8");
  return JSON.parse(text) as unknown;
}

function parseDataset(value: unknown): DatasetRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`${DATASET_PATH} is not an array of records.`);
  }
  return value.map((item, index) => {
    const record = item as Partial<DatasetRecord>;
    if (
      typeof record.id !== "string" ||
      typeof record.query !== "string" ||
      typeof record.queryType !== "string" ||
      typeof record.answerability !== "string"
    ) {
      throw new Error(`${DATASET_PATH} record ${String(index)} is missing required fields.`);
    }
    const evidenceId = record.expectedEvidenceId;
    if (evidenceId !== null && typeof evidenceId !== "string") {
      throw new Error(`${DATASET_PATH} record ${record.id} has a malformed expectedEvidenceId.`);
    }
    return {
      id: record.id,
      query: record.query,
      queryType: record.queryType,
      answerability: record.answerability,
      expectedEvidenceId: evidenceId,
    };
  });
}

function parseEvidenceMappings(value: unknown): EvidenceMapping[] {
  const mappings = (value as { evidenceMappings?: unknown }).evidenceMappings;
  if (!Array.isArray(mappings)) {
    throw new Error(`${MAPPING_PATH} has no evidenceMappings array.`);
  }
  return mappings.map((item, index) => {
    const mapping = item as Partial<EvidenceMapping>;
    if (typeof mapping.evidenceId !== "string" || !Array.isArray(mapping.fullCoverageChunkKeys)) {
      throw new Error(`${MAPPING_PATH} mapping ${String(index)} is malformed.`);
    }
    const chunkKeys = mapping.fullCoverageChunkKeys.filter(
      (key): key is string => typeof key === "string",
    );
    if (chunkKeys.length !== mapping.fullCoverageChunkKeys.length) {
      throw new Error(`${MAPPING_PATH} mapping ${mapping.evidenceId} has non-string chunk keys.`);
    }
    return { evidenceId: mapping.evidenceId, fullCoverageChunkKeys: chunkKeys };
  });
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/** Returns `null` after reporting, when this query could not be compared at all. */
async function compareQuery(
  pool: pg.Pool,
  store: PostgresRagDocumentStore,
  generator: TransformersE5SmallPassageEmbeddingGenerator,
  url: string,
  token: string,
  spec: ExperimentQuery,
): Promise<QueryOutcome | null> {
  let localVector: number[];
  let localNorm: number;
  let localLatencyMs: number;
  try {
    const startedAt = Date.now();
    const local = await generator.embedQuery(spec.query);
    localLatencyMs = Date.now() - startedAt;
    localVector = local.embedding;
    localNorm = local.l2Norm;
  } catch (error) {
    reportFailure(spec, "local embedding failed", describeError(error));
    return null;
  }

  const attempts: RemoteAttempt[] = [];
  for (let call = 0; call < REMOTE_CALL_COUNT; call += 1) {
    attempts.push(await callRemote(url, token, spec.query));
  }

  const failed = attempts.find((attempt) => !attempt.ok);
  if (failed !== undefined && !failed.ok) {
    reportFailure(spec, "remote embedding failed", failed.reason);
    return null;
  }
  const succeeded = attempts.filter(
    (attempt): attempt is Extract<RemoteAttempt, { ok: true }> => attempt.ok,
  );
  const primary = succeeded[0];
  if (primary === undefined) {
    reportFailure(spec, "remote embedding failed", "no successful call");
    return null;
  }

  let local: Retrieval;
  let remoteRepeats: Retrieval[];
  try {
    local = await retrieve(pool, store, localVector);
    remoteRepeats = [];
    for (const attempt of succeeded) {
      remoteRepeats.push(await retrieve(pool, store, attempt.vector));
    }
  } catch (error) {
    reportFailure(spec, "retrieval failed", describeError(error));
    return null;
  }

  const remote = remoteRepeats[0];
  if (remote === undefined) {
    reportFailure(spec, "retrieval failed", "no remote retrieval result");
    return null;
  }

  return {
    spec,
    cosine: cosineSimilarity(localVector, primary.vector),
    localNorm,
    remoteNorm: primary.l2Norm,
    localLatencyMs,
    remoteLatenciesMs: succeeded.map((attempt) => attempt.latencyMs),
    bitIdentical: succeeded.every((attempt) => vectorsEqual(attempt.vector, primary.vector)),
    maxRepeatElementDelta: succeeded.reduce(
      (max, attempt) => Math.max(max, maxAbsoluteDelta(attempt.vector, primary.vector)),
      0,
    ),
    repeatRankingIdentical: remoteRepeats.every(
      (repeat) => rankingSignature(repeat) === rankingSignature(remote),
    ),
    local,
    remote,
    remoteRepeats,
    chunkDeltas: chunkDeltas(local, remote),
    topOneAgrees: topChunkKey(local) === topChunkKey(remote),
    acceptAgrees: local.accepted === remote.accepted,
    // Tracked below Top-1 on purpose. At `maxChunks = 3` the whole returned list is the context an
    // answer would be grounded in, so a rank-2/3 reordering — and much more so a rank-3 membership
    // change — is a real behavioural difference that a Top-1-only comparison would hide.
    rankingIdentical: chunkKeys(local).join(">") === chunkKeys(remote).join(">"),
    chunkSetIdentical:
      [...chunkKeys(local)].sort().join(",") === [...chunkKeys(remote)].sort().join(","),
  };
}

/**
 * The production retrieval path, unchanged: the same store, the same SQL, the same `maxChunks`, and a
 * passage-embedding filter bound to the frozen profile. Only the query vector varies between the local
 * and the remote run — which is the entire experiment.
 *
 * `retrieveRelevantChunks` is deliberately not called: it drops everything below the threshold, and
 * this comparison needs the ranking *and* the accept decision, not the accept decision alone. The
 * threshold is therefore applied here with the same `>=` comparison it uses.
 */
async function retrieve(
  pool: pg.Pool,
  store: PostgresRagDocumentStore,
  queryEmbedding: number[],
): Promise<Retrieval> {
  await setReadOnlySession(pool);
  const results = await store.searchRelevantChunks({
    queryEmbedding,
    model: embeddingProfileModelRef(),
    maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
  });
  const ranking = results.map((result) => ({ chunkKey: result.chunkKey, score: result.score }));
  const acceptedChunkKeys = ranking
    .filter((chunk) => chunk.score >= DEFAULT_RAG_RETRIEVAL_MIN_SCORE)
    .map((chunk) => chunk.chunkKey);
  return { ranking, accepted: acceptedChunkKeys.length > 0, acceptedChunkKeys };
}

function chunkDeltas(local: Retrieval, remote: Retrieval): QueryOutcome["chunkDeltas"] {
  const keys = [
    ...new Set([
      ...local.ranking.map((chunk) => chunk.chunkKey),
      ...remote.ranking.map((chunk) => chunk.chunkKey),
    ]),
  ];
  return keys.map((chunkKey) => ({
    chunkKey,
    localScore: local.ranking.find((chunk) => chunk.chunkKey === chunkKey)?.score ?? null,
    remoteScore: remote.ranking.find((chunk) => chunk.chunkKey === chunkKey)?.score ?? null,
  }));
}

function chunkKeys(retrieval: Retrieval): string[] {
  return retrieval.ranking.map((chunk) => chunk.chunkKey);
}

function rankingSignature(retrieval: Retrieval): string {
  return `${retrieval.ranking.map((chunk) => chunk.chunkKey).join(">")}|${String(retrieval.accepted)}`;
}

function topChunkKey(retrieval: Retrieval): string | null {
  return retrieval.ranking[0]?.chunkKey ?? null;
}

// ---------------------------------------------------------------------------------------------
// Remote provider
// ---------------------------------------------------------------------------------------------

/**
 * One remote embedding call, validated to the same standard the local generator holds itself to. Every
 * failure mode the plan names — transport, timeout, 401/403/429/5xx, invalid JSON, unexpected shape,
 * wrong dimension, non-finite value, zero vector — resolves to a short reason string here; none of them
 * reaches the caller as an exception, and none of them carries a provider body.
 */
async function callRemote(url: string, token: string, query: string): Promise<RemoteAttempt> {
  const body = JSON.stringify({
    // The prefix comes from the frozen profile rather than a literal, so the two sides cannot drift
    // apart through an edit to one of them.
    inputs: `${RAG_EMBEDDING_PROFILE.queryPrefix}${query}`,
    normalize: true,
    truncate: true,
    truncation_direction: "right",
  });

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const name = error instanceof Error ? error.name : "UnknownError";
    return {
      ok: false,
      latencyMs,
      reason:
        name === "TimeoutError"
          ? `request timed out after ${String(latencyMs)} ms`
          : `transport failure (${name})`,
    };
  }

  const text = await response.text();
  const latencyMs = Date.now() - startedAt;

  if (response.status !== 200) {
    return {
      ok: false,
      latencyMs,
      reason: `HTTP ${String(response.status)} — ${interpretStatus(response.status)} [${summariseBody(text, response.headers.get("content-type") ?? "")}]`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, latencyMs, reason: "HTTP 200 body was not valid JSON" };
  }

  const unwrapped = unwrapEmbedding(parsed);
  if (!unwrapped.ok) {
    return { ok: false, latencyMs, reason: unwrapped.reason };
  }

  const vector = unwrapped.vector;
  if (vector.length !== RAG_EMBEDDING_PROFILE.dimension) {
    return {
      ok: false,
      latencyMs,
      reason: `dimension ${String(vector.length)}, expected ${String(RAG_EMBEDDING_PROFILE.dimension)}`,
    };
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    return { ok: false, latencyMs, reason: "vector contains NaN or Infinity" };
  }
  const l2Norm = vectorNorm(vector);
  if (l2Norm <= ZERO_VECTOR_EPSILON) {
    return { ok: false, latencyMs, reason: "vector is the zero vector" };
  }
  if (Math.abs(l2Norm - 1) > NORM_TOLERANCE) {
    return {
      ok: false,
      latencyMs,
      reason: `L2 norm ${l2Norm.toFixed(9)} is outside 1 ± ${String(NORM_TOLERANCE)}`,
    };
  }

  return { ok: true, vector, l2Norm, latencyMs };
}

type Unwrapped = { ok: true; vector: number[] } | { ok: false; reason: string };

/**
 * Accepts only the two shapes that carry exactly one pooled sentence embedding. Deeper nesting is
 * token-level output and is rejected rather than pooled here: client-side pooling would be a second,
 * unproven pooling implementation sitting between the query and a space built by the first one.
 */
function unwrapEmbedding(value: unknown): Unwrapped {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `response is ${typeof value}, expected an array` };
  }
  const depth = nestingDepth(value);
  if (depth === 1) {
    const vector = value.filter((element): element is number => typeof element === "number");
    if (vector.length !== value.length) {
      return { ok: false, reason: "depth-1 array contains non-numeric elements" };
    }
    return { ok: true, vector };
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
    return { ok: true, vector };
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

function interpretStatus(status: number): string {
  if (status === 401) {
    return "the token was rejected";
  }
  if (status === 403) {
    return "the token lacks the Inference Providers permission, or credits are exhausted";
  }
  if (status === 404) {
    return "the model or the pipeline route does not exist for this provider";
  }
  if (status === 429) {
    return "rate limited or out of monthly credits";
  }
  if (status === 503) {
    return "the model is loading, or the provider is temporarily unavailable";
  }
  if (status >= 500) {
    return "provider-side failure";
  }
  return "unexpected status";
}

/** Bounded, redacted, and never a raw body: a provider error can echo request content. */
function summariseBody(text: string, contentType: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const kind = contentType.includes("html") ? "HTML" : "non-JSON";
    return `${kind} body withheld (${String(Buffer.byteLength(text, "utf8"))} bytes)`;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const field = record[key];
      if (typeof field === "string") {
        return truncate(field);
      }
    }
    return `JSON object with keys: ${Object.keys(record).join(", ")}`;
  }
  return "JSON body withheld";
}

// ---------------------------------------------------------------------------------------------
// Local provider and database
// ---------------------------------------------------------------------------------------------

/** Exactly the construction the retrieval smoke probe and the query service already use. */
function buildLocalGenerator(): TransformersE5SmallPassageEmbeddingGenerator {
  const cacheDir = nonEmpty(process.env.TRANSFORMERS_CACHE);
  return new TransformersE5SmallPassageEmbeddingGenerator({
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
    ...(cacheDir === undefined ? {} : { cacheDir }),
  });
}

/**
 * `[D]` Read-only is enforced by the *server*, not by the discipline of this file. The pool is capped
 * at one connection so the session setting cannot be applied to a connection other than the one the
 * reads run on, and it is re-applied before every read because `pg` discards a client that errored and
 * replaces it with a fresh — and therefore writable — session.
 */
async function setReadOnlySession(pool: pg.Pool): Promise<void> {
  await pool.query("SET SESSION default_transaction_read_only = on");
}

async function assertReadOnlySession(pool: pg.Pool): Promise<void> {
  await setReadOnlySession(pool);
  const result = await pool.query<{ read_only: string }>(
    "SELECT current_setting('transaction_read_only') AS read_only",
  );
  if (result.rows[0]?.read_only !== "on") {
    throw new Error("Refusing to run: the database session is not read-only.");
  }
}

/** Reports the corpus the comparison actually ran against, rather than assuming the expected twelve. */
async function assertStoredCorpus(pool: pg.Pool): Promise<void> {
  await setReadOnlySession(pool);
  const model = embeddingProfileModelRef();
  const result = await pool.query<{ chunks: number; embeddings: number }>(
    `SELECT (SELECT count(*)::int
               FROM rag_chunks c
               JOIN rag_documents d
                 ON d.document_key = c.document_key AND d.current_version = c.document_version) AS chunks,
            (SELECT count(*)::int
               FROM rag_chunk_embeddings e
               JOIN rag_documents d
                 ON d.document_key = e.document_key AND d.current_version = e.document_version
              WHERE e.embedding_provider = $1 AND e.embedding_model = $2
                AND e.embedding_model_version = $3 AND e.embedding_artifact = $4
                AND e.embedding_dtype = $5 AND e.embedding_runtime = $6
                AND e.embedding_profile_id = $7) AS embeddings`,
    [
      model.embeddingProvider,
      model.embeddingModel,
      model.embeddingModelVersion,
      model.embeddingArtifact,
      model.embeddingDtype,
      model.embeddingRuntime,
      model.embeddingProfileId,
    ],
  );
  const row = result.rows[0];
  line("active chunks", String(row?.chunks ?? 0));
  line("frozen embeddings", `${String(row?.embeddings ?? 0)} under the active profile`);
  if (row === undefined || row.embeddings === 0) {
    throw new Error("Refusing to run: no stored embeddings exist for the frozen profile.");
  }
}

// ---------------------------------------------------------------------------------------------
// Vector maths
// ---------------------------------------------------------------------------------------------

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  // Computed from the dot product and both norms rather than assuming normalization: the norms are
  // themselves an observation of this experiment, not a premise of it.
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  return dot / (vectorNorm(a) * vectorNorm(b));
}

function vectorsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function maxAbsoluteDelta(a: readonly number[], b: readonly number[]): number {
  return a.reduce((max, value, index) => Math.max(max, Math.abs(value - (b[index] ?? 0))), 0);
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

function reportQuery(outcome: QueryOutcome): void {
  const { spec } = outcome;
  console.log("");
  console.log(`  ${spec.id} — ${spec.queryType} (${spec.sourceFixture})`);
  console.log(`    query                     ${redact(spec.query)}`);
  console.log(
    `    expected chunk            ${spec.expectedChunkKey ?? "— (unlabelled; excluded from expected-Top-1)"}`,
  );
  console.log(
    `    dimension                 local ${String(RAG_EMBEDDING_PROFILE.dimension)}, remote ${String(RAG_EMBEDDING_PROFILE.dimension)}`,
  );
  console.log(
    `    L2 norm                   local ${outcome.localNorm.toFixed(9)}, remote ${outcome.remoteNorm.toFixed(9)}`,
  );
  console.log(`    local↔remote cosine       ${outcome.cosine.toFixed(9)}`);
  console.log(
    `    remote repeatability      bit-identical across ${String(REMOTE_CALL_COUNT)} calls: ${yesNo(outcome.bitIdentical)}; ` +
      `max |Δ| ${outcome.maxRepeatElementDelta.toExponential(3)}; ranking identical: ${yesNo(outcome.repeatRankingIdentical)}`,
  );
  console.log(
    `    latency                   local ${String(outcome.localLatencyMs)} ms; remote ${outcome.remoteLatenciesMs.map((value) => `${String(value)} ms`).join(", ")}; ` +
      `remote mean ${String(Math.round(mean(outcome.remoteLatenciesMs)))} ms`,
  );

  console.log(`    ranking (maxChunks ${String(RAG_RETRIEVAL_MAX_CHUNKS)})`);
  console.log(
    `      ${"rank".padEnd(6)} ${"local chunk".padEnd(23)} ${"raw".padEnd(20)} ${"rounded".padEnd(10)} ` +
      `${"remote chunk".padEnd(23)} ${"raw".padEnd(20)} rounded`,
  );
  const rows = Math.max(outcome.local.ranking.length, outcome.remote.ranking.length);
  for (let index = 0; index < rows; index += 1) {
    const localChunk = outcome.local.ranking[index];
    const remoteChunk = outcome.remote.ranking[index];
    console.log(
      `      ${String(index + 1).padEnd(6)} ${(localChunk?.chunkKey ?? "—").padEnd(23)} ` +
        `${(localChunk === undefined ? "—" : localChunk.score.toFixed(12)).padEnd(20)} ` +
        `${(localChunk === undefined ? "—" : localChunk.score.toFixed(6)).padEnd(10)} ` +
        `${(remoteChunk?.chunkKey ?? "—").padEnd(23)} ` +
        `${(remoteChunk === undefined ? "—" : remoteChunk.score.toFixed(12)).padEnd(20)} ` +
        `${remoteChunk === undefined ? "—" : remoteChunk.score.toFixed(6)}`,
    );
  }

  console.log(
    `    score deltas (remote − local, over the union of both Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} sets)`,
  );
  for (const delta of outcome.chunkDeltas) {
    const both = delta.localScore !== null && delta.remoteScore !== null;
    console.log(
      `      ${delta.chunkKey.padEnd(23)} ` +
        `local ${(delta.localScore === null ? "outside Top-3" : delta.localScore.toFixed(6)).padEnd(14)} ` +
        `remote ${(delta.remoteScore === null ? "outside Top-3" : delta.remoteScore.toFixed(6)).padEnd(14)} ` +
        `Δ ${both ? ((delta.remoteScore ?? 0) - (delta.localScore ?? 0)).toFixed(6) : "n/a (not ranked on both sides)"}`,
    );
  }

  const threshold = DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2);
  console.log(
    `    accept at ${threshold}            local ${accepted(outcome.local)}; remote ${accepted(outcome.remote)}`,
  );
  console.log(
    `    agreement                 Top-1 ${yesNo(outcome.topOneAgrees)}; accept/reject ${yesNo(outcome.acceptAgrees)}; ` +
      `full Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} order ${yesNo(outcome.rankingIdentical)}; chunk set ${yesNo(outcome.chunkSetIdentical)}`,
  );
  if (spec.expectedChunkKey !== null) {
    console.log(
      `    expected Top-1            local ${yesNo(topChunkKey(outcome.local) === spec.expectedChunkKey)}; ` +
        `remote ${yesNo(topChunkKey(outcome.remote) === spec.expectedChunkKey)}`,
    );
  }
}

function accepted(retrieval: Retrieval): string {
  return retrieval.accepted
    ? `ACCEPTED (${retrieval.acceptedChunkKeys.join(", ")})`
    : "REJECTED (nothing at or above the threshold)";
}

function reportFailure(spec: ExperimentQuery, stage: string, reason: string): void {
  console.log("");
  console.log(`  ${spec.id} — ${stage.toUpperCase()}`);
  console.log(`    query                     ${redact(spec.query)}`);
  console.log(`    reason                    ${redact(reason)}`);
}

function reportSummary(outcomes: QueryOutcome[]): void {
  heading("3. Summary");

  const cosines = outcomes.map((outcome) => outcome.cosine);
  const topOneAgreements = outcomes.filter((outcome) => outcome.topOneAgrees).length;
  const acceptAgreements = outcomes.filter((outcome) => outcome.acceptAgrees).length;
  const labelled = outcomes.filter((outcome) => outcome.spec.expectedChunkKey !== null);
  const localCorrect = labelled.filter(
    (outcome) => topChunkKey(outcome.local) === outcome.spec.expectedChunkKey,
  ).length;
  const remoteCorrect = labelled.filter(
    (outcome) => topChunkKey(outcome.remote) === outcome.spec.expectedChunkKey,
  ).length;
  const deltas = outcomes.flatMap((outcome) =>
    outcome.chunkDeltas
      .filter((delta) => delta.localScore !== null && delta.remoteScore !== null)
      .map((delta) => Math.abs((delta.remoteScore ?? 0) - (delta.localScore ?? 0))),
  );
  const repeatFailures = outcomes.filter((outcome) => !outcome.repeatRankingIdentical).length;
  const localLatencies = outcomes.map((outcome) => outcome.localLatencyMs);
  const remoteLatencies = outcomes.flatMap((outcome) => outcome.remoteLatenciesMs);
  // The very first remote call of the run pays the cold start Experiment A measured at ~6 s. Folding
  // it into the warm percentiles would describe a latency profile no steady-state caller ever sees.
  const warmRemote = remoteLatencies.slice(1);
  const localWarm = localLatencies.slice(1);

  line("queries compared", String(outcomes.length));
  line(
    "local↔remote cosine",
    `min ${Math.min(...cosines).toFixed(9)}, mean ${mean(cosines).toFixed(9)}, max ${Math.max(...cosines).toFixed(9)}`,
  );
  line(
    "Top-1 agreement",
    `${String(topOneAgreements)}/${String(outcomes.length)} (${percentage(topOneAgreements, outcomes.length)})`,
  );
  line(
    "expected Top-1 (local)",
    `${String(localCorrect)}/${String(labelled.length)} labelled (${percentage(localCorrect, labelled.length)})`,
  );
  line(
    "expected Top-1 (remote)",
    `${String(remoteCorrect)}/${String(labelled.length)} labelled (${percentage(remoteCorrect, labelled.length)})`,
  );
  line(
    "accept/reject agreement",
    `${String(acceptAgreements)}/${String(outcomes.length)} (${percentage(acceptAgreements, outcomes.length)})`,
  );
  line("threshold flips", String(outcomes.length - acceptAgreements));
  const rankingAgreements = outcomes.filter((outcome) => outcome.rankingIdentical).length;
  const setAgreements = outcomes.filter((outcome) => outcome.chunkSetIdentical).length;
  line(
    `full Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} order`,
    `${String(rankingAgreements)}/${String(outcomes.length)} identical (${percentage(rankingAgreements, outcomes.length)})`,
  );
  line(
    `Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk set`,
    `${String(setAgreements)}/${String(outcomes.length)} identical (${percentage(setAgreements, outcomes.length)})`,
  );
  line(
    "score delta |Δ|",
    deltas.length === 0
      ? "no chunk ranked on both sides"
      : `max ${Math.max(...deltas).toFixed(9)}, mean ${mean(deltas).toFixed(9)} (over ${String(deltas.length)} chunk pairs)`,
  );
  line("repeatability failures", `${String(repeatFailures)} (ranking changed across repeats)`);
  line(
    "bit-identical repeats",
    `${String(outcomes.filter((outcome) => outcome.bitIdentical).length)}/${String(outcomes.length)} queries`,
  );
  line(
    "local latency",
    `mean ${String(Math.round(mean(localLatencies)))} ms (cold ${String(localLatencies[0] ?? 0)} ms, ` +
      `warm mean ${localWarm.length === 0 ? "n/a" : `${String(Math.round(mean(localWarm)))} ms`})`,
  );
  line("remote cold call", `${String(remoteLatencies[0] ?? 0)} ms`);
  line(
    "remote warm latency",
    warmRemote.length === 0
      ? "n/a"
      : `p50 ${String(percentile(warmRemote, 0.5))} ms, p95 ${String(percentile(warmRemote, 0.95))} ms, ` +
          `max ${String(Math.max(...warmRemote))} ms (${String(warmRemote.length)} calls)`,
  );
}

function reportVerdict(outcomes: QueryOutcome[]): void {
  const repeatabilityFailures = outcomes.filter((outcome) => !outcome.repeatRankingIdentical);
  const topOneDisagreements = outcomes.filter((outcome) => !outcome.topOneAgrees);
  const acceptFlips = outcomes.filter((outcome) => !outcome.acceptAgrees);
  // A regression is narrower than a disagreement: the local vector found the labelled chunk and the
  // remote one did not. A disagreement where neither side is correct, or where the remote side is the
  // correct one, is a finding to report, not a reason to fail the gate.
  const regressions = outcomes.filter(
    (outcome) =>
      outcome.spec.expectedChunkKey !== null &&
      topChunkKey(outcome.local) === outcome.spec.expectedChunkKey &&
      topChunkKey(outcome.remote) !== outcome.spec.expectedChunkKey,
  );
  const improvements = outcomes.filter(
    (outcome) =>
      outcome.spec.expectedChunkKey !== null &&
      topChunkKey(outcome.local) !== outcome.spec.expectedChunkKey &&
      topChunkKey(outcome.remote) === outcome.spec.expectedChunkKey,
  );
  // "New" is measured against the local baseline, not against the threshold in the abstract: the
  // accepted evaluation already records 0.80 as permissive, so a hard negative both sides accept is a
  // known property of the threshold, whereas one only the remote side accepts is caused by the swap.
  const newHardNegativeAccepts = outcomes.filter(
    (outcome) =>
      outcome.spec.answerability !== "answerable" &&
      !outcome.local.accepted &&
      outcome.remote.accepted,
  );

  const reorderings = outcomes.filter(
    (outcome) => outcome.topOneAgrees && outcome.chunkSetIdentical && !outcome.rankingIdentical,
  );
  const setChanges = outcomes.filter((outcome) => !outcome.chunkSetIdentical);

  if (
    topOneDisagreements.length > 0 ||
    acceptFlips.length > 0 ||
    reorderings.length > 0 ||
    setChanges.length > 0
  ) {
    heading("4. Individual disagreements");
    console.log(
      "  Listed individually and not aggregated away. Nothing downstream of this gate proceeds\n" +
        "  automatically on the strength of a summary percentage.",
    );
    for (const outcome of setChanges) {
      const localOnly = chunkKeys(outcome.local).filter(
        (key) => !chunkKeys(outcome.remote).includes(key),
      );
      const remoteOnly = chunkKeys(outcome.remote).filter(
        (key) => !chunkKeys(outcome.local).includes(key),
      );
      console.log(
        `  chunk set differs ${outcome.spec.id.padEnd(24)} local-only ${localOnly.join(", ")} → remote-only ${remoteOnly.join(", ")}`,
      );
    }
    for (const outcome of reorderings) {
      console.log(
        `  order differs     ${outcome.spec.id.padEnd(24)} local ${chunkKeys(outcome.local).join(" > ")} → remote ${chunkKeys(outcome.remote).join(" > ")} (Top-1 unchanged)`,
      );
    }
    for (const outcome of topOneDisagreements) {
      console.log(
        `  Top-1 differs   ${outcome.spec.id.padEnd(24)} local ${String(topChunkKey(outcome.local))} → remote ${String(topChunkKey(outcome.remote))}` +
          (outcome.spec.expectedChunkKey === null
            ? " (unlabelled)"
            : ` (expected ${outcome.spec.expectedChunkKey})`),
      );
    }
    for (const outcome of acceptFlips) {
      console.log(
        `  accept flips    ${outcome.spec.id.padEnd(24)} local ${outcome.local.accepted ? "ACCEPTED" : "REJECTED"} → remote ${outcome.remote.accepted ? "ACCEPTED" : "REJECTED"} (${outcome.spec.answerability})`,
      );
    }
  }

  const blockers: string[] = [];
  if (repeatabilityFailures.length > 0) {
    blockers.push(
      `${String(repeatabilityFailures.length)} query/queries changed ranking across repeated remote calls`,
    );
  }
  if (regressions.length > 0) {
    blockers.push(
      `${String(regressions.length)} expected-Top-1 regression(s): ${regressions.map((outcome) => outcome.spec.id).join(", ")}`,
    );
  }
  if (newHardNegativeAccepts.length > 0) {
    blockers.push(
      `${String(newHardNegativeAccepts.length)} new hard-negative accept(s): ${newHardNegativeAccepts.map((outcome) => outcome.spec.id).join(", ")}`,
    );
  }

  const observations: string[] = [];
  if (topOneDisagreements.length > regressions.length + improvements.length) {
    observations.push("Top-1 disagreement on queries where neither side matches the label");
  }
  if (improvements.length > 0) {
    observations.push(
      `${String(improvements.length)} query/queries where only the remote vector matches the label: ${improvements.map((outcome) => outcome.spec.id).join(", ")}`,
    );
  }
  if (topOneDisagreements.length > 0 && regressions.length === 0 && improvements.length === 0) {
    observations.push("Top-1 disagreement confined to unlabelled or unanswerable queries");
  }
  if (acceptFlips.length > 0 && newHardNegativeAccepts.length === 0) {
    observations.push(
      `${String(acceptFlips.length)} accept/reject flip(s) that add no hard-negative accept`,
    );
  }
  if (!outcomes.every((outcome) => outcome.bitIdentical)) {
    observations.push(
      "repeated remote calls are not bit-identical (reported separately from ranking stability)",
    );
  }
  // Not a PASS blocker — the gate's stated criteria are Top-1, accept/reject, and repeatability — but
  // not silently dropped either: at `maxChunks = 3` these change the grounding context, so they are
  // recorded as observations rather than folded into a clean PASS.
  if (setChanges.length > 0) {
    observations.push(
      `${String(setChanges.length)} query/queries where the returned Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk set differs below Top-1: ${setChanges.map((outcome) => outcome.spec.id).join(", ")}`,
    );
  }
  if (reorderings.length > 0) {
    observations.push(
      `${String(reorderings.length)} query/queries where the Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} order differs below Top-1 with the same chunks: ${reorderings.map((outcome) => outcome.spec.id).join(", ")}`,
    );
  }

  if (blockers.length > 0) {
    verdict("FAIL", blockers);
    return;
  }
  if (observations.length > 0) {
    verdict("PASS WITH OBSERVATIONS", observations);
    return;
  }
  verdict("PASS", []);
}

function verdict(
  result: "PASS" | "PASS WITH OBSERVATIONS" | "FAIL" | "INCONCLUSIVE",
  notes: string[],
): void {
  heading("Verdict");
  console.log(`  ${result}`);
  for (const note of notes) {
    console.log(`    - ${redact(note)}`);
  }
  if (result === "FAIL" || result === "INCONCLUSIVE") {
    process.exitCode = 1;
  }
  if (result === "PASS WITH OBSERVATIONS" || result === "FAIL") {
    console.log("");
    console.log(
      "  Retrieval behaviour, not geometric similarity, decides this gate. No cosine-similarity\n" +
        "  threshold is defined or implied here, and no downstream step is unblocked by this run.",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile. Exact and order-statistic based; no interpolation to argue about. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function percentage(count: number, total: number): string {
  return total === 0 ? "n/a" : `${((count / total) * 100).toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? "YES" : "NO";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${truncate(error.message)}`;
  }
  return "unknown failure";
}

function heading(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${redact(value)}`);
}

/**
 * Last line of defence. Every printed string passes through here, so a credential or a connection
 * string that reached a message by an unforeseen route — a provider echoing a header, a `pg` error
 * quoting a DSN — is masked rather than written to the terminal.
 */
function redact(text: string): string {
  let masked = text;
  for (const name of ["HF_TOKEN", "DATABASE_URL"]) {
    const secret = process.env[name]?.trim();
    if (secret !== undefined && secret.length > 0) {
      masked = masked.split(secret).join("[REDACTED]");
    }
  }
  return masked
    .replace(/hf_[A-Za-z0-9]{8,}/g, "[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]");
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= BODY_SUMMARY_LIMIT
    ? collapsed
    : `${collapsed.slice(0, BODY_SUMMARY_LIMIT)}… (truncated)`;
}

function requiredEnv(name: string, guidance: string): string {
  const value = nonEmpty(process.env[name]);
  if (value === undefined) {
    console.error(`${name} must be set to run Experiment B.\n${guidance}`);
    process.exit(1);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

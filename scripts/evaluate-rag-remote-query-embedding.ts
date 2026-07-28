import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from "prettier";
import {
  DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
  RAG_RETRIEVAL_MAX_CHUNKS,
} from "../src/config/rag-retrieval-config.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";

/**
 * Experiment C — frozen 96-query evaluation of the remote query embedding (Gate 5).
 *
 * Experiment A established that the Hugging Face endpoint returns a well-formed 384-dimensional
 * vector. Experiment B established, on twelve queries, that such a vector retrieves the same Top-1
 * chunk on the same side of the threshold as the local one. Twelve queries cannot distinguish "the
 * two providers agree" from "the two providers happened to agree on twelve sentences".
 *
 * This script runs the whole frozen development dataset through both arms and asks the question the
 * small sample could not answer: **does swapping the query embedding provider change what the
 * retrieval layer accepts, rejects, and grounds an answer on, across all 96 labelled queries?**
 *
 * Two arms, one retrieval path.
 *
 * - The **local arm** is the production generator. It is recomputed here rather than lifted from the
 *   accepted baseline artifact, because the baseline ranks the complete twelve-chunk set with no
 *   threshold, while this experiment must compare the two providers under the *production* retrieval
 *   contract — `maxChunks = 3` and `minScore = 0.8`. The recomputed arm is then checked against the
 *   accepted baseline (§2) so the comparison is anchored to accepted evidence rather than floating
 *   free of it.
 * - The **remote arm** is the Hugging Face endpoint, called twice per query: the first call supplies
 *   the evaluation vector, the second proves the first was not a coin flip.
 *
 * Both arms go through `PostgresRagDocumentStore.searchRelevantChunks` with the SQL passage-embedding
 * filter bound to the frozen `RAG_EMBEDDING_PROFILE`. The Hugging Face model identity, provider,
 * revision, and dtype never enter that filter: the remote vector is a *query* against the local
 * space, and admitting it to the filter would mean comparing the local space against nothing.
 *
 * This is still a measurement. It builds no provider abstraction, modifies no production code, and
 * leaves the retrieval space, the chunks, the stored embeddings, the threshold, and the labels
 * exactly as it found them.
 *
 * Safety. The database session is read-only server-side and re-verified before every retrieval. The
 * only filesystem writes are the two declared output files, and the writer refuses any path whose
 * existing content is not this experiment's own artifact — an accepted baseline can therefore not be
 * overwritten even by a mistyped constant. The token is read from `.env`, used as a bearer credential,
 * and never printed or persisted; every emitted line passes through `redact()`. Vectors are summarised
 * numerically and never printed. Provider bodies are never dumped.
 */

// ---------------------------------------------------------------------------------------------
// Frozen inputs and declared outputs
// ---------------------------------------------------------------------------------------------

const DATASET_PATH = "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json";
const MANIFEST_PATH =
  "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.manifest.json";
const MAPPING_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json";
const BASELINE_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json";

const RESULTS_PATH = "docs/evaluation/rag-remote-query-embedding-evaluation-results.json";
const REPORT_PATH = "docs/rag-remote-query-embedding-evaluation-report.md";

/**
 * `[D]` The overwrite guard. A file at a declared output path is replaced only if it already carries
 * this experiment's own marker; anything else — above all an accepted baseline artifact that ended up
 * at one of these paths through a typo — aborts the write. The guard is on *content*, not on the path
 * string, because a path constant is exactly the thing that can be wrong.
 */
const RESULTS_SCHEMA_VERSION = "rag-remote-query-embedding-evaluation-results-v1";
const REPORT_MARKER = "# RAG remote query embedding evaluation report";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------------------------
// Remote arm
// ---------------------------------------------------------------------------------------------

const ENDPOINT_BASE = "https://router.huggingface.co/hf-inference/models";
const REMOTE_MODEL = "intfloat/multilingual-e5-small";

/**
 * `[D]` Two calls per query, not three. Experiment B took three calls on twelve queries and found the
 * remote output bit-identical every time; the open question at 96 queries is coverage, not depth, so a
 * second call on *every* query detects non-determinism more sharply than a third call on a few. Where
 * the two calls agree bit-for-bit, the retrieval they produce is identical by construction and is not
 * re-run; where they do not, the repeat is retrieved and compared (see `compareRepeat`).
 */
const REMOTE_CALL_COUNT = 2;

const REQUEST_TIMEOUT_MS = 30_000;

/** The tolerance the local generator already applies to itself, so both providers are graded alike. */
const NORM_TOLERANCE = 0.001;

/** Below this a vector is degenerate: cosine similarity against it is undefined, not merely small. */
const ZERO_VECTOR_EPSILON = 1e-9;

/** Bounded so a diagnostic stays a diagnostic and never becomes a body dump. */
const BODY_SUMMARY_LIMIT = 200;

/**
 * `[D]` The band the plan names for threshold-proximity reporting. It is a *reporting* window only:
 * nothing here proposes moving the threshold, and no query is treated differently because it falls
 * inside the band.
 */
const THRESHOLD_BAND = 0.02;

/** A score difference at or above this near the threshold is called out individually. */
const MATERIAL_NEAR_THRESHOLD_DELTA = 0.005;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

type Answerability = "answerable" | "unanswerable";

type DatasetRecord = {
  id: string;
  query: string;
  queryType: string;
  answerability: Answerability;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
};

type EvidenceMapping = { evidenceId: string; fullCoverageChunkKeys: string[] };

type ExpectedLabel = {
  expectedEvidenceId: string | null;
  expectedChunkKey: string | null;
  acceptableChunkKeys: string[];
};

type RankedChunk = { rank: number; chunkKey: string; score: number };

type Retrieval = {
  ranking: RankedChunk[];
  topChunkKey: string | null;
  topScore: number | null;
  accepted: boolean;
  acceptedChunkKeys: string[];
};

/** Per-arm classification of one query's retrieval outcome. See `classify` for the definitions. */
type Classification = {
  topOneCorrect: boolean | null;
  correctAccept: boolean;
  wrongAccept: boolean;
  correctReject: boolean;
  falseAccept: boolean;
  falseReject: boolean;
};

type RemoteCall = { vector: number[]; l2Norm: number; latencyMs: number };

type ProviderFailure = {
  kind: "timeout" | "transport" | "http" | "shape" | "vector";
  status: number | null;
  reason: string;
  latencyMs: number;
};

type QueryOutcome = {
  id: string;
  queryType: string;
  answerability: Answerability;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  expectedChunkKey: string | null;
  local: Retrieval;
  remote: Retrieval;
  localClass: Classification;
  remoteClass: Classification;
  scoreDeltas: { chunkKey: string; localScore: number | null; remoteScore: number | null }[];
  topOneAgrees: boolean;
  rankingAgrees: boolean;
  chunkSetAgrees: boolean;
  acceptAgrees: boolean;
  thresholdFlip: boolean;
  newFalseAccept: boolean;
  newFalseReject: boolean;
  remoteLatenciesMs: number[];
  remoteBitIdentical: boolean;
  remoteMaxRepeatDelta: number;
  remoteRepeatRankingIdentical: boolean;
  providerStatus: string;
  validation: string;
  localNorm: number;
  remoteNorm: number;
  localLatencyMs: number;
  baselineTopThreeAgrees: boolean;
};

type ProviderErrorTally = {
  total: number;
  unauthorized401: number;
  forbidden403: number;
  rateLimited429: number;
  serverError5xx: number;
  timeout: number;
  transport: number;
  otherHttp: number;
  invalidPayload: number;
};

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = requiredEnv(
    "HF_TOKEN",
    "Create a fine-grained token with the 'Make calls to Inference Providers' permission at\n" +
      "https://huggingface.co/settings/tokens and put it in .env as HF_TOKEN=…\n" +
      "The value is never printed or persisted by this script and .env is git-ignored.",
  );
  const connectionString = requiredEnv(
    "DATABASE_URL",
    "Point it at the database holding the active mein-konto v1 chunks and their frozen embeddings.\n" +
      "This evaluation only reads; the session is set read-only and verified before every retrieval.",
  );
  const url = `${ENDPOINT_BASE}/${REMOTE_MODEL}/pipeline/feature-extraction`;

  heading("Experiment C — frozen 96-query remote query embedding evaluation (Gate 5)");
  line("local profile id", RAG_EMBEDDING_PROFILE.id);
  line("local model", `${RAG_EMBEDDING_PROFILE.modelId}@${RAG_EMBEDDING_PROFILE.modelRevision}`);
  line("local artifact", `${RAG_EMBEDDING_PROFILE.artifact} (${RAG_EMBEDDING_PROFILE.dtype})`);
  line("remote endpoint", url);
  line("remote model", REMOTE_MODEL);
  line("query prefix (both arms)", JSON.stringify(RAG_EMBEDDING_PROFILE.queryPrefix));
  line("SQL profile filter", `${RAG_EMBEDDING_PROFILE.id} (frozen, never the remote identity)`);
  line("maxChunks", String(RAG_RETRIEVAL_MAX_CHUNKS));
  line("threshold (minScore)", DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2));
  line("remote calls per query", String(REMOTE_CALL_COUNT));
  line("HF_TOKEN", `present (${String(token.length)} characters, never printed or persisted)`);

  heading("1. Frozen inputs");
  const dataset = await loadFrozenInputs();
  const labels = new Map(
    dataset.records.map((record) => [record.id, expectedLabel(record, dataset.mappings)]),
  );

  const pool = new pg.Pool({ connectionString, max: 1 });
  let outcomes: QueryOutcome[];
  let providerErrors: ProviderErrorTally;
  let corpus: { chunks: number; embeddings: number };
  try {
    await assertReadOnlySession(pool);
    corpus = await readCorpusCounts(pool);
    line("active chunks", String(corpus.chunks));
    line("frozen embeddings", `${String(corpus.embeddings)} under the active profile`);
    if (corpus.embeddings === 0) {
      throw new Error("Refusing to run: no stored embeddings exist for the frozen profile.");
    }

    const store = new PostgresRagDocumentStore(pool);
    const generator = buildLocalGenerator();

    heading("2. Local arm");
    const localArm = await runLocalArm(pool, store, generator, dataset.records);
    const baselineAgreement = compareToBaseline(localArm, dataset.baselineTopThree);
    line("queries evaluated", String(localArm.size));
    line(
      "vs accepted baseline",
      `${String(baselineAgreement.agreed)}/${String(dataset.records.length)} queries reproduce the accepted baseline Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)}`,
    );
    if (baselineAgreement.disagreed.length > 0) {
      line("baseline divergence", baselineAgreement.disagreed.join(", "));
      console.log(
        "  The local arm no longer reproduces the accepted baseline. The corpus, the profile, or the\n" +
          "  model cache has drifted, and no local↔remote comparison drawn from this run would mean\n" +
          "  anything. Stopping before the remote arm.",
      );
      verdict("INCONCLUSIVE", ["the local arm does not reproduce the accepted baseline"], false);
      return;
    }

    heading("3. Remote arm");
    const remoteArm = await runRemoteArm(pool, store, url, token, dataset.records);
    if (remoteArm.aborted !== null) {
      line("aborted at", remoteArm.aborted.id);
      line("reason", remoteArm.aborted.reason);
      reportProviderErrors(remoteArm.errors);
      verdict(
        "INCONCLUSIVE",
        [`a provider error prevented completion at ${remoteArm.aborted.id}`],
        false,
      );
      return;
    }
    line("queries evaluated", String(remoteArm.results.size));
    line("provider errors", String(remoteArm.errors.total));
    providerErrors = remoteArm.errors;

    outcomes = dataset.records.map((record) =>
      buildOutcome(record, labels, localArm, remoteArm.results, baselineAgreement.perQuery),
    );
  } finally {
    await pool.end();
  }

  reportPerQuery(outcomes);
  const summary = summarise(outcomes);
  reportSummary(summary, outcomes, providerErrors);
  const disagreements = collectDisagreements(outcomes);
  reportDisagreements(disagreements);
  const decision = decide(outcomes, providerErrors);
  verdict(decision.result, decision.notes, true);

  heading("9. Artifacts");
  const written = await writeArtifacts({
    outcomes,
    summary,
    disagreements,
    providerErrors,
    dataset,
    corpus,
    verdictResult: decision.result,
    verdictNotes: decision.notes,
    endpoint: url,
  });
  for (const file of written) {
    line("written", file);
  }
}

// ---------------------------------------------------------------------------------------------
// Frozen inputs
// ---------------------------------------------------------------------------------------------

type FrozenInputs = {
  records: DatasetRecord[];
  mappings: EvidenceMapping[];
  hashes: Record<string, string>;
  baselineTopThree: Map<string, RankedChunk[]>;
  baselineId: string;
  baselineTimestamp: string;
};

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const datasetFile = await readFileWithHash(DATASET_PATH);
  const manifestFile = await readFileWithHash(MANIFEST_PATH);
  const mappingFile = await readFileWithHash(MAPPING_PATH);
  const baselineFile = await readFileWithHash(BASELINE_PATH);

  const records = parseDataset(JSON.parse(datasetFile.text) as unknown);
  const mappings = parseEvidenceMappings(JSON.parse(mappingFile.text) as unknown);
  const baseline = JSON.parse(baselineFile.text) as {
    baseline?: { id?: unknown; evaluationTimestamp?: unknown };
    frozenInputs?: { datasetSha256?: unknown; manifestSha256?: unknown };
    mappingArtifact?: { sha256?: unknown };
    perQuery?: unknown;
  };

  const hashes: Record<string, string> = {
    [DATASET_PATH]: datasetFile.sha256,
    [MANIFEST_PATH]: manifestFile.sha256,
    [MAPPING_PATH]: mappingFile.sha256,
    [BASELINE_PATH]: baselineFile.sha256,
  };
  for (const [file, sha256] of Object.entries(hashes)) {
    line(file.split("/").slice(-1)[0] ?? file, sha256);
  }

  // The accepted baseline records the hashes of the inputs it was produced from. Re-checking them is
  // what makes "the frozen dataset" a verified statement rather than a filename.
  assertHash("dataset", baseline.frozenInputs?.datasetSha256, datasetFile.sha256);
  assertHash("manifest", baseline.frozenInputs?.manifestSha256, manifestFile.sha256);
  assertHash("evidence→chunk mapping", baseline.mappingArtifact?.sha256, mappingFile.sha256);
  line("frozen input check", "dataset, manifest, and mapping match the accepted baseline");

  if (records.length !== 96) {
    throw new Error(
      `Expected the frozen 96-query dataset, found ${String(records.length)} records.`,
    );
  }

  return {
    records,
    mappings,
    hashes,
    baselineTopThree: baselineTopThree(baseline.perQuery),
    baselineId: typeof baseline.baseline?.id === "string" ? baseline.baseline.id : "unknown",
    baselineTimestamp:
      typeof baseline.baseline?.evaluationTimestamp === "string"
        ? baseline.baseline.evaluationTimestamp
        : "unknown",
  };
}

function assertHash(label: string, recorded: unknown, actual: string): void {
  if (typeof recorded !== "string") {
    throw new Error(`The accepted baseline records no ${label} hash to verify against.`);
  }
  if (recorded !== actual) {
    throw new Error(
      `Frozen ${label} has changed since the accepted baseline was produced ` +
        `(baseline ${recorded.slice(0, 12)}…, on disk ${actual.slice(0, 12)}…).`,
    );
  }
}

/**
 * The accepted baseline ranks all twelve chunks with no threshold. Its first `maxChunks` ranks are
 * exactly what the production retrieval path returns, so they are the right slice to check the
 * recomputed local arm against.
 */
function baselineTopThree(perQuery: unknown): Map<string, RankedChunk[]> {
  const map = new Map<string, RankedChunk[]>();
  if (!Array.isArray(perQuery)) {
    throw new Error(`${BASELINE_PATH} has no perQuery array.`);
  }
  for (const item of perQuery) {
    const record = item as { id?: unknown; rankings?: unknown };
    const id = record.id;
    if (typeof id !== "string" || !Array.isArray(record.rankings)) {
      throw new Error(`${BASELINE_PATH} contains a malformed perQuery entry.`);
    }
    const ranking = record.rankings
      .slice(0, RAG_RETRIEVAL_MAX_CHUNKS)
      .map((entry, index): RankedChunk => {
        const row = entry as { chunkKey?: unknown; score?: unknown };
        if (typeof row.chunkKey !== "string" || typeof row.score !== "number") {
          throw new Error(`${BASELINE_PATH} entry ${id} has a malformed ranking row.`);
        }
        return { rank: index + 1, chunkKey: row.chunkKey, score: row.score };
      });
    map.set(id, ranking);
  }
  return map;
}

async function readFileWithHash(relativePath: string): Promise<{ text: string; sha256: string }> {
  const text = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
  return { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function parseDataset(value: unknown): DatasetRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`${DATASET_PATH} is not an array of records.`);
  }
  return value.map((item, index) => {
    const record = item as Partial<DatasetRecord> & { acceptableEvidenceIds?: unknown };
    if (
      typeof record.id !== "string" ||
      typeof record.query !== "string" ||
      typeof record.queryType !== "string" ||
      (record.answerability !== "answerable" && record.answerability !== "unanswerable")
    ) {
      throw new Error(`${DATASET_PATH} record ${String(index)} is missing required fields.`);
    }
    const evidenceId = record.expectedEvidenceId;
    if (evidenceId !== null && typeof evidenceId !== "string") {
      throw new Error(`${DATASET_PATH} record ${record.id} has a malformed expectedEvidenceId.`);
    }
    const acceptable = Array.isArray(record.acceptableEvidenceIds)
      ? record.acceptableEvidenceIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      id: record.id,
      query: record.query,
      queryType: record.queryType,
      answerability: record.answerability,
      faqIntentId: typeof record.faqIntentId === "string" ? record.faqIntentId : null,
      expectedEvidenceId: evidenceId,
      acceptableEvidenceIds: acceptable,
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
    return {
      evidenceId: mapping.evidenceId,
      fullCoverageChunkKeys: mapping.fullCoverageChunkKeys.filter(
        (key): key is string => typeof key === "string",
      ),
    };
  });
}

/**
 * The frozen dataset labels an *evidence id*; retrieval returns a *chunk key*. The accepted baseline
 * mapping is the only sanctioned translation between them, so it is read rather than re-derived.
 */
function expectedLabel(record: DatasetRecord, mappings: EvidenceMapping[]): ExpectedLabel {
  const acceptableChunkKeys = record.acceptableEvidenceIds.flatMap(
    (evidenceId) =>
      mappings.find((mapping) => mapping.evidenceId === evidenceId)?.fullCoverageChunkKeys ?? [],
  );
  const expected =
    record.expectedEvidenceId === null
      ? null
      : (mappings.find((mapping) => mapping.evidenceId === record.expectedEvidenceId)
          ?.fullCoverageChunkKeys[0] ?? null);
  if (record.expectedEvidenceId !== null && expected === null) {
    throw new Error(
      `Evidence ${record.expectedEvidenceId} has no fully covering chunk in the mapping.`,
    );
  }
  return {
    expectedEvidenceId: record.expectedEvidenceId,
    expectedChunkKey: expected,
    acceptableChunkKeys: [...new Set(acceptableChunkKeys)],
  };
}

// ---------------------------------------------------------------------------------------------
// Local arm
// ---------------------------------------------------------------------------------------------

type LocalResult = { retrieval: Retrieval; l2Norm: number; latencyMs: number };

async function runLocalArm(
  pool: pg.Pool,
  store: PostgresRagDocumentStore,
  generator: TransformersE5SmallPassageEmbeddingGenerator,
  records: DatasetRecord[],
): Promise<Map<string, LocalResult>> {
  const results = new Map<string, LocalResult>();
  for (const record of records) {
    const startedAt = Date.now();
    const embedded = await generator.embedQuery(record.query);
    const latencyMs = Date.now() - startedAt;
    validateVector(embedded.embedding, `local ${record.id}`);
    results.set(record.id, {
      retrieval: await retrieve(pool, store, embedded.embedding),
      l2Norm: embedded.l2Norm,
      latencyMs,
    });
  }
  return results;
}

type BaselineAgreement = {
  agreed: number;
  disagreed: string[];
  perQuery: Map<string, boolean>;
};

/**
 * A guard, not a metric. If the recomputed local arm does not reproduce the accepted baseline's first
 * `maxChunks` ranks, then something below this experiment has moved — the corpus, the model cache, the
 * profile — and any local↔remote difference measured afterwards would be attributed to the wrong
 * cause. Scores are compared at the baseline's own six-decimal precision.
 */
function compareToBaseline(
  localArm: Map<string, LocalResult>,
  baseline: Map<string, RankedChunk[]>,
): BaselineAgreement {
  const perQuery = new Map<string, boolean>();
  const disagreed: string[] = [];
  for (const [id, local] of localArm) {
    const expected = baseline.get(id) ?? [];
    const agrees =
      expected.length === local.retrieval.ranking.length &&
      expected.every((chunk, index) => {
        const actual = local.retrieval.ranking[index];
        return (
          actual !== undefined &&
          actual.chunkKey === chunk.chunkKey &&
          round6(actual.score) === round6(chunk.score)
        );
      });
    perQuery.set(id, agrees);
    if (!agrees) {
      disagreed.push(id);
    }
  }
  return { agreed: perQuery.size - disagreed.length, disagreed, perQuery };
}

// ---------------------------------------------------------------------------------------------
// Remote arm
// ---------------------------------------------------------------------------------------------

type RemoteResult = {
  retrieval: Retrieval;
  l2Norm: number;
  latenciesMs: number[];
  bitIdentical: boolean;
  maxRepeatDelta: number;
  repeatRankingIdentical: boolean;
  providerStatus: string;
  validation: string;
};

type RemoteArm = {
  results: Map<string, RemoteResult>;
  errors: ProviderErrorTally;
  aborted: { id: string; reason: string } | null;
};

async function runRemoteArm(
  pool: pg.Pool,
  store: PostgresRagDocumentStore,
  url: string,
  token: string,
  records: DatasetRecord[],
): Promise<RemoteArm> {
  const results = new Map<string, RemoteResult>();
  const errors = emptyErrorTally();

  for (const record of records) {
    const calls: RemoteCall[] = [];
    let failure: ProviderFailure | null = null;
    for (let attempt = 0; attempt < REMOTE_CALL_COUNT; attempt += 1) {
      const outcome = await callRemote(url, token, record.query);
      if (outcome.ok) {
        calls.push(outcome.call);
      } else {
        tallyError(errors, outcome.failure);
        failure = outcome.failure;
        break;
      }
    }

    const primary = calls[0];
    if (failure !== null || primary === undefined) {
      // Fail fast. A 429 or an exhausted credit balance will not resolve by sending 90 more requests,
      // and a partial arm cannot be compared against a complete one without quietly changing what the
      // evaluation measures.
      return {
        results,
        errors,
        aborted: { id: record.id, reason: failure?.reason ?? "no successful call" },
      };
    }

    const repeat = calls[1];
    const bitIdentical = repeat === undefined || vectorsEqual(repeat.vector, primary.vector);
    const maxRepeatDelta =
      repeat === undefined ? 0 : maxAbsoluteDelta(repeat.vector, primary.vector);
    const retrieval = await retrieve(pool, store, primary.vector);
    // Identical vectors necessarily produce an identical ranking, so the repeat is only retrieved when
    // the vectors actually differ. Asserting it in that case is the whole point of the second call.
    const repeatRankingIdentical =
      bitIdentical || repeat === undefined
        ? true
        : rankingSignature(await retrieve(pool, store, repeat.vector)) ===
          rankingSignature(retrieval);

    results.set(record.id, {
      retrieval,
      l2Norm: primary.l2Norm,
      latenciesMs: calls.map((call) => call.latencyMs),
      bitIdentical,
      maxRepeatDelta,
      repeatRankingIdentical,
      providerStatus: "HTTP 200",
      validation: `dim ${String(primary.vector.length)}, finite, non-zero, norm ${primary.l2Norm.toFixed(9)}`,
    });
  }

  return { results, errors, aborted: null };
}

type RemoteOutcome = { ok: true; call: RemoteCall } | { ok: false; failure: ProviderFailure };

/**
 * One remote embedding call, validated to the same standard the local generator holds itself to.
 * Every failure mode resolves to a classified `ProviderFailure`; none reaches the caller as an
 * exception, and none carries a provider body.
 */
async function callRemote(url: string, token: string, query: string): Promise<RemoteOutcome> {
  const body = JSON.stringify({
    // The prefix comes from the frozen profile rather than a literal, so the two arms cannot drift
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
      failure: {
        kind: name === "TimeoutError" ? "timeout" : "transport",
        status: null,
        latencyMs,
        reason:
          name === "TimeoutError"
            ? `request timed out after ${String(latencyMs)} ms`
            : `transport failure (${name})`,
      },
    };
  }

  const text = await response.text();
  const latencyMs = Date.now() - startedAt;

  if (response.status !== 200) {
    return {
      ok: false,
      failure: {
        kind: "http",
        status: response.status,
        latencyMs,
        reason: `HTTP ${String(response.status)} — ${interpretStatus(response.status)} [${summariseBody(text, response.headers.get("content-type") ?? "")}]`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      failure: {
        kind: "shape",
        status: 200,
        latencyMs,
        reason: "HTTP 200 body was not valid JSON",
      },
    };
  }

  const unwrapped = unwrapEmbedding(parsed);
  if (!unwrapped.ok) {
    return {
      ok: false,
      failure: { kind: "shape", status: 200, latencyMs, reason: unwrapped.reason },
    };
  }

  const vector = unwrapped.vector;
  const invalid = vectorProblem(vector);
  if (invalid !== null) {
    return { ok: false, failure: { kind: "vector", status: 200, latencyMs, reason: invalid } };
  }

  return { ok: true, call: { vector, l2Norm: vectorNorm(vector), latencyMs } };
}

/** Returns a reason string when the vector is unusable, `null` when it is sound. */
function vectorProblem(vector: readonly number[]): string | null {
  if (vector.length !== RAG_EMBEDDING_PROFILE.dimension) {
    return `dimension ${String(vector.length)}, expected ${String(RAG_EMBEDDING_PROFILE.dimension)}`;
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    return "vector contains NaN or Infinity";
  }
  const l2Norm = vectorNorm(vector);
  if (l2Norm <= ZERO_VECTOR_EPSILON) {
    return "vector is the zero vector";
  }
  if (Math.abs(l2Norm - 1) > NORM_TOLERANCE) {
    return `L2 norm ${l2Norm.toFixed(9)} is outside 1 ± ${String(NORM_TOLERANCE)}`;
  }
  return null;
}

function validateVector(vector: readonly number[], label: string): void {
  const problem = vectorProblem(vector);
  if (problem !== null) {
    throw new Error(`Invalid ${label} embedding: ${problem}`);
  }
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

function emptyErrorTally(): ProviderErrorTally {
  return {
    total: 0,
    unauthorized401: 0,
    forbidden403: 0,
    rateLimited429: 0,
    serverError5xx: 0,
    timeout: 0,
    transport: 0,
    otherHttp: 0,
    invalidPayload: 0,
  };
}

function tallyError(tally: ProviderErrorTally, failure: ProviderFailure): void {
  tally.total += 1;
  if (failure.kind === "timeout") {
    tally.timeout += 1;
    return;
  }
  if (failure.kind === "transport") {
    tally.transport += 1;
    return;
  }
  if (failure.kind === "shape" || failure.kind === "vector") {
    tally.invalidPayload += 1;
    return;
  }
  const status = failure.status ?? 0;
  if (status === 401) {
    tally.unauthorized401 += 1;
  } else if (status === 403) {
    tally.forbidden403 += 1;
  } else if (status === 429) {
    tally.rateLimited429 += 1;
  } else if (status >= 500) {
    tally.serverError5xx += 1;
  } else {
    tally.otherHttp += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

/**
 * The production retrieval path, unchanged: the same store, the same SQL, the same `maxChunks`, and a
 * passage-embedding filter bound to the frozen profile. Only the query vector varies between the arms.
 *
 * `retrieveRelevantChunks` is deliberately not called: it drops everything below the threshold, and
 * this evaluation needs the ranking *and* the accept decision, not the accept decision alone. The
 * threshold is applied here with the same `>=` comparison it uses.
 */
async function retrieve(
  pool: pg.Pool,
  store: PostgresRagDocumentStore,
  queryEmbedding: number[],
): Promise<Retrieval> {
  await assertReadOnlySession(pool);
  const results = await store.searchRelevantChunks({
    queryEmbedding,
    model: embeddingProfileModelRef(),
    maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
  });
  const ranking = results.map((result, index) => ({
    rank: index + 1,
    chunkKey: result.chunkKey,
    score: result.score,
  }));
  const acceptedChunkKeys = ranking
    .filter((chunk) => chunk.score >= DEFAULT_RAG_RETRIEVAL_MIN_SCORE)
    .map((chunk) => chunk.chunkKey);
  return {
    ranking,
    topChunkKey: ranking[0]?.chunkKey ?? null,
    topScore: ranking[0]?.score ?? null,
    accepted: acceptedChunkKeys.length > 0,
    acceptedChunkKeys,
  };
}

function rankingSignature(retrieval: Retrieval): string {
  return `${retrieval.ranking.map((chunk) => chunk.chunkKey).join(">")}|${String(retrieval.accepted)}`;
}

function chunkKeys(retrieval: Retrieval): string[] {
  return retrieval.ranking.map((chunk) => chunk.chunkKey);
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/**
 * `[D]` The accept/reject vocabulary this evaluation uses, stated once so the counts mean something
 * definite.
 *
 * A query is **accepted** when the production retrieval path would return at least one chunk — that
 * is, when the best of the returned `maxChunks` scores at or above the threshold. It is **rejected**
 * otherwise.
 *
 * For an **answerable** query:
 * - *correct accept* — accepted, and a chunk that fully covers the labelled evidence is among the
 *   accepted chunks. The answer layer would be grounded in the right passage.
 * - *wrong accept* — accepted, but no accepted chunk covers the labelled evidence. The system would
 *   answer confidently from the wrong passage, which is worse than declining.
 * - *false reject* — rejected although the query is answerable from the corpus.
 *
 * For an **unanswerable** query (hard negative or irrelevant):
 * - *correct reject* — rejected, as it should be.
 * - *false accept* — accepted, so the system would ground an answer in a passage that does not cover
 *   the question.
 *
 * *Top-1 correctness* is scored only where a labelled expected chunk exists, and only against the
 * single rank-1 chunk. It is deliberately independent of the threshold.
 */
function classify(
  retrieval: Retrieval,
  label: ExpectedLabel,
  answerability: Answerability,
): Classification {
  const coversExpected = retrieval.acceptedChunkKeys.some((key) =>
    label.acceptableChunkKeys.includes(key),
  );
  if (answerability === "answerable") {
    return {
      topOneCorrect:
        label.expectedChunkKey === null ? null : retrieval.topChunkKey === label.expectedChunkKey,
      correctAccept: retrieval.accepted && coversExpected,
      wrongAccept: retrieval.accepted && !coversExpected,
      correctReject: false,
      falseAccept: false,
      falseReject: !retrieval.accepted,
    };
  }
  return {
    topOneCorrect: null,
    correctAccept: false,
    wrongAccept: false,
    correctReject: !retrieval.accepted,
    falseAccept: retrieval.accepted,
    falseReject: false,
  };
}

function buildOutcome(
  record: DatasetRecord,
  labels: Map<string, ExpectedLabel>,
  localArm: Map<string, LocalResult>,
  remoteArm: Map<string, RemoteResult>,
  baselinePerQuery: Map<string, boolean>,
): QueryOutcome {
  const label = labels.get(record.id);
  const local = localArm.get(record.id);
  const remote = remoteArm.get(record.id);
  if (label === undefined || local === undefined || remote === undefined) {
    throw new Error(`Incomplete evaluation for ${record.id}.`);
  }

  const localClass = classify(local.retrieval, label, record.answerability);
  const remoteClass = classify(remote.retrieval, label, record.answerability);

  return {
    id: record.id,
    queryType: record.queryType,
    answerability: record.answerability,
    faqIntentId: record.faqIntentId,
    expectedEvidenceId: label.expectedEvidenceId,
    expectedChunkKey: label.expectedChunkKey,
    local: local.retrieval,
    remote: remote.retrieval,
    localClass,
    remoteClass,
    scoreDeltas: scoreDeltas(local.retrieval, remote.retrieval),
    topOneAgrees: local.retrieval.topChunkKey === remote.retrieval.topChunkKey,
    rankingAgrees: chunkKeys(local.retrieval).join(">") === chunkKeys(remote.retrieval).join(">"),
    chunkSetAgrees:
      [...chunkKeys(local.retrieval)].sort().join(",") ===
      [...chunkKeys(remote.retrieval)].sort().join(","),
    acceptAgrees: local.retrieval.accepted === remote.retrieval.accepted,
    thresholdFlip: local.retrieval.accepted !== remote.retrieval.accepted,
    newFalseAccept: !localClass.falseAccept && remoteClass.falseAccept,
    newFalseReject: !localClass.falseReject && remoteClass.falseReject,
    remoteLatenciesMs: remote.latenciesMs,
    remoteBitIdentical: remote.bitIdentical,
    remoteMaxRepeatDelta: remote.maxRepeatDelta,
    remoteRepeatRankingIdentical: remote.repeatRankingIdentical,
    providerStatus: remote.providerStatus,
    validation: remote.validation,
    localNorm: local.l2Norm,
    remoteNorm: remote.l2Norm,
    localLatencyMs: local.latencyMs,
    baselineTopThreeAgrees: baselinePerQuery.get(record.id) ?? false,
  };
}

function scoreDeltas(local: Retrieval, remote: Retrieval): QueryOutcome["scoreDeltas"] {
  const keys = [...new Set([...chunkKeys(local), ...chunkKeys(remote)])];
  return keys.map((chunkKey) => ({
    chunkKey,
    localScore: local.ranking.find((chunk) => chunk.chunkKey === chunkKey)?.score ?? null,
    remoteScore: remote.ranking.find((chunk) => chunk.chunkKey === chunkKey)?.score ?? null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

type ArmSummary = {
  total: number;
  answerable: number;
  unanswerable: number;
  correctAccepts: number;
  wrongAccepts: number;
  correctRejects: number;
  falseAccepts: number;
  falseRejects: number;
  topOneCorrect: number;
  topOneScored: number;
  accepted: number;
  rejected: number;
  nearThreshold: { below: number; around: number; above: number };
};

type Summary = {
  local: ArmSummary;
  remote: ArmSummary;
  topOneAgreement: number;
  rankingAgreement: number;
  chunkSetAgreement: number;
  acceptAgreement: number;
  thresholdFlips: number;
  newFalseAccepts: string[];
  newFalseRejects: string[];
  resolvedLocalErrors: string[];
  introducedRemoteErrors: string[];
  absDeltas: number[];
  signedDeltaMin: number;
  signedDeltaMax: number;
  coldLatencyMs: number;
  warmLatencies: number[];
  bitIdenticalCount: number;
  repeatRankingStableCount: number;
  baselineAgreement: number;
};

function summarise(outcomes: QueryOutcome[]): Summary {
  const absDeltas = outcomes.flatMap((outcome) =>
    outcome.scoreDeltas
      .filter((delta) => delta.localScore !== null && delta.remoteScore !== null)
      .map((delta) => Math.abs((delta.remoteScore ?? 0) - (delta.localScore ?? 0))),
  );
  const signedDeltas = outcomes.flatMap((outcome) =>
    outcome.scoreDeltas
      .filter((delta) => delta.localScore !== null && delta.remoteScore !== null)
      .map((delta) => (delta.remoteScore ?? 0) - (delta.localScore ?? 0)),
  );
  const latencies = outcomes.flatMap((outcome) => outcome.remoteLatenciesMs);

  return {
    local: armSummary(outcomes, (outcome) => ({
      retrieval: outcome.local,
      cls: outcome.localClass,
    })),
    remote: armSummary(outcomes, (outcome) => ({
      retrieval: outcome.remote,
      cls: outcome.remoteClass,
    })),
    topOneAgreement: outcomes.filter((outcome) => outcome.topOneAgrees).length,
    rankingAgreement: outcomes.filter((outcome) => outcome.rankingAgrees).length,
    chunkSetAgreement: outcomes.filter((outcome) => outcome.chunkSetAgrees).length,
    acceptAgreement: outcomes.filter((outcome) => outcome.acceptAgrees).length,
    thresholdFlips: outcomes.filter((outcome) => outcome.thresholdFlip).length,
    newFalseAccepts: outcomes.filter((outcome) => outcome.newFalseAccept).map((o) => o.id),
    newFalseRejects: outcomes.filter((outcome) => outcome.newFalseReject).map((o) => o.id),
    resolvedLocalErrors: outcomes
      .filter(
        (outcome) =>
          outcome.localClass.topOneCorrect === false && outcome.remoteClass.topOneCorrect === true,
      )
      .map((outcome) => outcome.id),
    introducedRemoteErrors: outcomes
      .filter(
        (outcome) =>
          outcome.localClass.topOneCorrect === true && outcome.remoteClass.topOneCorrect === false,
      )
      .map((outcome) => outcome.id),
    absDeltas,
    signedDeltaMin: signedDeltas.length === 0 ? 0 : Math.min(...signedDeltas),
    signedDeltaMax: signedDeltas.length === 0 ? 0 : Math.max(...signedDeltas),
    coldLatencyMs: latencies[0] ?? 0,
    warmLatencies: latencies.slice(1),
    bitIdenticalCount: outcomes.filter((outcome) => outcome.remoteBitIdentical).length,
    repeatRankingStableCount: outcomes.filter((outcome) => outcome.remoteRepeatRankingIdentical)
      .length,
    baselineAgreement: outcomes.filter((outcome) => outcome.baselineTopThreeAgrees).length,
  };
}

function armSummary(
  outcomes: QueryOutcome[],
  pick: (outcome: QueryOutcome) => { retrieval: Retrieval; cls: Classification },
): ArmSummary {
  const scored = outcomes.filter((outcome) => pick(outcome).cls.topOneCorrect !== null);
  const topScores = outcomes.map((outcome) => pick(outcome).retrieval.topScore ?? 0);
  const threshold = DEFAULT_RAG_RETRIEVAL_MIN_SCORE;
  return {
    total: outcomes.length,
    answerable: outcomes.filter((outcome) => outcome.answerability === "answerable").length,
    unanswerable: outcomes.filter((outcome) => outcome.answerability === "unanswerable").length,
    correctAccepts: outcomes.filter((outcome) => pick(outcome).cls.correctAccept).length,
    wrongAccepts: outcomes.filter((outcome) => pick(outcome).cls.wrongAccept).length,
    correctRejects: outcomes.filter((outcome) => pick(outcome).cls.correctReject).length,
    falseAccepts: outcomes.filter((outcome) => pick(outcome).cls.falseAccept).length,
    falseRejects: outcomes.filter((outcome) => pick(outcome).cls.falseReject).length,
    topOneCorrect: scored.filter((outcome) => pick(outcome).cls.topOneCorrect === true).length,
    topOneScored: scored.length,
    accepted: outcomes.filter((outcome) => pick(outcome).retrieval.accepted).length,
    rejected: outcomes.filter((outcome) => !pick(outcome).retrieval.accepted).length,
    nearThreshold: {
      below: topScores.filter((score) => score >= threshold - THRESHOLD_BAND && score < threshold)
        .length,
      around: topScores.filter(
        (score) => score >= threshold - THRESHOLD_BAND && score <= threshold + THRESHOLD_BAND,
      ).length,
      above: topScores.filter((score) => score >= threshold && score <= threshold + THRESHOLD_BAND)
        .length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Disagreements
// ---------------------------------------------------------------------------------------------

type Disagreement = {
  kind: string;
  id: string;
  queryType: string;
  expectedEvidenceId: string | null;
  expectedChunkKey: string | null;
  localResult: string;
  remoteResult: string;
  scores: string;
  interpretation: string;
};

function collectDisagreements(outcomes: QueryOutcome[]): Disagreement[] {
  const disagreements: Disagreement[] = [];

  for (const outcome of outcomes) {
    const base = {
      id: outcome.id,
      queryType: outcome.queryType,
      expectedEvidenceId: outcome.expectedEvidenceId,
      expectedChunkKey: outcome.expectedChunkKey,
    };

    if (!outcome.topOneAgrees) {
      disagreements.push({
        ...base,
        kind: "top-1 disagreement",
        localResult: `Top-1 ${outcome.local.topChunkKey ?? "—"}`,
        remoteResult: `Top-1 ${outcome.remote.topChunkKey ?? "—"}`,
        scores: `local ${fmtScore(outcome.local.topScore)} vs remote ${fmtScore(outcome.remote.topScore)}`,
        interpretation: interpretTopOne(outcome),
      });
    }

    if (outcome.thresholdFlip) {
      disagreements.push({
        ...base,
        kind: "accept/reject flip",
        localResult: outcome.local.accepted ? "ACCEPTED" : "REJECTED",
        remoteResult: outcome.remote.accepted ? "ACCEPTED" : "REJECTED",
        scores: `top score local ${fmtScore(outcome.local.topScore)} vs remote ${fmtScore(outcome.remote.topScore)} (threshold ${DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2)})`,
        interpretation: `${outcome.answerability} query crossed the threshold when the query embedding provider changed.`,
      });
    }

    if (outcome.newFalseAccept) {
      disagreements.push({
        ...base,
        kind: "new false accept",
        localResult: "correct reject",
        remoteResult: `false accept (${outcome.remote.acceptedChunkKeys.join(", ")})`,
        scores: `top score local ${fmtScore(outcome.local.topScore)} vs remote ${fmtScore(outcome.remote.topScore)}`,
        interpretation:
          "The remote arm would ground an answer in a passage that does not cover an unanswerable query.",
      });
    }

    if (outcome.newFalseReject) {
      disagreements.push({
        ...base,
        kind: "new false reject",
        localResult: "accepted",
        remoteResult: "rejected",
        scores: `top score local ${fmtScore(outcome.local.topScore)} vs remote ${fmtScore(outcome.remote.topScore)}`,
        interpretation: "The remote arm would decline a query the local arm answers.",
      });
    }

    if (
      outcome.localClass.topOneCorrect !== null &&
      outcome.localClass.topOneCorrect !== outcome.remoteClass.topOneCorrect
    ) {
      const improved = outcome.remoteClass.topOneCorrect === true;
      disagreements.push({
        ...base,
        kind: improved
          ? "expected-evidence correctness resolved"
          : "expected-evidence correctness regressed",
        localResult: `Top-1 ${outcome.local.topChunkKey ?? "—"} (${outcome.localClass.topOneCorrect ? "correct" : "incorrect"})`,
        remoteResult: `Top-1 ${outcome.remote.topChunkKey ?? "—"} (${outcome.remoteClass.topOneCorrect === true ? "correct" : "incorrect"})`,
        scores: `local ${fmtScore(outcome.local.topScore)} vs remote ${fmtScore(outcome.remote.topScore)}`,
        interpretation: improved
          ? "The remote arm reaches the labelled evidence where the local arm does not."
          : "The remote arm loses labelled evidence the local arm reaches.",
      });
    }

    if (!outcome.chunkSetAgrees) {
      const localOnly = chunkKeys(outcome.local).filter(
        (key) => !chunkKeys(outcome.remote).includes(key),
      );
      const remoteOnly = chunkKeys(outcome.remote).filter(
        (key) => !chunkKeys(outcome.local).includes(key),
      );
      disagreements.push({
        ...base,
        kind: `top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk-set difference`,
        localResult: `local-only ${localOnly.join(", ")}`,
        remoteResult: `remote-only ${remoteOnly.join(", ")}`,
        scores: rankingPair(outcome),
        interpretation:
          "The grounding context handed downstream differs, although Top-1 and the accept decision may not.",
      });
    } else if (!outcome.rankingAgrees) {
      // Not in the plan's enumerated list, but Gate 4 accepted rank-2/3 swaps as a named observation
      // class, and enumerating chunk-set changes while leaving reorderings to an aggregate count would
      // be inconsistent. The same chunks reach the answer layer, in a different order.
      disagreements.push({
        ...base,
        kind: `top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} order difference`,
        localResult: chunkKeys(outcome.local).join(" > "),
        remoteResult: chunkKeys(outcome.remote).join(" > "),
        scores: rankingPair(outcome),
        interpretation:
          "The same chunks are returned in a different order below Top-1; the grounding set is unchanged.",
      });
    }

    const nearThreshold =
      Math.abs((outcome.local.topScore ?? 0) - DEFAULT_RAG_RETRIEVAL_MIN_SCORE) <= THRESHOLD_BAND ||
      Math.abs((outcome.remote.topScore ?? 0) - DEFAULT_RAG_RETRIEVAL_MIN_SCORE) <= THRESHOLD_BAND;
    const topDelta = Math.abs((outcome.remote.topScore ?? 0) - (outcome.local.topScore ?? 0));
    if (nearThreshold && topDelta >= MATERIAL_NEAR_THRESHOLD_DELTA) {
      disagreements.push({
        ...base,
        kind: "material score difference near threshold",
        localResult: `top score ${fmtScore(outcome.local.topScore)} (${outcome.local.accepted ? "accepted" : "rejected"})`,
        remoteResult: `top score ${fmtScore(outcome.remote.topScore)} (${outcome.remote.accepted ? "accepted" : "rejected"})`,
        scores: `|Δ| ${topDelta.toFixed(6)} within ±${String(THRESHOLD_BAND)} of the threshold`,
        interpretation:
          "The accept decision did not change here, but a drift of this size this close to the threshold is what a flip would look like on a different query.",
      });
    }
  }

  return disagreements;
}

function interpretTopOne(outcome: QueryOutcome): string {
  if (outcome.expectedChunkKey === null) {
    return "Unanswerable query: neither Top-1 is labelled correct, so this is a ranking difference among passages that should all be declined.";
  }
  if (outcome.remoteClass.topOneCorrect === true) {
    return "The remote arm reaches the labelled chunk where the local arm does not.";
  }
  if (outcome.localClass.topOneCorrect === true) {
    return "The remote arm loses the labelled chunk the local arm reaches.";
  }
  return "Both arms miss the labelled chunk; the disagreement is between two incorrect answers.";
}

function rankingPair(outcome: QueryOutcome): string {
  return `local ${outcome.local.ranking.map((chunk) => `${chunk.chunkKey}=${chunk.score.toFixed(6)}`).join(" > ")} | remote ${outcome.remote.ranking.map((chunk) => `${chunk.chunkKey}=${chunk.score.toFixed(6)}`).join(" > ")}`;
}

// ---------------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------------

type Decision = {
  result: "PASS" | "PASS WITH OBSERVATIONS" | "FAIL" | "INCONCLUSIVE";
  notes: string[];
};

function decide(outcomes: QueryOutcome[], errors: ProviderErrorTally): Decision {
  const blockers: string[] = [];

  const nonRepeatable = outcomes.filter((outcome) => !outcome.remoteRepeatRankingIdentical);
  if (nonRepeatable.length > 0) {
    blockers.push(
      `remote output is not repeatable for ${String(nonRepeatable.length)} query/queries: ${nonRepeatable.map((o) => o.id).join(", ")}`,
    );
  }
  const newFalseAcceptsOnNegatives = outcomes.filter(
    (outcome) => outcome.newFalseAccept && outcome.answerability === "unanswerable",
  );
  if (newFalseAcceptsOnNegatives.length > 0) {
    blockers.push(
      `${String(newFalseAcceptsOnNegatives.length)} new false accept(s) on unanswerable queries: ${newFalseAcceptsOnNegatives.map((o) => o.id).join(", ")}`,
    );
  }
  const newFalseRejects = outcomes.filter((outcome) => outcome.newFalseReject);
  if (newFalseRejects.length > 0) {
    blockers.push(
      `${String(newFalseRejects.length)} new false reject(s): ${newFalseRejects.map((o) => o.id).join(", ")}`,
    );
  }
  const regressions = outcomes.filter(
    (outcome) =>
      outcome.localClass.topOneCorrect === true && outcome.remoteClass.topOneCorrect === false,
  );
  const improvements = outcomes.filter(
    (outcome) =>
      outcome.localClass.topOneCorrect === false && outcome.remoteClass.topOneCorrect === true,
  );
  // `[D]` Net labelled quality decides, not the raw count of moved queries. A swap that loses one
  // labelled chunk and gains another has not made retrieval worse, and calling it a regression would
  // block on noise; a net loss is a real quality change and blocks.
  if (regressions.length > improvements.length) {
    blockers.push(
      `labelled Top-1 quality is materially worse: ${String(regressions.length)} regression(s) against ${String(improvements.length)} resolution(s) — ${regressions.map((o) => o.id).join(", ")}`,
    );
  }
  const localCorrectAccepts = outcomes.filter((outcome) => outcome.localClass.correctAccept).length;
  const remoteCorrectAccepts = outcomes.filter(
    (outcome) => outcome.remoteClass.correctAccept,
  ).length;
  if (remoteCorrectAccepts < localCorrectAccepts) {
    blockers.push(
      `correct accepts fell from ${String(localCorrectAccepts)} to ${String(remoteCorrectAccepts)}`,
    );
  }
  if (errors.total > 0) {
    blockers.push(`${String(errors.total)} provider error(s) occurred during the run`);
  }

  if (blockers.length > 0) {
    return { result: "FAIL", notes: blockers };
  }

  const observations: string[] = [];
  if (regressions.length > 0 || improvements.length > 0) {
    observations.push(
      `labelled Top-1 changed on ${String(regressions.length + improvements.length)} query/queries with no net loss ` +
        `(${String(improvements.length)} resolved, ${String(regressions.length)} regressed)`,
    );
  }
  const setChanges = outcomes.filter((outcome) => !outcome.chunkSetAgrees);
  if (setChanges.length > 0) {
    observations.push(
      `${String(setChanges.length)} query/queries where the returned Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk set differs`,
    );
  }
  const reorderings = outcomes.filter(
    (outcome) => outcome.chunkSetAgrees && !outcome.rankingAgrees,
  );
  if (reorderings.length > 0) {
    observations.push(
      `${String(reorderings.length)} query/queries where the Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} order differs with the same chunks`,
    );
  }
  const topOneDisagreements = outcomes.filter((outcome) => !outcome.topOneAgrees);
  if (topOneDisagreements.length > regressions.length + improvements.length) {
    observations.push("Top-1 disagreement on queries where neither arm matches a label");
  }
  if (outcomes.some((outcome) => !outcome.remoteBitIdentical)) {
    observations.push("repeated remote calls are not bit-identical (ranking stability held)");
  }
  observations.push(
    "the served remote revision is unpinnable (no X-Repo-Commit header) — an accepted limitation carried from Gate 3",
  );
  observations.push(
    `remote latency is roughly an order of magnitude above the local arm and is measured from this machine, not from the deployment target`,
  );

  return { result: "PASS WITH OBSERVATIONS", notes: observations };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

function reportPerQuery(outcomes: QueryOutcome[]): void {
  heading("4. Per-query comparison (full detail in the results artifact)");
  console.log(
    `  ${"fixture".padEnd(22)} ${"type".padEnd(15)} ${"ans".padEnd(4)} ${"expected".padEnd(12)} ` +
      `${"local T1".padEnd(12)} ${"remote T1".padEnd(12)} ${"T1".padEnd(3)} ${"acc".padEnd(4)} ${"set".padEnd(4)} ${"|Δ|max".padEnd(9)} lat`,
  );
  for (const outcome of outcomes) {
    const maxDelta = outcome.scoreDeltas
      .filter((delta) => delta.localScore !== null && delta.remoteScore !== null)
      .reduce(
        (max, delta) => Math.max(max, Math.abs((delta.remoteScore ?? 0) - (delta.localScore ?? 0))),
        0,
      );
    console.log(
      `  ${outcome.id.replace("mein-konto-v1-dev-", "dev-").padEnd(22)} ` +
        `${outcome.queryType.padEnd(15)} ${(outcome.answerability === "answerable" ? "yes" : "no").padEnd(4)} ` +
        `${shortChunk(outcome.expectedChunkKey).padEnd(12)} ${shortChunk(outcome.local.topChunkKey).padEnd(12)} ` +
        `${shortChunk(outcome.remote.topChunkKey).padEnd(12)} ${yesNo(outcome.topOneAgrees).padEnd(3)} ` +
        `${yesNo(outcome.acceptAgrees).padEnd(4)} ${yesNo(outcome.chunkSetAgrees).padEnd(4)} ` +
        `${maxDelta.toFixed(6).padEnd(9)} ${String(Math.round(mean(outcome.remoteLatenciesMs)))} ms`,
    );
  }
}

function reportSummary(
  summary: Summary,
  outcomes: QueryOutcome[],
  errors: ProviderErrorTally,
): void {
  heading("5. Arm summaries");
  console.log(`  ${"metric".padEnd(30)} ${"local".padEnd(12)} remote`);
  const rows: [string, string, string][] = [
    ["total queries", String(summary.local.total), String(summary.remote.total)],
    ["answerable", String(summary.local.answerable), String(summary.remote.answerable)],
    ["unanswerable", String(summary.local.unanswerable), String(summary.remote.unanswerable)],
    [
      "correct accepts",
      String(summary.local.correctAccepts),
      String(summary.remote.correctAccepts),
    ],
    ["wrong accepts", String(summary.local.wrongAccepts), String(summary.remote.wrongAccepts)],
    [
      "correct rejects",
      String(summary.local.correctRejects),
      String(summary.remote.correctRejects),
    ],
    ["false accepts", String(summary.local.falseAccepts), String(summary.remote.falseAccepts)],
    ["false rejects", String(summary.local.falseRejects), String(summary.remote.falseRejects)],
    [
      "Top-1 correctness",
      `${String(summary.local.topOneCorrect)}/${String(summary.local.topOneScored)} (${percentage(summary.local.topOneCorrect, summary.local.topOneScored)})`,
      `${String(summary.remote.topOneCorrect)}/${String(summary.remote.topOneScored)} (${percentage(summary.remote.topOneCorrect, summary.remote.topOneScored)})`,
    ],
    ["accepted", String(summary.local.accepted), String(summary.remote.accepted)],
    ["rejected", String(summary.local.rejected), String(summary.remote.rejected)],
  ];
  for (const [label, local, remote] of rows) {
    console.log(`  ${label.padEnd(30)} ${local.padEnd(12)} ${remote}`);
  }

  heading("6. Local↔remote comparison");
  const total = outcomes.length;
  line(
    "Top-1 agreement",
    `${String(summary.topOneAgreement)}/${String(total)} (${percentage(summary.topOneAgreement, total)})`,
  );
  line(
    "full-ranking agreement",
    `${String(summary.rankingAgreement)}/${String(total)} (${percentage(summary.rankingAgreement, total)})`,
  );
  line(
    `Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk-set agreement`,
    `${String(summary.chunkSetAgreement)}/${String(total)} (${percentage(summary.chunkSetAgreement, total)})`,
  );
  line(
    "accept/reject agreement",
    `${String(summary.acceptAgreement)}/${String(total)} (${percentage(summary.acceptAgreement, total)})`,
  );
  line("threshold flips", String(summary.thresholdFlips));
  line(
    "new remote false accepts",
    summary.newFalseAccepts.length === 0 ? "0" : summary.newFalseAccepts.join(", "),
  );
  line(
    "new remote false rejects",
    summary.newFalseRejects.length === 0 ? "0" : summary.newFalseRejects.join(", "),
  );
  line(
    "resolved local errors",
    summary.resolvedLocalErrors.length === 0 ? "none" : summary.resolvedLocalErrors.join(", "),
  );
  line(
    "introduced remote errors",
    summary.introducedRemoteErrors.length === 0
      ? "none"
      : summary.introducedRemoteErrors.join(", "),
  );
  line(
    "score delta |Δ|",
    summary.absDeltas.length === 0
      ? "no chunk ranked on both sides"
      : `min ${Math.min(...summary.absDeltas).toFixed(9)}, mean ${mean(summary.absDeltas).toFixed(9)}, ` +
          `median ${percentile(summary.absDeltas, 0.5).toFixed(9)}, p95 ${percentile(summary.absDeltas, 0.95).toFixed(9)}, ` +
          `max ${Math.max(...summary.absDeltas).toFixed(9)} (over ${String(summary.absDeltas.length)} chunk pairs)`,
  );
  line(
    "score delta signed range",
    `${summary.signedDeltaMin.toFixed(9)} … ${summary.signedDeltaMax.toFixed(9)}`,
  );
  line(
    `within ${String(THRESHOLD_BAND)} below threshold`,
    `local ${String(summary.local.nearThreshold.below)}, remote ${String(summary.remote.nearThreshold.below)}`,
  );
  line(
    `within ±${String(THRESHOLD_BAND)} of threshold`,
    `local ${String(summary.local.nearThreshold.around)}, remote ${String(summary.remote.nearThreshold.around)}`,
  );
  line(
    `within ${String(THRESHOLD_BAND)} above threshold`,
    `local ${String(summary.local.nearThreshold.above)}, remote ${String(summary.remote.nearThreshold.above)}`,
  );
  line(
    "remote repeatability",
    `bit-identical ${String(summary.bitIdenticalCount)}/${String(total)}; ranking stable ${String(summary.repeatRankingStableCount)}/${String(total)}`,
  );
  line(
    "local arm vs accepted baseline",
    `${String(summary.baselineAgreement)}/${String(total)} identical Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)}`,
  );

  heading("7. Latency");
  line("remote cold call", `${String(summary.coldLatencyMs)} ms`);
  const warm = summary.warmLatencies;
  line(
    "remote warm",
    warm.length === 0
      ? "n/a"
      : `p50 ${String(percentile(warm, 0.5))} ms, p95 ${String(percentile(warm, 0.95))} ms, ` +
          `p99 ${String(percentile(warm, 0.99))} ms, max ${String(Math.max(...warm))} ms (${String(warm.length)} calls)`,
  );
  const localLatencies = outcomes.map((outcome) => outcome.localLatencyMs);
  line(
    "local",
    `cold ${String(localLatencies[0] ?? 0)} ms, warm mean ${String(Math.round(mean(localLatencies.slice(1))))} ms`,
  );

  reportProviderErrors(errors);
}

function reportProviderErrors(errors: ProviderErrorTally): void {
  heading("8. Provider errors");
  line("total", String(errors.total));
  line("401 unauthorized", String(errors.unauthorized401));
  line("403 forbidden", String(errors.forbidden403));
  line("429 rate limited", String(errors.rateLimited429));
  line("5xx server error", String(errors.serverError5xx));
  line("timeout", String(errors.timeout));
  line("transport failure", String(errors.transport));
  line("other HTTP", String(errors.otherHttp));
  line("invalid payload", String(errors.invalidPayload));
}

function reportDisagreements(disagreements: Disagreement[]): void {
  heading("8b. Individual disagreements");
  if (disagreements.length === 0) {
    console.log("  None. The two arms agreed on every dimension this evaluation measures.");
    return;
  }
  console.log(
    `  ${String(disagreements.length)} disagreement record(s), listed individually and not only summarised.\n`,
  );
  for (const item of disagreements) {
    console.log(`  [${item.kind}] ${item.id} — ${item.queryType}`);
    console.log(`    expected evidence   ${item.expectedEvidenceId ?? "— (unanswerable)"}`);
    console.log(`    expected chunk      ${item.expectedChunkKey ?? "— (unanswerable)"}`);
    console.log(`    local               ${item.localResult}`);
    console.log(`    remote              ${item.remoteResult}`);
    console.log(`    scores              ${item.scores}`);
    console.log(`    interpretation      ${item.interpretation}`);
    console.log("");
  }
}

function verdict(result: Decision["result"], notes: string[], reachedEnd: boolean): void {
  heading("Verdict");
  console.log(`  ${result}`);
  for (const note of notes) {
    console.log(`    - ${redact(note)}`);
  }
  if (result === "FAIL" || result === "INCONCLUSIVE") {
    process.exitCode = 1;
  }
  if (reachedEnd) {
    console.log("");
    console.log(
      "  Retrieval behaviour, not geometric similarity, is the acceptance criterion. No cosine\n" +
        "  threshold is defined or implied, and nothing downstream is unblocked by this run.",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------------------------

type ArtifactInput = {
  outcomes: QueryOutcome[];
  summary: Summary;
  disagreements: Disagreement[];
  providerErrors: ProviderErrorTally;
  dataset: FrozenInputs;
  corpus: { chunks: number; embeddings: number };
  verdictResult: Decision["result"];
  verdictNotes: string[];
  endpoint: string;
};

async function writeArtifacts(input: ArtifactInput): Promise<string[]> {
  const results = buildResultsArtifact(input);
  await writeGuarded(
    RESULTS_PATH,
    await formatFor(RESULTS_PATH, JSON.stringify(results)),
    (existing) => {
      const parsed = JSON.parse(existing) as { schemaVersion?: unknown };
      return parsed.schemaVersion === RESULTS_SCHEMA_VERSION;
    },
  );
  const report = buildReport(input);
  await writeGuarded(REPORT_PATH, await formatFor(REPORT_PATH, report), (existing) =>
    existing.startsWith(REPORT_MARKER),
  );
  return [RESULTS_PATH, REPORT_PATH];
}

/**
 * Writes only when the target does not exist, or exists and is recognisably a previous run of *this*
 * experiment. Any other content — above all an accepted baseline artifact — aborts the write instead
 * of being replaced.
 */
async function writeGuarded(
  relativePath: string,
  content: string,
  isOwnArtifact: (existing: string) => boolean,
): Promise<void> {
  const absolute = path.join(REPO_ROOT, relativePath);
  const existing = await readIfPresent(absolute);
  if (existing !== null) {
    let recognised: boolean;
    try {
      recognised = isOwnArtifact(existing);
    } catch {
      // Unparseable or unexpected content is treated as "not ours", which is the safe direction.
      recognised = false;
    }
    if (!recognised) {
      throw new Error(
        `Refusing to overwrite ${relativePath}: it exists and is not an artifact of this experiment.`,
      );
    }
  }
  await fs.writeFile(absolute, content, "utf8");
}

async function readIfPresent(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
}

async function formatFor(relativePath: string, content: string): Promise<string> {
  const absolute = path.join(REPO_ROOT, relativePath);
  const config = (await resolvePrettierConfig(absolute)) ?? {};
  return await formatWithPrettier(content, { ...config, filepath: absolute });
}

function buildResultsArtifact(input: ArtifactInput): unknown {
  const { summary } = input;
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    experiment: {
      id: "rag-remote-query-embedding-evaluation",
      gate: "Gate 5 — frozen 96-query evaluation",
      description:
        "Read-only comparison of the local and the Hugging Face hosted query embedding over the frozen " +
        "96-query mein-konto v1 development dataset, under the unchanged production retrieval contract.",
      evaluationTimestamp: new Date().toISOString(),
      productionBehaviorChanged: false,
      databaseMutationIntended: false,
      thresholdTuned: false,
      providerAbstractionImplemented: false,
    },
    frozenInputs: {
      ...input.dataset.hashes,
      acceptedBaselineId: input.dataset.baselineId,
      acceptedBaselineTimestamp: input.dataset.baselineTimestamp,
    },
    retrievalConfiguration: {
      // Recorded explicitly so a later reader can see that the SQL filter carried the local profile
      // identity even while the query vector came from elsewhere.
      sqlPassageEmbeddingProfileId: RAG_EMBEDDING_PROFILE.id,
      sqlPassageEmbeddingProfileSource: "frozen RAG_EMBEDDING_PROFILE",
      remoteIdentityUsedInSqlFilter: false,
      maxChunks: RAG_RETRIEVAL_MAX_CHUNKS,
      minScore: DEFAULT_RAG_RETRIEVAL_MIN_SCORE,
      similarityFunction: "cosine_similarity = 1 - (pgvector_cosine_distance)",
      rankingOrder: "score DESC, document_key ASC, document_version ASC, chunk_key ASC",
      activeChunkCount: input.corpus.chunks,
      activeProfileEmbeddingCount: input.corpus.embeddings,
    },
    arms: {
      local: {
        provider: RAG_EMBEDDING_PROFILE.provider,
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
        artifact: RAG_EMBEDDING_PROFILE.artifact,
        dtype: RAG_EMBEDDING_PROFILE.dtype,
        dimension: RAG_EMBEDDING_PROFILE.dimension,
        queryPrefix: RAG_EMBEDDING_PROFILE.queryPrefix,
      },
      remote: {
        provider: "huggingface-hf-inference",
        modelId: REMOTE_MODEL,
        modelRevision: null,
        revisionObservable: false,
        endpoint: input.endpoint,
        requestBody: {
          inputs: `${RAG_EMBEDDING_PROFILE.queryPrefix}<question>`,
          normalize: true,
          truncate: true,
          truncation_direction: "right",
        },
        callsPerQuery: REMOTE_CALL_COUNT,
        dimension: RAG_EMBEDDING_PROFILE.dimension,
      },
    },
    classificationDefinitions: {
      accepted: `at least one of the returned maxChunks scores >= ${DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2)}`,
      correctAccept: "answerable and an accepted chunk fully covers the labelled evidence",
      wrongAccept: "answerable, accepted, but no accepted chunk covers the labelled evidence",
      correctReject: "unanswerable and rejected",
      falseAccept: "unanswerable and accepted",
      falseReject: "answerable and rejected",
      topOneCorrect: "rank-1 chunk equals the chunk fully covering the expected evidence",
    },
    metrics: {
      local: summary.local,
      remote: summary.remote,
      comparison: {
        topOneAgreement: summary.topOneAgreement,
        fullRankingAgreement: summary.rankingAgreement,
        chunkSetAgreement: summary.chunkSetAgreement,
        acceptRejectAgreement: summary.acceptAgreement,
        thresholdFlips: summary.thresholdFlips,
        newRemoteFalseAccepts: summary.newFalseAccepts,
        newRemoteFalseRejects: summary.newFalseRejects,
        resolvedLocalErrors: summary.resolvedLocalErrors,
        introducedRemoteErrors: summary.introducedRemoteErrors,
        scoreDelta: {
          comparedChunkPairs: summary.absDeltas.length,
          absMin: round9(Math.min(...summary.absDeltas)),
          absMean: round9(mean(summary.absDeltas)),
          absMedian: round9(percentile(summary.absDeltas, 0.5)),
          absP95: round9(percentile(summary.absDeltas, 0.95)),
          absMax: round9(Math.max(...summary.absDeltas)),
          signedMin: round9(summary.signedDeltaMin),
          signedMax: round9(summary.signedDeltaMax),
        },
        remoteRepeatability: {
          callsPerQuery: REMOTE_CALL_COUNT,
          bitIdenticalQueries: summary.bitIdenticalCount,
          rankingStableQueries: summary.repeatRankingStableCount,
        },
        localArmReproducesAcceptedBaseline: summary.baselineAgreement === input.outcomes.length,
      },
      latencyMs: {
        remoteCold: summary.coldLatencyMs,
        remoteWarmP50: percentile(summary.warmLatencies, 0.5),
        remoteWarmP95: percentile(summary.warmLatencies, 0.95),
        remoteWarmP99: percentile(summary.warmLatencies, 0.99),
        remoteWarmMax: summary.warmLatencies.length === 0 ? 0 : Math.max(...summary.warmLatencies),
        remoteWarmCallCount: summary.warmLatencies.length,
        localCold: input.outcomes[0]?.localLatencyMs ?? 0,
        localWarmMean: Math.round(
          mean(input.outcomes.slice(1).map((outcome) => outcome.localLatencyMs)),
        ),
      },
      providerErrors: input.providerErrors,
    },
    disagreements: input.disagreements,
    verdict: { result: input.verdictResult, notes: input.verdictNotes },
    perQuery: input.outcomes.map((outcome) => ({
      id: outcome.id,
      queryType: outcome.queryType,
      answerability: outcome.answerability,
      faqIntentId: outcome.faqIntentId,
      expectedEvidenceId: outcome.expectedEvidenceId,
      expectedChunkKey: outcome.expectedChunkKey,
      localTopOneChunkKey: outcome.local.topChunkKey,
      remoteTopOneChunkKey: outcome.remote.topChunkKey,
      localRanking: outcome.local.ranking.map((chunk) => ({
        rank: chunk.rank,
        chunkKey: chunk.chunkKey,
        score: round6(chunk.score),
        rawScore: chunk.score,
      })),
      remoteRanking: outcome.remote.ranking.map((chunk) => ({
        rank: chunk.rank,
        chunkKey: chunk.chunkKey,
        score: round6(chunk.score),
        rawScore: chunk.score,
      })),
      scoreDeltas: outcome.scoreDeltas.map((delta) => ({
        chunkKey: delta.chunkKey,
        localScore: delta.localScore === null ? null : round6(delta.localScore),
        remoteScore: delta.remoteScore === null ? null : round6(delta.remoteScore),
        delta:
          delta.localScore === null || delta.remoteScore === null
            ? null
            : round9(delta.remoteScore - delta.localScore),
      })),
      localAccepted: outcome.local.accepted,
      remoteAccepted: outcome.remote.accepted,
      localAcceptedChunkKeys: outcome.local.acceptedChunkKeys,
      remoteAcceptedChunkKeys: outcome.remote.acceptedChunkKeys,
      localClassification: outcome.localClass,
      remoteClassification: outcome.remoteClass,
      topOneAgreement: outcome.topOneAgrees,
      fullRankingAgreement: outcome.rankingAgrees,
      chunkSetAgreement: outcome.chunkSetAgrees,
      acceptRejectAgreement: outcome.acceptAgrees,
      thresholdFlip: outcome.thresholdFlip,
      newFalseAccept: outcome.newFalseAccept,
      newFalseReject: outcome.newFalseReject,
      remoteLatencyMs: outcome.remoteLatenciesMs,
      remoteMeanLatencyMs: Math.round(mean(outcome.remoteLatenciesMs)),
      remoteBitIdentical: outcome.remoteBitIdentical,
      remoteMaxRepeatElementDelta: outcome.remoteMaxRepeatDelta,
      remoteRepeatRankingIdentical: outcome.remoteRepeatRankingIdentical,
      providerStatus: outcome.providerStatus,
      validation: outcome.validation,
      localL2Norm: round9(outcome.localNorm),
      remoteL2Norm: round9(outcome.remoteNorm),
      localLatencyMs: outcome.localLatencyMs,
      reproducesAcceptedBaselineTopChunks: outcome.baselineTopThreeAgrees,
    })),
  };
}

function buildReport(input: ArtifactInput): string {
  const { summary, outcomes } = input;
  const total = outcomes.length;
  const lines: string[] = [];

  lines.push(REPORT_MARKER);
  lines.push("");
  lines.push(
    "Gate 5. Read-only comparison of the existing local query embedding against the Hugging Face " +
      "hosted `intfloat/multilingual-e5-small` endpoint over the frozen 96-query `mein-konto` v1 " +
      "development dataset, under the unchanged production retrieval contract.",
  );
  lines.push("");
  lines.push(`**Verdict: ${input.verdictResult}**`);
  lines.push("");
  lines.push("## What this experiment did and did not do");
  lines.push("");
  lines.push(
    "- It changed no production code. No `QueryEmbeddingProvider` exists; the remote call lives in " +
      "`scripts/evaluate-rag-remote-query-embedding.ts` and is not intended to survive into `src/`.",
  );
  lines.push(
    "- It changed nothing about the retrieval space. The SQL passage-embedding filter bound the frozen " +
      `\`RAG_EMBEDDING_PROFILE\` (\`${RAG_EMBEDDING_PROFILE.id}\`) for **both** arms. The Hugging Face ` +
      "model identity, provider, revision, and dtype never entered that filter.",
  );
  lines.push(
    `- It used the production retrieval contract unchanged: \`maxChunks = ${String(RAG_RETRIEVAL_MAX_CHUNKS)}\`, ` +
      `threshold \`${DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2)}\`, the existing deterministic ranking, and the ` +
      `existing ${String(input.corpus.embeddings)} stored passage embeddings.`,
  );
  lines.push(
    "- The database session was read-only server-side and re-verified before every retrieval. No row " +
      "was inserted, updated, deleted, staged, or activated.",
  );
  lines.push(
    "- The frozen dataset, the manifest, and the accepted evidence→chunk mapping were verified by " +
      "SHA-256 against the hashes recorded in the accepted baseline before any query ran.",
  );
  lines.push("");
  lines.push("## Anchoring to the accepted baseline");
  lines.push("");
  lines.push(
    "The local arm was recomputed rather than lifted from the accepted baseline artifact, because that " +
      "artifact ranks the complete twelve-chunk set with no threshold, while this comparison must run " +
      "under the production contract. The recomputed arm was then checked against the accepted " +
      `baseline's first ${String(RAG_RETRIEVAL_MAX_CHUNKS)} ranks: ` +
      `**${String(summary.baselineAgreement)}/${String(total)}** queries reproduce it exactly at six-decimal precision. ` +
      "A divergence here would have meant the corpus, the profile, or the model cache had moved, and " +
      "the run would have stopped before the remote arm.",
  );
  lines.push("");
  lines.push("## Classification vocabulary");
  lines.push("");
  lines.push(
    `A query is **accepted** when at least one of the returned \`maxChunks\` scores at or above ` +
      `\`${DEFAULT_RAG_RETRIEVAL_MIN_SCORE.toFixed(2)}\` — that is, when the production retrieval path would return ` +
      "anything at all.",
  );
  lines.push("");
  lines.push("| Term | Applies to | Meaning |");
  lines.push("| --- | --- | --- |");
  lines.push(
    "| correct accept | answerable | accepted, and an accepted chunk fully covers the labelled evidence |",
  );
  lines.push(
    "| wrong accept | answerable | accepted, but no accepted chunk covers the labelled evidence |",
  );
  lines.push("| false reject | answerable | rejected although the corpus can answer it |");
  lines.push("| correct reject | unanswerable | rejected, as it should be |");
  lines.push(
    "| false accept | unanswerable | accepted, so an answer would be grounded in an uncovering passage |",
  );
  lines.push("");
  lines.push("## Arm summaries");
  lines.push("");
  lines.push("| Metric | Local | Remote |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| Total queries | ${String(summary.local.total)} | ${String(summary.remote.total)} |`,
  );
  lines.push(
    `| Answerable | ${String(summary.local.answerable)} | ${String(summary.remote.answerable)} |`,
  );
  lines.push(
    `| Unanswerable | ${String(summary.local.unanswerable)} | ${String(summary.remote.unanswerable)} |`,
  );
  lines.push(
    `| Correct accepts | ${String(summary.local.correctAccepts)} | ${String(summary.remote.correctAccepts)} |`,
  );
  lines.push(
    `| Wrong accepts | ${String(summary.local.wrongAccepts)} | ${String(summary.remote.wrongAccepts)} |`,
  );
  lines.push(
    `| Correct rejects | ${String(summary.local.correctRejects)} | ${String(summary.remote.correctRejects)} |`,
  );
  lines.push(
    `| False accepts | ${String(summary.local.falseAccepts)} | ${String(summary.remote.falseAccepts)} |`,
  );
  lines.push(
    `| False rejects | ${String(summary.local.falseRejects)} | ${String(summary.remote.falseRejects)} |`,
  );
  lines.push(
    `| Top-1 correctness | ${String(summary.local.topOneCorrect)}/${String(summary.local.topOneScored)} (${percentage(summary.local.topOneCorrect, summary.local.topOneScored)}) | ${String(summary.remote.topOneCorrect)}/${String(summary.remote.topOneScored)} (${percentage(summary.remote.topOneCorrect, summary.remote.topOneScored)}) |`,
  );
  lines.push(
    `| Accepted | ${String(summary.local.accepted)} | ${String(summary.remote.accepted)} |`,
  );
  lines.push(
    `| Rejected | ${String(summary.local.rejected)} | ${String(summary.remote.rejected)} |`,
  );
  lines.push("");
  lines.push("## Local↔remote comparison");
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("| --- | --- |");
  lines.push(
    `| Top-1 agreement | ${String(summary.topOneAgreement)}/${String(total)} (${percentage(summary.topOneAgreement, total)}) |`,
  );
  lines.push(
    `| Full-ranking agreement | ${String(summary.rankingAgreement)}/${String(total)} (${percentage(summary.rankingAgreement, total)}) |`,
  );
  lines.push(
    `| Top-${String(RAG_RETRIEVAL_MAX_CHUNKS)} chunk-set agreement | ${String(summary.chunkSetAgreement)}/${String(total)} (${percentage(summary.chunkSetAgreement, total)}) |`,
  );
  lines.push(
    `| Accept/reject agreement | ${String(summary.acceptAgreement)}/${String(total)} (${percentage(summary.acceptAgreement, total)}) |`,
  );
  lines.push(`| Threshold flips | ${String(summary.thresholdFlips)} |`);
  lines.push(
    `| New remote false accepts | ${summary.newFalseAccepts.length === 0 ? "0" : summary.newFalseAccepts.join(", ")} |`,
  );
  lines.push(
    `| New remote false rejects | ${summary.newFalseRejects.length === 0 ? "0" : summary.newFalseRejects.join(", ")} |`,
  );
  lines.push(
    `| Resolved local errors | ${summary.resolvedLocalErrors.length === 0 ? "none" : summary.resolvedLocalErrors.join(", ")} |`,
  );
  lines.push(
    `| Introduced remote errors | ${summary.introducedRemoteErrors.length === 0 ? "none" : summary.introducedRemoteErrors.join(", ")} |`,
  );
  lines.push(
    `| Score delta \\|Δ\\| | min ${Math.min(...summary.absDeltas).toFixed(6)}, mean ${mean(summary.absDeltas).toFixed(6)}, median ${percentile(summary.absDeltas, 0.5).toFixed(6)}, p95 ${percentile(summary.absDeltas, 0.95).toFixed(6)}, max ${Math.max(...summary.absDeltas).toFixed(6)} |`,
  );
  lines.push(
    `| Score delta signed range | ${summary.signedDeltaMin.toFixed(6)} … ${summary.signedDeltaMax.toFixed(6)} |`,
  );
  lines.push(
    `| Top score within ${String(THRESHOLD_BAND)} below threshold | local ${String(summary.local.nearThreshold.below)}, remote ${String(summary.remote.nearThreshold.below)} |`,
  );
  lines.push(
    `| Top score within ±${String(THRESHOLD_BAND)} of threshold | local ${String(summary.local.nearThreshold.around)}, remote ${String(summary.remote.nearThreshold.around)} |`,
  );
  lines.push(
    `| Top score within ${String(THRESHOLD_BAND)} above threshold | local ${String(summary.local.nearThreshold.above)}, remote ${String(summary.remote.nearThreshold.above)} |`,
  );
  lines.push(
    `| Remote repeatability | bit-identical ${String(summary.bitIdenticalCount)}/${String(total)}, ranking stable ${String(summary.repeatRankingStableCount)}/${String(total)} |`,
  );
  lines.push("");
  lines.push("## Latency");
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Remote cold call | ${String(summary.coldLatencyMs)} ms |`);
  lines.push(`| Remote warm p50 | ${String(percentile(summary.warmLatencies, 0.5))} ms |`);
  lines.push(`| Remote warm p95 | ${String(percentile(summary.warmLatencies, 0.95))} ms |`);
  lines.push(`| Remote warm p99 | ${String(percentile(summary.warmLatencies, 0.99))} ms |`);
  lines.push(
    `| Remote warm max | ${String(summary.warmLatencies.length === 0 ? 0 : Math.max(...summary.warmLatencies))} ms |`,
  );
  lines.push(`| Remote warm calls measured | ${String(summary.warmLatencies.length)} |`);
  lines.push(`| Local cold | ${String(outcomes[0]?.localLatencyMs ?? 0)} ms |`);
  lines.push(
    `| Local warm mean | ${String(Math.round(mean(outcomes.slice(1).map((outcome) => outcome.localLatencyMs))))} ms |`,
  );
  lines.push("");
  lines.push(
    "Latency was measured from a development machine, not from the deployment target. It bounds " +
      "nothing about production and is recorded as an observation only.",
  );
  lines.push("");
  lines.push("## Provider errors");
  lines.push("");
  lines.push("| Class | Count |");
  lines.push("| --- | --- |");
  lines.push(`| Total | ${String(input.providerErrors.total)} |`);
  lines.push(`| 401 unauthorized | ${String(input.providerErrors.unauthorized401)} |`);
  lines.push(`| 403 forbidden | ${String(input.providerErrors.forbidden403)} |`);
  lines.push(`| 429 rate limited | ${String(input.providerErrors.rateLimited429)} |`);
  lines.push(`| 5xx server error | ${String(input.providerErrors.serverError5xx)} |`);
  lines.push(`| Timeout | ${String(input.providerErrors.timeout)} |`);
  lines.push(`| Transport failure | ${String(input.providerErrors.transport)} |`);
  lines.push(`| Other HTTP | ${String(input.providerErrors.otherHttp)} |`);
  lines.push(`| Invalid payload | ${String(input.providerErrors.invalidPayload)} |`);
  lines.push("");
  lines.push("## Individual disagreements");
  lines.push("");
  if (input.disagreements.length === 0) {
    lines.push("None. The two arms agreed on every dimension this evaluation measures.");
  } else {
    lines.push(
      `${String(input.disagreements.length)} disagreement record(s). Each is listed individually below; ` +
        "none is represented only by a summary percentage.",
    );
    lines.push("");
    for (const item of input.disagreements) {
      lines.push(`### ${item.id} — ${item.kind}`);
      lines.push("");
      lines.push(`- **Query type:** ${item.queryType}`);
      lines.push(`- **Expected evidence:** ${item.expectedEvidenceId ?? "— (unanswerable)"}`);
      lines.push(`- **Expected chunk:** ${item.expectedChunkKey ?? "— (unanswerable)"}`);
      lines.push(`- **Local:** ${item.localResult}`);
      lines.push(`- **Remote:** ${item.remoteResult}`);
      lines.push(`- **Scores:** ${item.scores}`);
      lines.push(`- **Interpretation:** ${item.interpretation}`);
      lines.push("");
    }
  }
  lines.push("## Verdict");
  lines.push("");
  lines.push(`**${input.verdictResult}**`);
  lines.push("");
  for (const note of input.verdictNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push(
    "Retrieval behaviour, not geometric similarity, is the acceptance criterion here. No cosine " +
      "threshold is defined or implied by this experiment.",
  );
  lines.push("");
  lines.push("## Accepted limitations");
  lines.push("");
  lines.push(
    "- **The served remote revision is unpinnable.** The endpoint returns no `X-Repo-Commit` header " +
      "(Gate 3), so there is no way to detect the provider serving different weights between runs. " +
      "Every result here is valid for the weights served during this run and nothing more.",
  );
  lines.push(
    "- **Latency is not production latency.** It was measured from a development machine over a " +
      "residential path, not from the deployment target.",
  );
  lines.push(
    "- **Only the query side was swapped.** The passage embeddings remain the local int8 ONNX " +
      "artifacts. This experiment says nothing about re-embedding the corpus remotely.",
  );
  lines.push(
    "- **One document, one language.** The corpus is the twelve `mein-konto` v1 chunks in German. " +
      "Nothing here generalises to a second source or a second language.",
  );
  lines.push("");
  lines.push("## Reproduction");
  lines.push("");
  lines.push("```");
  lines.push("npx tsx scripts/evaluate-rag-remote-query-embedding.ts");
  lines.push("```");
  lines.push("");
  lines.push(
    "Requires `HF_TOKEN` and `DATABASE_URL` in `.env`. The script is read-only against the database " +
      "and writes only this report and its results artifact.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Database
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
 * `[D]` Read-only is enforced by the *server*, not by the discipline of this file, and it is verified
 * rather than assumed. The pool is capped at one connection so the session setting cannot land on a
 * connection other than the one the reads run on, and both the set and the check are repeated before
 * every retrieval because `pg` discards a client that errored and replaces it with a fresh — and
 * therefore writable — session.
 */
async function assertReadOnlySession(pool: pg.Pool): Promise<void> {
  await pool.query("SET SESSION default_transaction_read_only = on");
  const result = await pool.query<{ read_only: string }>(
    "SELECT current_setting('transaction_read_only') AS read_only",
  );
  if (result.rows[0]?.read_only !== "on") {
    throw new Error("Refusing to query: the database session is not read-only.");
  }
}

async function readCorpusCounts(pool: pg.Pool): Promise<{ chunks: number; embeddings: number }> {
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
  return { chunks: row?.chunks ?? 0, embeddings: row?.embeddings ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Vector maths and small helpers
// ---------------------------------------------------------------------------------------------

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function vectorsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function maxAbsoluteDelta(a: readonly number[], b: readonly number[]): number {
  return a.reduce((max, value, index) => Math.max(max, Math.abs(value - (b[index] ?? 0))), 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile. Exact and order-statistic based; no interpolation to argue about. */
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function percentage(count: number, total: number): string {
  return total === 0 ? "n/a" : `${((count / total) * 100).toFixed(1)}%`;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function round9(value: number): number {
  return Number(value.toFixed(9));
}

function fmtScore(score: number | null): string {
  return score === null ? "—" : score.toFixed(6);
}

function shortChunk(chunkKey: string | null): string {
  return chunkKey === null ? "—" : chunkKey.replace("mein-konto:v1:", "");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function heading(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${redact(value)}`);
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
    console.error(`${name} must be set to run Experiment C.\n${guidance}`);
    process.exit(1);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

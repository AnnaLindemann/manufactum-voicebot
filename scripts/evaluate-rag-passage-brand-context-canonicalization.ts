import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from "prettier";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../src/rag/embedding-profile.js";

type QueryType =
  | "exact"
  | "paraphrased"
  | "short"
  | "conversational"
  | "ambiguous_answerable"
  | "hard_negative"
  | "irrelevant";

type Answerability = "answerable" | "unanswerable";

type DevelopmentQuery = {
  id: string;
  dataset: "development";
  query: string;
  queryType: QueryType;
  answerability: Answerability;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
};

type ActiveChunk = {
  documentKey: string;
  documentVersion: number;
  chunkIndex: number;
  chunkKey: string;
  question: string;
  answer: string;
  contentHash: string;
};

type RankedChunk = {
  rank: number;
  chunkKey: string;
  chunkHash: string;
  documentKey: string;
  documentVersion: number;
  score: number;
  acceptableEvidenceIdsWithFullCoverage: string[];
};

export type ExperimentQueryResult = {
  id: string;
  query: string;
  queryType: QueryType;
  answerability: Answerability;
  containsManufactumToken: boolean;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
  queryEmbeddingInputHash: string;
  queryEmbeddingTokenCount: number;
  baselineQueryEmbeddingInputHash: string;
  queryInputByteIdenticalToBaseline: boolean;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  expectedScore: number | null;
  rankings: RankedChunk[];
};

type BaselineQueryResult = {
  id: string;
  queryEmbeddingInputHash: string;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  rankings: RankedChunk[];
};

type BaselineArtifact = {
  schemaVersion: "rag-development-baseline-retrieval-results-v1";
  frozenInputs: {
    datasetPath: string;
    datasetVersion: string;
    datasetSha256: string;
    manifestPath: string;
    manifestSha256: string;
    evidenceInventoryPath: string;
    evidenceInventorySha256: string;
  };
  activeDocument: {
    documentKey: string;
    currentVersion: number;
    contentHash: string;
  };
  activeChunkSet: {
    chunkCount: number;
    orderedChunks: {
      chunkIndex: number;
      chunkKey: string;
      chunkHash: string;
      embeddingInputHash: string | null;
      embeddingChunkContentHash: string | null;
    }[];
  };
  embeddingProfile: {
    id: string;
    modelId: string;
    modelRevision: string;
    artifact: string;
    dimension: number;
    normalized: boolean;
    queryPrefix: string;
    queryInputRecipe: string;
  };
  metrics: Metrics;
  perQuery: BaselineQueryResult[];
};

type EvidenceMappingArtifact = {
  schemaVersion: "rag-baseline-evidence-chunk-mapping-v1";
  frozenInputs: {
    datasetSha256: string;
    manifestSha256: string;
    evidenceInventorySha256: string;
  };
  evidenceMappings: {
    evidenceId: string;
    faqIntentId: string;
    fullCoverageChunkKeys: string[];
  }[];
};

type Metrics = {
  answerable: {
    count: number;
    recallAt1: number;
    recallAt3: number;
    mrr: number;
  };
  byQueryType: Record<string, GroupMetric>;
  byFaqIntentId: Record<string, GroupMetric>;
  firstAcceptableRanks: Record<string, number | null>;
  scoreDistributions: {
    answerable: ScoreDistribution;
    hard_negative: ScoreDistribution;
    irrelevant: ScoreDistribution;
  };
};

type GroupMetric = {
  count: number;
  answerableCount: number;
  recallAt1: number | null;
  recallAt3: number | null;
  mrr: number | null;
  topScoreDistribution: ScoreDistribution;
};

type ScoreDistribution = {
  count: number;
  minTopScore: number | null;
  p50TopScore: number | null;
  p90TopScore: number | null;
  maxTopScore: number | null;
  meanTopScore: number | null;
  minTopScoreMargin: number | null;
  p50TopScoreMargin: number | null;
  meanTopScoreMargin: number | null;
};

type CandidatePassage = {
  chunkKey: string;
  controlRepresentation: string;
  candidateRepresentation: string;
  manufactumStandaloneOccurrences: number;
  removedStandaloneManufactumOccurrences: number;
  inputHash: string;
  tokenCount: number;
  embedding: number[];
};

const DATASET_PATH = "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json";
const BASELINE_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json";
const MAPPING_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json";
const DEFAULT_OUTPUT_PATH =
  "docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json";
const DOCUMENT_KEY = "mein-konto";
const TOP_K_FOR_RECALL = 3;
const WATCH_TARGET_IDS = [
  "mein-konto-v1-dev-014",
  "mein-konto-v1-dev-015",
  "mein-konto-v1-dev-020",
  "mein-konto-v1-dev-035",
  "mein-konto-v1-dev-048",
  "mein-konto-v1-dev-062",
];
const WATCH_OTHER_IDS = ["mein-konto-v1-dev-057", "mein-konto-v1-dev-069"];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for the passage representation experiment.");
  }

  const outputPath = cliValue("--output") ?? DEFAULT_OUTPUT_PATH;
  const datasetBefore = await readJsonFile<DevelopmentQuery[]>(DATASET_PATH);
  const baselineBefore = await readJsonFile<BaselineArtifact>(BASELINE_PATH);
  const mappingBefore = await readJsonFile<EvidenceMappingArtifact>(MAPPING_PATH);
  validateAcceptedInputs(datasetBefore, baselineBefore, mappingBefore);

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
  };
  const cacheDir = process.env.TRANSFORMERS_CACHE?.trim();
  if (cacheDir !== undefined && cacheDir.length > 0) {
    generatorOptions.cacheDir = cacheDir;
  }

  const pool = new pg.Pool({ connectionString });
  const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const chunks = await readActiveChunks(client);
    validateActiveChunksAgainstBaseline(chunks, baselineBefore.value);
    const candidatePassages = await embedCandidatePassages(chunks, generator);
    const perQuery = (
      await evaluateQueries({
        dataset: datasetBefore.value,
        baseline: baselineBefore.value,
        mapping: mappingBefore.value,
        chunks,
        candidatePassages,
        generator,
      })
    ).map(roundQueryResult);
    const metrics = computeMetrics(perQuery);
    const comparisons = compareWithBaseline(baselineBefore.value, perQuery);
    const result = {
      schemaVersion: "rag-passage-brand-context-canonicalization-experiment-results-v1",
      experiment: {
        id: "passage-brand-context-canonicalization",
        gitCommit: gitCommit(),
        evaluationTimestamp: new Date().toISOString(),
        productionBehaviorChanged: false,
        databaseMutationIntended: false,
        activationIntended: false,
        thresholdTuned: false,
      },
      frozenInputs: {
        datasetPath: DATASET_PATH,
        datasetSha256: datasetBefore.sha256,
        baselinePath: BASELINE_PATH,
        baselineSha256: baselineBefore.sha256,
        mappingPath: MAPPING_PATH,
        mappingSha256: mappingBefore.sha256,
      },
      embeddingProfile: {
        id: RAG_EMBEDDING_PROFILE.id,
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
        artifact: RAG_EMBEDDING_PROFILE.artifact,
        dimension: RAG_EMBEDDING_PROFILE.dimension,
        normalized: RAG_EMBEDDING_PROFILE.normalized,
        passagePrefix: RAG_EMBEDDING_PROFILE.passagePrefix,
        queryPrefix: RAG_EMBEDDING_PROFILE.queryPrefix,
        passageInputRecipe: RAG_EMBEDDING_PROFILE.passageInputRecipe,
        queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
      },
      independentVariable: {
        changedOnly: "candidate passage embedding representation",
        controlRepresentationRule: "Frage: {originalQuestion}\\n\\nAntwort: {originalAnswer}",
        candidateRepresentationRule:
          "Marke: Manufactum\\n\\nFrage: {originalQuestion with standalone case-insensitive Manufactum removed}\\n\\nAntwort: {originalAnswer with standalone case-insensitive Manufactum removed}",
        whitespaceNormalization:
          "Collapse whitespace created by removal to single spaces and trim.",
        queryTextChanged: false,
        queryEmbeddingBehaviorChanged: false,
        rankingScope: "complete 12-chunk candidate set",
        similarityFunction: "cosine_similarity = dot_product over normalized embeddings",
        topKForRecall: TOP_K_FOR_RECALL,
        thresholdApplied: false,
        databaseWrites: false,
      },
      candidatePassageInputs: candidatePassages.map((passage) => ({
        chunkKey: passage.chunkKey,
        controlRepresentationSha256: sha256Hex(passage.controlRepresentation),
        candidateRepresentationSha256: sha256Hex(passage.candidateRepresentation),
        candidateEmbeddingInputHash: passage.inputHash,
        candidateEmbeddingTokenCount: passage.tokenCount,
        manufactumStandaloneOccurrences: passage.manufactumStandaloneOccurrences,
        removedStandaloneManufactumOccurrences: passage.removedStandaloneManufactumOccurrences,
      })),
      queryInputProof: {
        byteIdenticalToBaselineCount: perQuery.filter(
          (query) => query.queryInputByteIdenticalToBaseline,
        ).length,
        total: perQuery.length,
        allByteIdenticalToBaseline: perQuery.every(
          (query) => query.queryInputByteIdenticalToBaseline,
        ),
      },
      metrics: {
        baseline: baselineBefore.value.metrics,
        candidate: metrics,
        deltas: metricDeltas(baselineBefore.value.metrics, metrics),
      },
      comparisons,
      perQuery,
      decision: decide(baselineBefore.value.metrics, metrics, comparisons),
    };

    await client.query("COMMIT");
    await writeJson(outputPath, result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  await assertFileSha256(DATASET_PATH, datasetBefore.sha256, "Development dataset");
  await assertFileSha256(BASELINE_PATH, baselineBefore.sha256, "Accepted baseline artifact");
  await assertFileSha256(MAPPING_PATH, mappingBefore.sha256, "Accepted evidence mapping");
}

export function buildControlPassageRepresentation(input: {
  originalQuestion: string;
  originalAnswer: string;
}): string {
  return `Frage: ${input.originalQuestion}\n\nAntwort: ${input.originalAnswer}`;
}

export function buildCandidatePassageRepresentation(input: {
  originalQuestion: string;
  originalAnswer: string;
}): { representation: string; removedStandaloneManufactumOccurrences: number } {
  const question = removeStandaloneManufactum(input.originalQuestion);
  const answer = removeStandaloneManufactum(input.originalAnswer);
  return {
    representation: `Marke: Manufactum\n\nFrage: ${question.text}\n\nAntwort: ${answer.text}`,
    removedStandaloneManufactumOccurrences:
      question.removedStandaloneManufactumOccurrences +
      answer.removedStandaloneManufactumOccurrences,
  };
}

export function countStandaloneManufactum(input: string): number {
  return [...input.matchAll(standaloneManufactumRegex())].length;
}

function removeStandaloneManufactum(input: string): {
  text: string;
  removedStandaloneManufactumOccurrences: number;
} {
  const removedStandaloneManufactumOccurrences = countStandaloneManufactum(input);
  return {
    text: input.replace(standaloneManufactumRegex(), " ").replace(/\s+/g, " ").trim(),
    removedStandaloneManufactumOccurrences,
  };
}

function standaloneManufactumRegex(): RegExp {
  return /(?<![\p{L}\p{N}_])Manufactum(?![\p{L}\p{N}_])/giu;
}

async function evaluateQueries(input: {
  dataset: DevelopmentQuery[];
  baseline: BaselineArtifact;
  mapping: EvidenceMappingArtifact;
  chunks: ActiveChunk[];
  candidatePassages: CandidatePassage[];
  generator: TransformersE5SmallPassageEmbeddingGenerator;
}): Promise<ExperimentQueryResult[]> {
  const baselineById = new Map(input.baseline.perQuery.map((query) => [query.id, query]));
  const results: ExperimentQueryResult[] = [];
  for (const record of input.dataset) {
    const baseline = baselineById.get(record.id);
    if (baseline === undefined) {
      throw new Error(`Baseline artifact has no result for ${record.id}.`);
    }
    const queryEmbedding = await input.generator.embedQuery(record.query);
    const rankings = rankCandidateChunks({
      queryEmbedding: queryEmbedding.embedding,
      chunks: input.chunks,
      candidatePassages: input.candidatePassages,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      mapping: input.mapping,
    });
    const firstAcceptableRank =
      record.answerability === "answerable"
        ? (rankings.find((ranking) => ranking.acceptableEvidenceIdsWithFullCoverage.length > 0)
            ?.rank ?? null)
        : null;
    const topScore = rankings[0]?.score ?? null;
    const secondScore = rankings[1]?.score ?? null;
    const expectedScore =
      firstAcceptableRank === null
        ? null
        : (rankings.find((ranking) => ranking.rank === firstAcceptableRank)?.score ?? null);
    results.push({
      id: record.id,
      query: record.query,
      queryType: record.queryType,
      answerability: record.answerability,
      containsManufactumToken: countStandaloneManufactum(record.query) > 0,
      faqIntentId: record.faqIntentId,
      expectedEvidenceId: record.expectedEvidenceId,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      queryEmbeddingInputHash: queryEmbedding.inputHash,
      queryEmbeddingTokenCount: queryEmbedding.tokenCount,
      baselineQueryEmbeddingInputHash: baseline.queryEmbeddingInputHash,
      queryInputByteIdenticalToBaseline:
        queryEmbedding.inputHash === baseline.queryEmbeddingInputHash,
      firstAcceptableRank,
      recallAt1:
        record.answerability === "answerable"
          ? firstAcceptableRank !== null && firstAcceptableRank <= 1
          : null,
      recallAt3:
        record.answerability === "answerable"
          ? firstAcceptableRank !== null && firstAcceptableRank <= TOP_K_FOR_RECALL
          : null,
      reciprocalRank: firstAcceptableRank === null ? 0 : 1 / firstAcceptableRank,
      topScore,
      topScoreMargin: topScore === null || secondScore === null ? null : topScore - secondScore,
      expectedScore,
      rankings,
    });
  }
  return results;
}

function rankCandidateChunks(input: {
  queryEmbedding: number[];
  chunks: ActiveChunk[];
  candidatePassages: CandidatePassage[];
  acceptableEvidenceIds: string[];
  mapping: EvidenceMappingArtifact;
}): RankedChunk[] {
  const passageByChunkKey = new Map(
    input.candidatePassages.map((passage) => [passage.chunkKey, passage]),
  );
  return input.chunks
    .map((chunk) => {
      const passage = passageByChunkKey.get(chunk.chunkKey);
      if (passage === undefined) {
        throw new Error(`Missing candidate embedding for ${chunk.chunkKey}.`);
      }
      const acceptableEvidenceIdsWithFullCoverage = input.acceptableEvidenceIds.filter(
        (evidenceId) => {
          const mapping = input.mapping.evidenceMappings.find(
            (item) => item.evidenceId === evidenceId,
          );
          return mapping?.fullCoverageChunkKeys.includes(chunk.chunkKey) === true;
        },
      );
      return {
        rank: 0,
        chunkKey: chunk.chunkKey,
        chunkHash: chunk.contentHash,
        documentKey: chunk.documentKey,
        documentVersion: chunk.documentVersion,
        score: dotProduct(input.queryEmbedding, passage.embedding),
        acceptableEvidenceIdsWithFullCoverage,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.documentKey.localeCompare(right.documentKey) ||
        left.documentVersion - right.documentVersion ||
        left.chunkKey.localeCompare(right.chunkKey),
    )
    .map((ranking, index) => ({ ...ranking, rank: index + 1 }));
}

async function embedCandidatePassages(
  chunks: ActiveChunk[],
  generator: TransformersE5SmallPassageEmbeddingGenerator,
): Promise<CandidatePassage[]> {
  const passages: CandidatePassage[] = [];
  for (const chunk of chunks) {
    const controlRepresentation = buildControlPassageRepresentation({
      originalQuestion: chunk.question,
      originalAnswer: chunk.answer,
    });
    const candidate = buildCandidatePassageRepresentation({
      originalQuestion: chunk.question,
      originalAnswer: chunk.answer,
    });
    const manufactumStandaloneOccurrences = countStandaloneManufactum(candidate.representation);
    if (manufactumStandaloneOccurrences !== 1) {
      throw new Error(
        `Candidate representation for ${chunk.chunkKey} contains ${String(
          manufactumStandaloneOccurrences,
        )} standalone Manufactum occurrences.`,
      );
    }
    const embedding = await generator.embedPassage(candidate.representation);
    passages.push({
      chunkKey: chunk.chunkKey,
      controlRepresentation,
      candidateRepresentation: candidate.representation,
      manufactumStandaloneOccurrences,
      removedStandaloneManufactumOccurrences: candidate.removedStandaloneManufactumOccurrences,
      inputHash: embedding.inputHash,
      tokenCount: embedding.tokenCount,
      embedding: embedding.embedding,
    });
  }
  return passages;
}

async function readActiveChunks(client: pg.PoolClient): Promise<ActiveChunk[]> {
  const result = await client.query<{
    document_key: string;
    document_version: number;
    chunk_index: number;
    chunk_key: string;
    question: string;
    answer: string;
    content_hash: string;
  }>(
    `SELECT c.document_key, c.document_version, c.chunk_index, c.chunk_key, c.question,
            c.answer, c.content_hash
       FROM rag_chunks c
       JOIN rag_documents d ON d.document_key = c.document_key
      WHERE c.document_key = $1 AND c.document_version = d.current_version
      ORDER BY c.chunk_index ASC`,
    [DOCUMENT_KEY],
  );
  return result.rows.map((row) => ({
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkIndex: row.chunk_index,
    chunkKey: row.chunk_key,
    question: row.question,
    answer: row.answer,
    contentHash: row.content_hash,
  }));
}

function validateAcceptedInputs(
  dataset: { value: DevelopmentQuery[]; sha256: string },
  baseline: { value: BaselineArtifact; sha256: string },
  mapping: { value: EvidenceMappingArtifact; sha256: string },
): void {
  if (baseline.value.schemaVersion !== "rag-development-baseline-retrieval-results-v1") {
    throw new Error("Unexpected baseline artifact schema.");
  }
  if (dataset.sha256 !== baseline.value.frozenInputs.datasetSha256) {
    throw new Error("Development dataset does not match the accepted baseline artifact.");
  }
  if (dataset.value.length !== 96) {
    throw new Error(`Expected 96 development queries, found ${String(dataset.value.length)}.`);
  }
  const expectedIds = dataset.value.map(
    (_record, index) => `mein-konto-v1-dev-${String(index + 1).padStart(3, "0")}`,
  );
  const ids = dataset.value.map((record) => record.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    throw new Error("Development query IDs are not in deterministic 001-096 order.");
  }
  if (JSON.stringify(ids) !== JSON.stringify(baseline.value.perQuery.map((record) => record.id))) {
    throw new Error("Baseline artifact query order does not match the frozen dataset.");
  }
  if (mapping.value.schemaVersion !== "rag-baseline-evidence-chunk-mapping-v1") {
    throw new Error("Unexpected evidence mapping schema.");
  }
  if (mapping.value.frozenInputs.datasetSha256 !== dataset.sha256) {
    throw new Error("Evidence mapping dataset SHA-256 does not match the frozen dataset.");
  }
  if (mapping.value.frozenInputs.manifestSha256 !== baseline.value.frozenInputs.manifestSha256) {
    throw new Error("Evidence mapping manifest SHA-256 does not match the accepted baseline.");
  }
  if (
    mapping.value.frozenInputs.evidenceInventorySha256 !==
    baseline.value.frozenInputs.evidenceInventorySha256
  ) {
    throw new Error("Evidence mapping inventory SHA-256 does not match the accepted baseline.");
  }
  if (baseline.value.activeChunkSet.chunkCount !== 12) {
    throw new Error("Accepted baseline does not rank the expected 12 chunks.");
  }
  if (
    baseline.value.embeddingProfile.id !== RAG_EMBEDDING_PROFILE.id ||
    baseline.value.embeddingProfile.dimension !== RAG_EMBEDDING_PROFILE.dimension
  ) {
    throw new Error(
      "Accepted baseline embedding profile does not match the pinned production profile.",
    );
  }
}

function validateActiveChunksAgainstBaseline(
  chunks: ActiveChunk[],
  baseline: BaselineArtifact,
): void {
  if (chunks.length !== 12) {
    throw new Error(`Expected 12 active chunks, found ${String(chunks.length)}.`);
  }
  const expected = baseline.activeChunkSet.orderedChunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    chunkKey: chunk.chunkKey,
    chunkHash: chunk.chunkHash,
  }));
  const actual = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    chunkKey: chunk.chunkKey,
    chunkHash: chunk.contentHash,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Active chunk set differs from the accepted baseline chunk set.");
  }
}

function computeMetrics(results: ExperimentQueryResult[]): Metrics {
  const answerable = results.filter((result) => result.answerability === "answerable");
  return {
    answerable: {
      count: answerable.length,
      recallAt1: ratio(
        answerable.filter((result) => result.recallAt1 === true).length,
        answerable.length,
      ),
      recallAt3: ratio(
        answerable.filter((result) => result.recallAt3 === true).length,
        answerable.length,
      ),
      mrr: ratio(
        answerable.reduce((sum, result) => sum + result.reciprocalRank, 0),
        answerable.length,
      ),
    },
    byQueryType: groupMetrics(results, (result) => result.queryType),
    byFaqIntentId: groupMetrics(answerable, (result) => result.faqIntentId ?? "null"),
    firstAcceptableRanks: Object.fromEntries(
      answerable.map((result) => [result.id, result.firstAcceptableRank]),
    ),
    scoreDistributions: {
      answerable: scoreDistribution(answerable),
      hard_negative: scoreDistribution(
        results.filter((result) => result.queryType === "hard_negative"),
      ),
      irrelevant: scoreDistribution(results.filter((result) => result.queryType === "irrelevant")),
    },
  };
}

function compareWithBaseline(baseline: BaselineArtifact, candidate: ExperimentQueryResult[]) {
  const baselineById = new Map(baseline.perQuery.map((query) => [query.id, query]));
  const answerableChanges = candidate
    .filter((query) => query.answerability === "answerable")
    .map((query) => {
      const baselineQuery = baselineById.get(query.id);
      if (baselineQuery === undefined) {
        throw new Error(`Missing baseline query ${query.id}.`);
      }
      return queryComparison(baselineQuery, query);
    })
    .filter((change) => change.rankChanged);
  const newlyCorrectedTop1 = answerableChanges.filter(
    (change) =>
      change.baseline.firstAcceptableRank !== 1 && change.candidate.firstAcceptableRank === 1,
  );
  const regressedTop1 = answerableChanges.filter(
    (change) =>
      change.baseline.firstAcceptableRank === 1 && change.candidate.firstAcceptableRank !== 1,
  );
  const currentlyCorrectBrandContaining = candidate
    .filter((query) => query.answerability === "answerable" && query.containsManufactumToken)
    .map((query) => queryComparison(baselineById.get(query.id)!, query))
    .filter((change) => change.baseline.firstAcceptableRank === 1 && change.rankChanged);
  return {
    answerableRankChanges: answerableChanges,
    newlyCorrectedTop1,
    previouslyCorrectTop1Regressions: regressedTop1,
    targetBrandAsymmetryFailures: WATCH_TARGET_IDS.map((id) =>
      queryComparison(
        baselineById.get(id)!,
        candidate.find((query) => query.id === id)!,
      ),
    ),
    watch057And069: WATCH_OTHER_IDS.map((id) =>
      queryComparison(
        baselineById.get(id)!,
        candidate.find((query) => query.id === id)!,
      ),
    ),
    currentlyCorrectBrandContainingRankChanges: currentlyCorrectBrandContaining,
    scoreScaleShift: {
      topScore: scoreShift(
        baseline.perQuery.map((query) => query.topScore),
        candidate.map((query) => query.topScore),
      ),
      answerableTopScore: scoreShift(
        baseline.perQuery
          .filter(
            (query) =>
              candidate.find((item) => item.id === query.id)?.answerability === "answerable",
          )
          .map((query) => query.topScore),
        candidate
          .filter((query) => query.answerability === "answerable")
          .map((query) => query.topScore),
      ),
      unanswerableTopScore: scoreShift(
        baseline.perQuery
          .filter(
            (query) =>
              candidate.find((item) => item.id === query.id)?.answerability === "unanswerable",
          )
          .map((query) => query.topScore),
        candidate
          .filter((query) => query.answerability === "unanswerable")
          .map((query) => query.topScore),
      ),
    },
  };
}

function queryComparison(baseline: BaselineQueryResult, candidate: ExperimentQueryResult) {
  return {
    id: candidate.id,
    queryType: candidate.queryType,
    faqIntentId: candidate.faqIntentId,
    rankChanged: baseline.firstAcceptableRank !== candidate.firstAcceptableRank,
    top1Changed: baseline.rankings[0]?.chunkKey !== candidate.rankings[0]?.chunkKey,
    baseline: {
      firstAcceptableRank: baseline.firstAcceptableRank,
      top1ChunkKey: baseline.rankings[0]?.chunkKey ?? null,
      top1Score: baseline.topScore,
      expectedScore:
        baseline.firstAcceptableRank === null
          ? null
          : (baseline.rankings.find((ranking) => ranking.rank === baseline.firstAcceptableRank)
              ?.score ?? null),
    },
    candidate: {
      firstAcceptableRank: candidate.firstAcceptableRank,
      top1ChunkKey: candidate.rankings[0]?.chunkKey ?? null,
      top1Score: candidate.topScore,
      expectedScore: candidate.expectedScore,
    },
  };
}

function metricDeltas(baseline: Metrics, candidate: Metrics) {
  return {
    answerable: {
      recallAt1: round(candidate.answerable.recallAt1 - baseline.answerable.recallAt1),
      recallAt3: round(candidate.answerable.recallAt3 - baseline.answerable.recallAt3),
      mrr: round(candidate.answerable.mrr - baseline.answerable.mrr),
    },
  };
}

function decide(
  baseline: Metrics,
  candidate: Metrics,
  comparisons: ReturnType<typeof compareWithBaseline>,
): "experiment_passed" | "experiment_rejected" {
  const targetTop1Corrected = comparisons.targetBrandAsymmetryFailures.filter(
    (change) =>
      change.baseline.firstAcceptableRank !== 1 && change.candidate.firstAcceptableRank === 1,
  ).length;
  const regressions = comparisons.previouslyCorrectTop1Regressions.length;
  return candidate.answerable.recallAt1 > 0.847222 &&
    candidate.answerable.recallAt1 > baseline.answerable.recallAt1 &&
    candidate.answerable.recallAt3 >= 0.902778 &&
    candidate.answerable.recallAt3 >= baseline.answerable.recallAt3 &&
    candidate.answerable.mrr > 0.895139 &&
    candidate.answerable.mrr > baseline.answerable.mrr &&
    targetTop1Corrected >= 4 &&
    regressions <= 1
    ? "experiment_passed"
    : "experiment_rejected";
}

function groupMetrics(
  results: ExperimentQueryResult[],
  keyFor: (result: ExperimentQueryResult) => string,
) {
  const groups = new Map<string, ExperimentQueryResult[]>();
  for (const result of results) {
    const key = keyFor(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => {
        const answerable = group.filter((result) => result.answerability === "answerable");
        return [
          key,
          {
            count: group.length,
            answerableCount: answerable.length,
            recallAt1:
              answerable.length === 0
                ? null
                : ratio(
                    answerable.filter((result) => result.recallAt1 === true).length,
                    answerable.length,
                  ),
            recallAt3:
              answerable.length === 0
                ? null
                : ratio(
                    answerable.filter((result) => result.recallAt3 === true).length,
                    answerable.length,
                  ),
            mrr:
              answerable.length === 0
                ? null
                : ratio(
                    answerable.reduce((sum, result) => sum + result.reciprocalRank, 0),
                    answerable.length,
                  ),
            topScoreDistribution: scoreDistribution(group),
          },
        ];
      }),
  );
}

function scoreDistribution(results: ExperimentQueryResult[]): ScoreDistribution {
  const scores = results.map((result) => result.topScore).filter((score) => score !== null);
  const margins = results.map((result) => result.topScoreMargin).filter((score) => score !== null);
  return {
    count: results.length,
    minTopScore: min(scores),
    p50TopScore: percentile(scores, 0.5),
    p90TopScore: percentile(scores, 0.9),
    maxTopScore: max(scores),
    meanTopScore: mean(scores),
    minTopScoreMargin: min(margins),
    p50TopScoreMargin: percentile(margins, 0.5),
    meanTopScoreMargin: mean(margins),
  };
}

function scoreShift(baseline: (number | null)[], candidate: (number | null)[]) {
  const paired = baseline.flatMap((baselineScore, index) => {
    const candidateScore = candidate[index];
    return baselineScore === null || candidateScore === undefined || candidateScore === null
      ? []
      : [candidateScore - baselineScore];
  });
  return {
    count: paired.length,
    minDelta: min(paired),
    p50Delta: percentile(paired, 0.5),
    p90Delta: percentile(paired, 0.9),
    maxDelta: max(paired),
    meanDelta: mean(paired),
  };
}

function dotProduct(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("Cannot compare embeddings with different dimensions.");
  }
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function roundQueryResult(result: ExperimentQueryResult): ExperimentQueryResult {
  return {
    ...result,
    reciprocalRank: round(result.reciprocalRank),
    topScore: nullableRound(result.topScore),
    topScoreMargin: nullableRound(result.topScoreMargin),
    expectedScore: nullableRound(result.expectedScore),
    rankings: result.rankings.map((ranking) => ({ ...ranking, score: round(ranking.score) })),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}

function min(values: number[]): number | null {
  return values.length === 0 ? null : round(Math.min(...values));
}

function max(values: number[]): number | null {
  return values.length === 0 ? null : round(Math.max(...values));
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : ratio(
        values.reduce((sum, value) => sum + value, 0),
        values.length,
      );
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round(sorted[index]!);
}

function cliValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function readJsonFile<T>(
  filePath: string,
): Promise<{ value: T; raw: string; sha256: string }> {
  const raw = await fs.readFile(filePath, "utf8");
  return { value: JSON.parse(raw) as T, raw, sha256: sha256Hex(raw) };
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertFileSha256(
  filePath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const actual = sha256Hex(await fs.readFile(filePath));
  if (actual !== expectedSha256) {
    throw new Error(`${label} changed during the experiment.`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  const content = await formatWithPrettier(JSON.stringify(value), {
    ...config,
    filepath: filePath,
  });
  await fs.writeFile(filePath, content);
}

function gitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

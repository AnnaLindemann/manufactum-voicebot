import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";

type Category = "exact" | "paraphrase" | "hard_negative" | "irrelevant";

type EvaluationQuery = {
  id: string;
  category: Category;
  query: string;
  expectedResult: string | null;
};

type QueryResult = EvaluationQuery & {
  answerable: boolean;
  top1ChunkKey: string | null;
  top1Score: number | null;
  top2ChunkKey: string | null;
  top2Score: number | null;
  top3ChunkKey: string | null;
  top3Score: number | null;
  expectedRank: 1 | 2 | 3 | null;
  top1Correct: boolean;
  top3Correct: boolean;
  reciprocalRank: number;
  marginTop1MinusTop2: number | null;
};

type ExperimentQueryResult = QueryResult & {
  recipeId: QueryInputRecipeId;
  recipeDescription: string;
  queryEmbeddingInput: string;
};

type QueryInputRecipeId = "baseline" | "experimental-manufactum-token-normalized";

type QueryInputRecipe = {
  id: QueryInputRecipeId;
  description: string;
  prepareQueryForEmbedding: (query: string) => string;
};

type CliOptions =
  | { mode: "baseline"; outputPath: string | undefined }
  | { mode: "brand-token-normalization-experiment"; outputPath: string };

const DATASET_PATH = "tests/fixtures/rag/retrieval-evaluation-dataset.json";
const DEFAULT_OUTPUT_PATH = "docs/evaluation/rag-retrieval-evaluation-results.json";
const BRAND_TOKEN_EXPERIMENT_OUTPUT_PATH =
  "docs/evaluation/rag-brand-token-normalization-experiment-results.json";
const MAX_CHUNKS = 3;
const PROVISIONAL_THRESHOLD = 0.8;
const COMPARISON_THRESHOLDS = [0.8, 0.85] as const;
const PRIMARY_CANARY_QUERY_IDS = ["para-003-a", "para-006-a", "para-012-b"] as const;
const CATEGORIES: Category[] = ["exact", "paraphrase", "hard_negative", "irrelevant"];
const EXPECTED_DATASET_COUNTS: Record<Category, number> = {
  exact: 12,
  paraphrase: 24,
  hard_negative: 8,
  irrelevant: 8,
};
const QUERY_INPUT_RECIPES: QueryInputRecipe[] = [
  {
    id: "baseline",
    description: "Production query embedding input: apply the existing E5 `query: ` prefix.",
    prepareQueryForEmbedding: (query) => query,
  },
  {
    id: "experimental-manufactum-token-normalized",
    description:
      "Evaluation-only candidate: remove only standalone case-insensitive `Manufactum`, normalize whitespace, then apply the existing E5 `query: ` prefix.",
    prepareQueryForEmbedding: normalizeStandaloneManufactumToken,
  },
];

async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for retrieval evaluation.");
  }

  const datasetFile = await readFrozenDataset();
  const dataset = parseDataset(datasetFile.raw);
  validateDataset(dataset);
  const frozenDataset = deepFreeze(dataset);
  const datasetBeforeScoring = JSON.stringify(frozenDataset);

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
  };
  const cacheDir = nonEmpty(process.env.TRANSFORMERS_CACHE);
  if (cacheDir !== undefined) {
    generatorOptions.cacheDir = cacheDir;
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const store = new PostgresRagDocumentStore(pool);
    const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);
    const model = embeddingProfileModelRef();

    const baselineRecipe = QUERY_INPUT_RECIPES[0];
    const candidateRecipe = QUERY_INPUT_RECIPES[1];
    if (baselineRecipe === undefined || candidateRecipe === undefined) {
      throw new Error("Expected baseline and candidate query recipes to be configured.");
    }
    const baselineResults = await evaluateRecipe(
      frozenDataset,
      baselineRecipe,
      generator,
      store,
      model,
    );

    const datasetAfterScoring = JSON.stringify(frozenDataset);
    if (datasetAfterScoring !== datasetBeforeScoring) {
      throw new Error("Evaluation dataset was modified during scoring.");
    }
    const datasetAfterRaw = await fs.readFile(DATASET_PATH, "utf8");
    if (sha256Hex(datasetAfterRaw) !== datasetFile.sha256) {
      throw new Error("Evaluation dataset file changed during scoring.");
    }

    const answerability080 = answerabilityAtThreshold(baselineResults, PROVISIONAL_THRESHOLD);
    const endToEnd080 = endToEndAtThreshold(baselineResults, PROVISIONAL_THRESHOLD);
    verifyThreshold080(answerability080, endToEnd080);

    const report =
      cliOptions.mode === "baseline"
        ? baselineReport(frozenDataset, datasetFile.sha256, baselineResults.map(stripRecipeResult))
        : experimentReport(
            frozenDataset,
            datasetFile.sha256,
            baselineResults,
            await evaluateRecipe(frozenDataset, candidateRecipe, generator, store, model),
          );

    if (cliOptions.outputPath !== undefined) {
      await fs.mkdir(path.dirname(cliOptions.outputPath), { recursive: true });
      await fs.writeFile(cliOptions.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

function baselineReport(
  dataset: readonly EvaluationQuery[],
  datasetSha256: string,
  results: readonly QueryResult[],
) {
  const rankingSweep = sweepThresholds(results, rankingAtThreshold);
  const answerabilitySweep = sweepThresholds(results, answerabilityAtThreshold);
  const endToEndSweep = sweepThresholds(results, endToEndAtThreshold);
  const answerability080 = answerabilityAtThreshold(results, PROVISIONAL_THRESHOLD);
  const endToEnd080 = endToEndAtThreshold(results, PROVISIONAL_THRESHOLD);
  return {
    dataset: {
      path: DATASET_PATH,
      sha256: datasetSha256,
      composition: summarizeDataset(dataset),
      immutableDuringEvaluation: true,
      loadedAndValidatedBeforeModelScoring: true,
    },
    embeddingProfile: {
      id: RAG_EMBEDDING_PROFILE.id,
      modelId: RAG_EMBEDDING_PROFILE.modelId,
      modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
      artifact: RAG_EMBEDDING_PROFILE.artifact,
      dimension: RAG_EMBEDDING_PROFILE.dimension,
      queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
    },
    maxChunks: MAX_CHUNKS,
    provisionalThreshold: PROVISIONAL_THRESHOLD,
    perQuery: results.map(roundQueryResult),
    ranking: {
      answerableCount: results.filter((result) => result.answerable).length,
      quality: rankingQuality(results),
      perCategory: {
        exact: rankingQuality(results.filter((result) => result.category === "exact")),
        paraphrase: rankingQuality(results.filter((result) => result.category === "paraphrase")),
      },
      threshold080: rankingAtThreshold(results, PROVISIONAL_THRESHOLD),
      thresholdSweep: rankingSweep,
    },
    answerability: {
      answerableCount: results.filter((result) => result.answerable).length,
      unanswerableCount: results.filter((result) => !result.answerable).length,
      threshold080: answerability080,
      thresholdSweep: answerabilitySweep,
      bestF1ForAnswerability: bestBy(answerabilitySweep, "f1"),
    },
    endToEnd: {
      threshold080: endToEnd080,
      thresholdSweep: endToEndSweep,
    },
    representative: representative(results, PROVISIONAL_THRESHOLD, compactQueryResult),
  };
}

function stripRecipeResult(result: ExperimentQueryResult): QueryResult {
  return {
    id: result.id,
    category: result.category,
    query: result.query,
    expectedResult: result.expectedResult,
    answerable: result.answerable,
    top1ChunkKey: result.top1ChunkKey,
    top1Score: result.top1Score,
    top2ChunkKey: result.top2ChunkKey,
    top2Score: result.top2Score,
    top3ChunkKey: result.top3ChunkKey,
    top3Score: result.top3Score,
    expectedRank: result.expectedRank,
    top1Correct: result.top1Correct,
    top3Correct: result.top3Correct,
    reciprocalRank: result.reciprocalRank,
    marginTop1MinusTop2: result.marginTop1MinusTop2,
  };
}

function experimentReport(
  dataset: readonly EvaluationQuery[],
  datasetSha256: string,
  baselineResults: readonly ExperimentQueryResult[],
  candidateResults: readonly ExperimentQueryResult[],
) {
  return {
    dataset: {
      path: DATASET_PATH,
      sha256: datasetSha256,
      composition: summarizeDataset(dataset),
      immutableDuringEvaluation: true,
      loadedAndValidatedBeforeModelScoring: true,
    },
    embeddingProfile: {
      id: RAG_EMBEDDING_PROFILE.id,
      modelId: RAG_EMBEDDING_PROFILE.modelId,
      modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
      artifact: RAG_EMBEDDING_PROFILE.artifact,
      dimension: RAG_EMBEDDING_PROFILE.dimension,
      queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
    },
    queryInputRecipes: QUERY_INPUT_RECIPES.map((recipe) => ({
      id: recipe.id,
      description: recipe.description,
      e5PrefixAppliedByGenerator: RAG_EMBEDDING_PROFILE.queryPrefix,
    })),
    maxChunks: MAX_CHUNKS,
    provisionalThreshold: PROVISIONAL_THRESHOLD,
    brandTokenFinding: brandTokenFinding(dataset, baselineResults),
    variants: {
      baseline: summarizeVariant(baselineResults),
      "experimental-manufactum-token-normalized": summarizeVariant(candidateResults),
    },
    comparison: compareVariants(baselineResults, candidateResults, COMPARISON_THRESHOLDS),
    primaryCanaries: PRIMARY_CANARY_QUERY_IDS.map((id) =>
      compareQueryById(baselineResults, candidateResults, id),
    ),
    currentlyCorrectRegressions: currentlyCorrectRegressions(baselineResults, candidateResults),
    decisionRule: decisionRule(baselineResults, candidateResults, COMPARISON_THRESHOLDS),
  };
}

async function readFrozenDataset(): Promise<{ raw: string; sha256: string }> {
  const raw = await fs.readFile(DATASET_PATH, "utf8");
  return { raw, sha256: sha256Hex(raw) };
}

function parseDataset(raw: string): EvaluationQuery[] {
  return JSON.parse(raw) as EvaluationQuery[];
}

function validateDataset(dataset: EvaluationQuery[]): void {
  if (dataset.length !== 52) {
    throw new Error(`Expected 52 evaluation queries, found ${String(dataset.length)}.`);
  }
  const counts = summarizeDataset(dataset);
  for (const category of CATEGORIES) {
    if (counts[category] !== EXPECTED_DATASET_COUNTS[category]) {
      throw new Error(
        `Expected ${String(EXPECTED_DATASET_COUNTS[category])} ${category} queries, found ${String(counts[category])}.`,
      );
    }
  }
  const ids = new Set<string>();
  for (const item of dataset) {
    if (ids.has(item.id)) {
      throw new Error(`Duplicate evaluation query id ${item.id}.`);
    }
    ids.add(item.id);
    if (isAnswerable(item) && item.expectedResult === null) {
      throw new Error(`Positive query ${item.id} must have an expected chunk key.`);
    }
    if (!isAnswerable(item) && item.expectedResult !== null) {
      throw new Error(`Negative query ${item.id} must use expectedResult=null.`);
    }
  }
}

function summarizeDataset(dataset: readonly EvaluationQuery[]): Record<Category, number> {
  return Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      dataset.filter((item) => item.category === category).length,
    ]),
  ) as Record<Category, number>;
}

async function evaluateRecipe(
  dataset: readonly EvaluationQuery[],
  recipe: QueryInputRecipe,
  generator: TransformersE5SmallPassageEmbeddingGenerator,
  store: PostgresRagDocumentStore,
  model: ReturnType<typeof embeddingProfileModelRef>,
): Promise<ExperimentQueryResult[]> {
  const results: ExperimentQueryResult[] = [];
  for (const item of dataset) {
    const queryEmbeddingInput = recipe.prepareQueryForEmbedding(item.query);
    const queryEmbedding = await generator.embedQuery(queryEmbeddingInput);
    const top = await store.searchRelevantChunks({
      queryEmbedding: queryEmbedding.embedding,
      model,
      maxChunks: MAX_CHUNKS,
    });
    const top1 = top[0];
    const top2 = top[1];
    const top3 = top[2];
    const topKeys = top.map((chunk) => chunk.chunkKey);
    const expectedRank =
      item.expectedResult === null ? null : expectedRankInTopK(topKeys, item.expectedResult);

    results.push({
      ...item,
      answerable: isAnswerable(item),
      recipeId: recipe.id,
      recipeDescription: recipe.description,
      queryEmbeddingInput,
      top1ChunkKey: top1?.chunkKey ?? null,
      top1Score: top1?.score ?? null,
      top2ChunkKey: top2?.chunkKey ?? null,
      top2Score: top2?.score ?? null,
      top3ChunkKey: top3?.chunkKey ?? null,
      top3Score: top3?.score ?? null,
      expectedRank,
      top1Correct: expectedRank === 1,
      top3Correct: expectedRank !== null,
      reciprocalRank: expectedRank === null ? 0 : 1 / expectedRank,
      marginTop1MinusTop2:
        top1 !== undefined && top2 !== undefined ? top1.score - top2.score : null,
    });
  }
  return results;
}

function normalizeStandaloneManufactumToken(query: string): string {
  return query
    .replace(/(^|(?<=[^\p{L}\p{N}_]))Manufactum(?=$|[^\p{L}\p{N}_])/giu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function brandTokenFinding(
  dataset: readonly EvaluationQuery[],
  baselineResults: readonly QueryResult[],
) {
  const brandAnswerable = dataset.filter(
    (item) => isAnswerable(item) && containsStandaloneManufactumToken(item.query),
  );
  const queries = brandAnswerable.map((item) => {
    const result = requiredResultById(baselineResults, item.id);
    return {
      id: item.id,
      category: item.category,
      query: item.query,
      expectedResult: item.expectedResult,
      top1ChunkKey: result.top1ChunkKey,
      top1Score: roundNullable(result.top1Score),
      top1Correct: result.top1Correct,
    };
  });
  const succeeded = queries.filter((query) => query.top1Correct);
  const failed = queries.filter((query) => !query.top1Correct);
  return {
    standaloneToken: "Manufactum",
    answerableCount: queries.length,
    currentlySucceed: succeeded.length,
    currentlyFail: failed.length,
    resolution:
      "The correct baseline count is 11 answerable brand-token queries: 7 are currently Top-1 correct and 4 fail. The phrase `11 currently-correct brand queries` was incorrect.",
    queries,
  };
}

function containsStandaloneManufactumToken(query: string): boolean {
  return /(^|[^\p{L}\p{N}_])Manufactum(?=$|[^\p{L}\p{N}_])/iu.test(query);
}

function summarizeVariant(results: readonly ExperimentQueryResult[]) {
  const rankingSweep = sweepThresholds(results, rankingAtThreshold);
  const answerabilitySweep = sweepThresholds(results, answerabilityAtThreshold);
  const endToEndSweep = sweepThresholds(results, endToEndAtThreshold);
  return {
    perQuery: results.map(roundExperimentQueryResult),
    ranking: {
      answerableCount: results.filter((result) => result.answerable).length,
      quality: rankingQuality(results),
      perCategory: {
        exact: rankingQuality(results.filter((result) => result.category === "exact")),
        paraphrase: rankingQuality(results.filter((result) => result.category === "paraphrase")),
      },
      threshold080: rankingAtThreshold(results, 0.8),
      threshold085: rankingAtThreshold(results, 0.85),
      thresholdSweep: rankingSweep,
    },
    answerability: {
      answerableCount: results.filter((result) => result.answerable).length,
      unanswerableCount: results.filter((result) => !result.answerable).length,
      threshold080: answerabilityAtThreshold(results, 0.8),
      threshold085: answerabilityAtThreshold(results, 0.85),
      thresholdSweep: answerabilitySweep,
      bestF1ForAnswerability: bestBy(answerabilitySweep, "f1"),
    },
    endToEnd: {
      threshold080: endToEndAtThreshold(results, 0.8),
      threshold085: endToEndAtThreshold(results, 0.85),
      thresholdSweep: endToEndSweep,
    },
    representative: representative(results, PROVISIONAL_THRESHOLD, compactExperimentQueryResult),
  };
}

function compareVariants(
  baseline: readonly ExperimentQueryResult[],
  candidate: readonly ExperimentQueryResult[],
  thresholds: readonly number[],
) {
  return {
    changedQueries: candidate
      .filter((candidateResult) => {
        const baselineResult = requiredResultById(baseline, candidateResult.id);
        return (
          rankingChanged(baselineResult, candidateResult) ||
          thresholds.some(
            (threshold) =>
              decisionOutcome(baselineResult, threshold) !==
              decisionOutcome(candidateResult, threshold),
          )
        );
      })
      .map((candidateResult) => {
        const baselineResult = requiredResultById(baseline, candidateResult.id);
        return compareQuery(baselineResult, candidateResult, thresholds);
      }),
    thresholdDeltas: thresholds.map((threshold) => ({
      threshold: round(threshold),
      ranking: delta(
        rankingAtThreshold(baseline, threshold),
        rankingAtThreshold(candidate, threshold),
      ),
      answerability: delta(
        answerabilityAtThreshold(baseline, threshold),
        answerabilityAtThreshold(candidate, threshold),
      ),
      endToEnd: delta(
        endToEndAtThreshold(baseline, threshold),
        endToEndAtThreshold(candidate, threshold),
      ),
    })),
  };
}

function compareQueryById(
  baseline: readonly ExperimentQueryResult[],
  candidate: readonly ExperimentQueryResult[],
  id: string,
) {
  return compareQuery(requiredResultById(baseline, id), requiredResultById(candidate, id), [
    ...COMPARISON_THRESHOLDS,
  ]);
}

function compareQuery(
  baseline: ExperimentQueryResult,
  candidate: ExperimentQueryResult,
  thresholds: readonly number[],
) {
  return {
    id: baseline.id,
    category: baseline.category,
    query: baseline.query,
    candidateQueryEmbeddingInput: candidate.queryEmbeddingInput,
    expectedResult: baseline.expectedResult,
    baseline: compactExperimentQueryResult(baseline),
    candidate: compactExperimentQueryResult(candidate),
    rankingChanged: rankingChanged(baseline, candidate),
    decisions: thresholds.map((threshold) => ({
      threshold: round(threshold),
      baseline: decisionOutcome(baseline, threshold),
      candidate: decisionOutcome(candidate, threshold),
      changed: decisionOutcome(baseline, threshold) !== decisionOutcome(candidate, threshold),
    })),
  };
}

function rankingChanged(baseline: QueryResult, candidate: QueryResult): boolean {
  return (
    baseline.top1ChunkKey !== candidate.top1ChunkKey ||
    baseline.top2ChunkKey !== candidate.top2ChunkKey ||
    baseline.top3ChunkKey !== candidate.top3ChunkKey ||
    baseline.expectedRank !== candidate.expectedRank
  );
}

function decisionOutcome(result: QueryResult, threshold: number): string {
  if (result.answerable && accepted(result, threshold) && result.top1Correct) {
    return "correct_accepted";
  }
  if (result.answerable && accepted(result, threshold) && !result.top1Correct) {
    return "wrong_chunk_accepted";
  }
  if (result.answerable && !accepted(result, threshold)) {
    return "answerable_abstained";
  }
  if (!result.answerable && accepted(result, threshold)) {
    return `${result.category}_false_accept`;
  }
  return "correct_reject";
}

function currentlyCorrectRegressions(
  baseline: readonly ExperimentQueryResult[],
  candidate: readonly ExperimentQueryResult[],
) {
  return baseline
    .filter((baselineResult) => baselineResult.answerable && baselineResult.top1Correct)
    .map((baselineResult) => ({
      baseline: baselineResult,
      candidate: requiredResultById(candidate, baselineResult.id),
    }))
    .filter(({ candidate: candidateResult }) => !candidateResult.top1Correct)
    .map(({ baseline: baselineResult, candidate: candidateResult }) =>
      compareQuery(baselineResult, candidateResult, [...COMPARISON_THRESHOLDS]),
    );
}

function decisionRule(
  baseline: readonly ExperimentQueryResult[],
  candidate: readonly ExperimentQueryResult[],
  thresholds: readonly number[],
) {
  const canaryFailures = PRIMARY_CANARY_QUERY_IDS.filter(
    (id) => !requiredResultById(candidate, id).top1Correct,
  );
  const regressions = currentlyCorrectRegressions(baseline, candidate);
  const baselineQuality = rankingQuality(baseline);
  const candidateQuality = rankingQuality(candidate);
  const falseAcceptIncreases = thresholds.filter((threshold) => {
    const baselineAnswerability = answerabilityAtThreshold(baseline, threshold);
    const candidateAnswerability = answerabilityAtThreshold(candidate, threshold);
    return (
      candidateAnswerability.hardNegativeFalsePositive >
        baselineAnswerability.hardNegativeFalsePositive ||
      candidateAnswerability.irrelevantFalsePositive > baselineAnswerability.irrelevantFalsePositive
    );
  });
  const passes =
    canaryFailures.length === 0 &&
    regressions.length === 0 &&
    candidateQuality.recallAt3 >= baselineQuality.recallAt3 &&
    falseAcceptIncreases.length === 0;
  return {
    mayProceedToLaterProductionDesignCheckpoint: passes,
    productionBehaviorChanged: false,
    productionThresholdChanged: false,
    canaryFailures,
    currentlyCorrectAnswerableRegressions: regressions.map((regression) => regression.id),
    baselineRecallAt3: baselineQuality.recallAt3,
    candidateRecallAt3: candidateQuality.recallAt3,
    falseAcceptIncreaseThresholds: falseAcceptIncreases.map(round),
  };
}

function delta<T extends Record<string, unknown>>(baseline: T, candidate: T): T {
  const rows = Object.entries(candidate).map(([key, candidateValue]) => {
    const baselineValue = baseline[key];
    if (typeof candidateValue === "number" && typeof baselineValue === "number") {
      return [key, round(candidateValue - baselineValue)];
    }
    return [key, candidateValue];
  });
  return Object.fromEntries(rows) as T;
}

function rankingQuality(results: readonly QueryResult[]) {
  const answerable = results.filter((result) => result.answerable);
  const margins = answerable.flatMap((result) =>
    result.marginTop1MinusTop2 === null ? [] : [result.marginTop1MinusTop2],
  );
  return {
    count: answerable.length,
    top1Accuracy: ratio(
      answerable.filter((result) => result.top1Correct).length,
      answerable.length,
    ),
    recallAt3: ratio(answerable.filter((result) => result.top3Correct).length, answerable.length),
    mrr: ratio(
      answerable.reduce((sum, result) => sum + result.reciprocalRank, 0),
      answerable.length,
    ),
    expectedChunkRankDistribution: {
      rank1: answerable.filter((result) => result.expectedRank === 1).length,
      rank2: answerable.filter((result) => result.expectedRank === 2).length,
      rank3: answerable.filter((result) => result.expectedRank === 3).length,
      absentFromTop3: answerable.filter((result) => result.expectedRank === null).length,
    },
    top1Top2MarginDistribution: distribution(margins),
    failuresExpectedChunkAbsentFromTop3: answerable
      .filter((result) => result.expectedRank === null)
      .map((result) => ({
        id: result.id,
        query: result.query,
        expectedResult: result.expectedResult,
        top1ChunkKey: result.top1ChunkKey,
        top1Score: roundNullable(result.top1Score),
        top2ChunkKey: result.top2ChunkKey,
        top2Score: roundNullable(result.top2Score),
        top3ChunkKey: result.top3ChunkKey,
        top3Score: roundNullable(result.top3Score),
        marginTop1MinusTop2: roundNullable(result.marginTop1MinusTop2),
      })),
  };
}

function rankingAtThreshold(results: readonly QueryResult[], threshold: number) {
  const answerable = results.filter((result) => result.answerable);
  const correctAccepted = answerable.filter(
    (result) => accepted(result, threshold) && result.top1Correct,
  ).length;
  const wrongAccepted = answerable.filter(
    (result) => accepted(result, threshold) && !result.top1Correct,
  ).length;
  const abstained = answerable.filter((result) => !accepted(result, threshold)).length;
  return {
    threshold: round(threshold),
    correctAccepted,
    wrongAccepted,
    abstained,
    total: correctAccepted + wrongAccepted + abstained,
  };
}

function answerabilityAtThreshold(results: readonly QueryResult[], threshold: number) {
  const truePositive = results.filter(
    (result) => result.answerable && accepted(result, threshold),
  ).length;
  const falseNegative = results.filter(
    (result) => result.answerable && !accepted(result, threshold),
  ).length;
  const falsePositive = results.filter(
    (result) => !result.answerable && accepted(result, threshold),
  ).length;
  const trueNegative = results.filter(
    (result) => !result.answerable && !accepted(result, threshold),
  ).length;
  const hardNegativeFalsePositive = results.filter(
    (result) => result.category === "hard_negative" && accepted(result, threshold),
  ).length;
  const irrelevantFalsePositive = results.filter(
    (result) => result.category === "irrelevant" && accepted(result, threshold),
  ).length;
  const total = truePositive + falseNegative + falsePositive + trueNegative;
  if (total !== results.length) {
    throw new Error(
      `Binary answerability counts do not sum to ${String(results.length)} at threshold ${String(threshold)}.`,
    );
  }
  return {
    threshold: round(threshold),
    truePositive,
    falseNegative,
    falsePositive,
    trueNegative,
    hardNegativeFalsePositive,
    irrelevantFalsePositive,
    total,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    f1: f1(truePositive, falsePositive, falseNegative),
    specificity: ratio(trueNegative, trueNegative + falsePositive),
    falsePositiveRate: ratio(falsePositive, falsePositive + trueNegative),
    accuracy: ratio(truePositive + trueNegative, total),
  };
}

function endToEndAtThreshold(results: readonly QueryResult[], threshold: number) {
  const correctAnswer = results.filter(
    (result) => result.answerable && accepted(result, threshold) && result.top1Correct,
  ).length;
  const wrongChunkAcceptedForAnswerable = results.filter(
    (result) => result.answerable && accepted(result, threshold) && !result.top1Correct,
  ).length;
  const answerableRejected = results.filter(
    (result) => result.answerable && !accepted(result, threshold),
  ).length;
  const unanswerableIncorrectlyAccepted = results.filter(
    (result) => !result.answerable && accepted(result, threshold),
  ).length;
  const unanswerableCorrectlyRejected = results.filter(
    (result) => !result.answerable && !accepted(result, threshold),
  ).length;
  const total =
    correctAnswer +
    wrongChunkAcceptedForAnswerable +
    answerableRejected +
    unanswerableIncorrectlyAccepted +
    unanswerableCorrectlyRejected;
  if (total !== results.length) {
    throw new Error(
      `End-to-end counts do not sum to ${String(results.length)} at threshold ${String(threshold)}.`,
    );
  }
  return {
    threshold: round(threshold),
    correctAnswer,
    wrongChunkAcceptedForAnswerable,
    answerableRejected,
    unanswerableIncorrectlyAccepted,
    unanswerableCorrectlyRejected,
    total,
    exactCorrectAnswer: results.filter(
      (result) => result.category === "exact" && accepted(result, threshold) && result.top1Correct,
    ).length,
    paraphraseCorrectAnswer: results.filter(
      (result) =>
        result.category === "paraphrase" && accepted(result, threshold) && result.top1Correct,
    ).length,
  };
}

function sweepThresholds<T>(
  results: readonly QueryResult[],
  summarize: (results: readonly QueryResult[], threshold: number) => T,
): T[] {
  const rows = [];
  for (let step = 50; step <= 95; step += 1) {
    rows.push(summarize(results, step / 100));
  }
  return rows;
}

function representative<T extends QueryResult>(
  results: readonly T[],
  threshold: number,
  compact: (result: T) => Record<string, unknown>,
) {
  return {
    rankingFailuresAbsentFromTop3: rankingQuality(results).failuresExpectedChunkAbsentFromTop3,
    wrongAcceptedAnswerable: results
      .filter((result) => result.answerable && accepted(result, threshold) && !result.top1Correct)
      .map(compact),
    unanswerableFalseAccepts: results
      .filter((result) => !result.answerable && accepted(result, threshold))
      .map(compact),
    unanswerableCorrectRejects: results
      .filter((result) => !result.answerable && !accepted(result, threshold))
      .map(compact),
  };
}

function compactQueryResult(result: QueryResult) {
  return {
    id: result.id,
    category: result.category,
    query: result.query,
    expectedResult: result.expectedResult,
    top1ChunkKey: result.top1ChunkKey,
    top1Score: roundNullable(result.top1Score),
    top2Score: roundNullable(result.top2Score),
    top3Score: roundNullable(result.top3Score),
    expectedRank: result.expectedRank,
    marginTop1MinusTop2: roundNullable(result.marginTop1MinusTop2),
  };
}

function compactExperimentQueryResult(result: ExperimentQueryResult) {
  return {
    ...compactQueryResult(result),
    top2ChunkKey: result.top2ChunkKey,
    top3ChunkKey: result.top3ChunkKey,
    queryEmbeddingInput: result.queryEmbeddingInput,
  };
}

function verifyThreshold080(
  answerability080: ReturnType<typeof answerabilityAtThreshold>,
  endToEnd080: ReturnType<typeof endToEndAtThreshold>,
): void {
  const expectedAnswerability = {
    truePositive: 36,
    falseNegative: 0,
    falsePositive: 9,
    trueNegative: 7,
    precision: 0.8,
    recall: 1,
    f1: 0.888889,
  };
  const expectedEndToEnd = {
    correctAnswer: 31,
    wrongChunkAcceptedForAnswerable: 5,
    answerableRejected: 0,
    unanswerableIncorrectlyAccepted: 9,
    unanswerableCorrectlyRejected: 7,
  };
  for (const [key, expected] of Object.entries(expectedAnswerability)) {
    const actual = answerability080[key as keyof typeof expectedAnswerability];
    if (actual !== expected) {
      throw new Error(
        `Threshold 0.80 answerability discrepancy for ${key}: expected ${String(expected)}, got ${String(actual)}.`,
      );
    }
  }
  for (const [key, expected] of Object.entries(expectedEndToEnd)) {
    const actual = endToEnd080[key as keyof typeof expectedEndToEnd];
    if (actual !== expected) {
      throw new Error(
        `Threshold 0.80 end-to-end discrepancy for ${key}: expected ${String(expected)}, got ${String(actual)}.`,
      );
    }
  }
}

function expectedRankInTopK(topKeys: readonly string[], expectedResult: string): 1 | 2 | 3 | null {
  const index = topKeys.indexOf(expectedResult);
  if (index === 0) {
    return 1;
  }
  if (index === 1) {
    return 2;
  }
  if (index === 2) {
    return 3;
  }
  return null;
}

function isAnswerable(item: EvaluationQuery): boolean {
  return item.category === "exact" || item.category === "paraphrase";
}

function accepted(result: QueryResult, threshold: number): boolean {
  return (result.top1Score ?? -Infinity) >= threshold;
}

function distribution(values: readonly number[]) {
  if (values.length === 0) {
    return { min: null, p25: null, median: null, p75: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(sorted[0] ?? 0),
    p25: round(percentile(sorted, 0.25)),
    median: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.floor((sorted.length - 1) * p);
  return sorted[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function f1(truePositive: number, falsePositive: number, falseNegative: number): number {
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  return precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall));
}

function bestBy<T extends Record<string, unknown>>(rows: readonly T[], key: keyof T): T {
  const best = rows.reduce((currentBest, row) =>
    Number(row[key]) > Number(currentBest[key]) ? row : currentBest,
  );
  return best;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function roundNullable(value: number | null): number | null {
  return value === null ? null : round(value);
}

function roundQueryResult(result: QueryResult): QueryResult {
  return {
    id: result.id,
    category: result.category,
    query: result.query,
    expectedResult: result.expectedResult,
    answerable: result.answerable,
    top1ChunkKey: result.top1ChunkKey,
    top1Score: roundNullable(result.top1Score),
    top2ChunkKey: result.top2ChunkKey,
    top2Score: roundNullable(result.top2Score),
    top3ChunkKey: result.top3ChunkKey,
    top3Score: roundNullable(result.top3Score),
    expectedRank: result.expectedRank,
    top1Correct: result.top1Correct,
    top3Correct: result.top3Correct,
    reciprocalRank: round(result.reciprocalRank),
    marginTop1MinusTop2: roundNullable(result.marginTop1MinusTop2),
  };
}

function roundExperimentQueryResult(result: ExperimentQueryResult): ExperimentQueryResult {
  return {
    ...roundQueryResult(result),
    recipeId: result.recipeId,
    recipeDescription: result.recipeDescription,
    queryEmbeddingInput: result.queryEmbeddingInput,
  };
}

function requiredResultById<T extends QueryResult>(results: readonly T[], id: string): T {
  const result = results.find((item) => item.id === id);
  if (result === undefined) {
    throw new Error(`Missing evaluation result for query id ${id}.`);
  }
  return result;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function parseCliOptions(args: string[]): CliOptions {
  const experimentIndex = args.indexOf("--experiment");
  const outputPath = parseOutputPath(args);
  if (experimentIndex === -1) {
    return { mode: "baseline", outputPath };
  }

  const experiment = args[experimentIndex + 1]?.trim();
  if (experiment !== "brand-token-normalization") {
    throw new Error("--experiment only supports `brand-token-normalization`.");
  }
  const resolvedOutputPath = outputPath ?? DEFAULT_OUTPUT_PATH;
  if (resolvedOutputPath !== BRAND_TOKEN_EXPERIMENT_OUTPUT_PATH) {
    throw new Error(
      `Brand-token normalization experiment output must be ${BRAND_TOKEN_EXPERIMENT_OUTPUT_PATH}.`,
    );
  }
  return {
    mode: "brand-token-normalization-experiment",
    outputPath: resolvedOutputPath,
  };
}

function parseOutputPath(args: string[]): string | undefined {
  const outputIndex = args.indexOf("--output");
  if (outputIndex === -1) {
    return DEFAULT_OUTPUT_PATH;
  }
  const outputPath = args[outputIndex + 1]?.trim();
  if (outputPath === undefined || outputPath.length === 0) {
    throw new Error("--output requires a non-empty path.");
  }
  return outputPath;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

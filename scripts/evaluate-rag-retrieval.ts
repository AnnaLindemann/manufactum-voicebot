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

const DATASET_PATH = "tests/fixtures/rag/retrieval-evaluation-dataset.json";
const DEFAULT_OUTPUT_PATH = "docs/evaluation/rag-retrieval-evaluation-results.json";
const MAX_CHUNKS = 3;
const PROVISIONAL_THRESHOLD = 0.8;
const CATEGORIES: Category[] = ["exact", "paraphrase", "hard_negative", "irrelevant"];
const EXPECTED_DATASET_COUNTS: Record<Category, number> = {
  exact: 12,
  paraphrase: 24,
  hard_negative: 8,
  irrelevant: 8,
};

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
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

    const results: QueryResult[] = [];
    for (const item of frozenDataset) {
      const queryEmbedding = await generator.embedQuery(item.query);
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

    const datasetAfterScoring = JSON.stringify(frozenDataset);
    if (datasetAfterScoring !== datasetBeforeScoring) {
      throw new Error("Evaluation dataset was modified during scoring.");
    }
    const datasetAfterRaw = await fs.readFile(DATASET_PATH, "utf8");
    if (sha256Hex(datasetAfterRaw) !== datasetFile.sha256) {
      throw new Error("Evaluation dataset file changed during scoring.");
    }

    const rankingSweep = sweepThresholds(results, rankingAtThreshold);
    const answerabilitySweep = sweepThresholds(results, answerabilityAtThreshold);
    const endToEndSweep = sweepThresholds(results, endToEndAtThreshold);
    const answerability080 = answerabilityAtThreshold(results, PROVISIONAL_THRESHOLD);
    const endToEnd080 = endToEndAtThreshold(results, PROVISIONAL_THRESHOLD);
    verifyThreshold080(answerability080, endToEnd080);

    const report = {
      dataset: {
        path: DATASET_PATH,
        sha256: datasetFile.sha256,
        composition: summarizeDataset(frozenDataset),
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
      representative: representative(results, PROVISIONAL_THRESHOLD),
    };

    if (outputPath !== undefined) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
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

function representative(results: readonly QueryResult[], threshold: number) {
  return {
    rankingFailuresAbsentFromTop3: rankingQuality(results).failuresExpectedChunkAbsentFromTop3,
    wrongAcceptedAnswerable: results
      .filter((result) => result.answerable && accepted(result, threshold) && !result.top1Correct)
      .map(compactQueryResult),
    unanswerableFalseAccepts: results
      .filter((result) => !result.answerable && accepted(result, threshold))
      .map(compactQueryResult),
    unanswerableCorrectRejects: results
      .filter((result) => !result.answerable && !accepted(result, threshold))
      .map(compactQueryResult),
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
    ...result,
    top1Score: roundNullable(result.top1Score),
    top2Score: roundNullable(result.top2Score),
    top3Score: roundNullable(result.top3Score),
    marginTop1MinusTop2: roundNullable(result.marginTop1MinusTop2),
    reciprocalRank: round(result.reciprocalRank),
  };
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

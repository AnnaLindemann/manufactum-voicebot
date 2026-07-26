import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";
import type { RelevantChunkSearchResult, StoredChunk } from "../src/rag/document-store.js";

type Category = "exact" | "paraphrase" | "hard_negative" | "irrelevant";

type EvaluationQuery = {
  id: string;
  category: Category;
  query: string;
  expectedResult: string | null;
};

type BaselineQueryResult = EvaluationQuery & {
  answerable: boolean;
  top1ChunkKey: string | null;
  top1Score: number | null;
  top2ChunkKey: string | null;
  top2Score: number | null;
  top3ChunkKey: string | null;
  top3Score: number | null;
  expectedRank: 1 | 2 | 3 | null;
  top1Correct: boolean;
};

type BrandComparisonQuery = {
  id: string;
  baseline: { top1ChunkKey: string | null; top1Score: number | null; expectedRank: number | null };
  candidate: { top1ChunkKey: string | null; top1Score: number | null; expectedRank: number | null };
};

type GateQueryResult = {
  id: string;
  top1ChunkKey: string | null;
  questionMatchScore: number | null;
};

type RerankerChangedQuery = {
  id: string;
  candidate: { top1ChunkKey: string | null; top1FaqQuestionScore: number | null };
};

type RankingEntry = {
  rank: number;
  chunkKey: string;
  canonicalQuestion: string;
  score: number;
};

type ActiveChunkSummary = {
  chunkKey: string;
  canonicalQuestion: string;
  answer: string;
  content: string;
};

const DATASET_PATH = "tests/fixtures/rag/retrieval-evaluation-dataset.json";
const BASELINE_PATH = "docs/evaluation/rag-retrieval-evaluation-results.json";
const BRAND_PATH = "docs/evaluation/rag-brand-token-normalization-experiment-results.json";
const GATE_PATH = "docs/evaluation/rag-faq-question-gate-experiment-results.json";
const RERANKER_PATH = "docs/evaluation/rag-faq-question-reranker-experiment-results.json";
const OUTPUT_PATH = "docs/evaluation/rag-unrecoverable-query-diagnosis-results.json";
const TARGET_QUERY_IDS = ["para-003-a", "para-006-a", "para-012-b"] as const;

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for read-only RAG diagnosis.");
  }

  const [datasetFile, baselineFile, brandFile, gateFile, rerankerFile] = await Promise.all([
    readJsonFile<EvaluationQuery[]>(DATASET_PATH),
    readJsonFile<{ perQuery: BaselineQueryResult[] }>(BASELINE_PATH),
    readJsonFile<{
      comparison: { changedQueries: BrandComparisonQuery[] };
      primaryCanaries: BrandComparisonQuery[];
    }>(BRAND_PATH),
    readJsonFile<{ inspectedWrongAnswerableTop1: GateQueryResult[] }>(GATE_PATH),
    readJsonFile<{
      changedAnswerableRankings: RerankerChangedQuery[];
      wrongToDifferentWrongChanges: string[];
      unrecoverableWrongTop1QueryIds: string[];
    }>(RERANKER_PATH),
  ]);

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
    const activeChunks = await store.getActiveChunks("mein-konto");
    const activeChunkSummaries = activeChunks.map(activeChunkSummary);
    const activeChunkByKey = new Map(activeChunkSummaries.map((chunk) => [chunk.chunkKey, chunk]));

    const comparisonQueryIds = sameExpectedChunkComparisonIds(datasetFile.json, TARGET_QUERY_IDS);
    const fullRankings = new Map<string, RankingEntry[]>();
    for (const id of comparisonQueryIds) {
      const item = requiredById(datasetFile.json, id);
      const queryEmbedding = await generator.embedQuery(item.query);
      const ranking = await store.searchRelevantChunks({
        queryEmbedding: queryEmbedding.embedding,
        model,
        maxChunks: activeChunks.length,
      });
      fullRankings.set(
        id,
        ranking.map((entry, index) => rankingEntry(entry, index)),
      );
    }

    const targetDiagnostics = TARGET_QUERY_IDS.map((id) =>
      targetDiagnosis({
        id,
        dataset: datasetFile.json,
        baselineResults: baselineFile.json.perQuery,
        fullRankings,
        activeChunkByKey,
        brandChangedQueries: brandFile.json.comparison.changedQueries,
        brandPrimaryCanaries: brandFile.json.primaryCanaries,
        gateWrongAnswerable: gateFile.json.inspectedWrongAnswerableTop1,
        rerankerChanged: rerankerFile.json.changedAnswerableRankings,
      }),
    );

    const report = {
      diagnostic: {
        id: "rag-unrecoverable-query-diagnosis",
        description:
          "Read-only diagnosis of baseline answerable queries whose expected chunks are absent from Top-3.",
        targetQueryIds: [...TARGET_QUERY_IDS],
        productionBehaviorChanged: false,
        retrievalCandidateExperiment: false,
        noDatabaseWrites: true,
      },
      inputs: {
        dataset: { path: DATASET_PATH, sha256: datasetFile.sha256 },
        artifacts: {
          baseline: { path: BASELINE_PATH, sha256: baselineFile.sha256 },
          brandTokenNormalization: { path: BRAND_PATH, sha256: brandFile.sha256 },
          faqQuestionGate: { path: GATE_PATH, sha256: gateFile.sha256 },
          faqQuestionReranker: { path: RERANKER_PATH, sha256: rerankerFile.sha256 },
        },
      },
      embeddingProfile: {
        id: RAG_EMBEDDING_PROFILE.id,
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
        artifact: RAG_EMBEDDING_PROFILE.artifact,
        queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
        passageInputRecipe: RAG_EMBEDDING_PROFILE.passageInputRecipe,
        normalized: RAG_EMBEDDING_PROFILE.normalized,
        similarity: "cosine via existing normalized embeddings",
      },
      activeChunks: activeChunkSummaries.map((chunk) => ({
        chunkKey: chunk.chunkKey,
        canonicalQuestion: chunk.canonicalQuestion,
        answer: chunk.answer,
      })),
      targetDiagnostics,
      crossExperimentConclusions: crossExperimentConclusions(targetDiagnostics),
      overfittingAssessment: {
        risk: "high",
        evidence: [
          "The same 52-query frozen dataset has already been used for baseline analysis and three rejected experiments.",
          "Brand-token normalization fixes these three target failures on this dataset but regresses other labeled queries.",
          "Further tuning on the same labels would likely optimize around known failures rather than generalize.",
        ],
        requirementBeforeFurtherTuning:
          "Create a separate development set and a held-out validation set before selecting or tuning another retrieval change.",
      },
      recommendedSmallestNextExperiment: {
        recommendation:
          "Build a small offline query-ablation diagnostic for brand-token sensitivity on a development split only, measuring whether standalone brand tokens cause systematic rank displacement before proposing any production candidate.",
        implementedHere: false,
      },
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

function targetDiagnosis(input: {
  id: string;
  dataset: readonly EvaluationQuery[];
  baselineResults: readonly BaselineQueryResult[];
  fullRankings: ReadonlyMap<string, readonly RankingEntry[]>;
  activeChunkByKey: ReadonlyMap<string, ActiveChunkSummary>;
  brandChangedQueries: readonly BrandComparisonQuery[];
  brandPrimaryCanaries: readonly BrandComparisonQuery[];
  gateWrongAnswerable: readonly GateQueryResult[];
  rerankerChanged: readonly RerankerChangedQuery[];
}) {
  const query = requiredById(input.dataset, input.id);
  if (query.expectedResult === null) {
    throw new Error(`Target ${input.id} must be answerable.`);
  }
  const baseline = requiredById(input.baselineResults, input.id);
  const expectedChunk = requiredMapValue(input.activeChunkByKey, query.expectedResult);
  const ranking = requiredMapValue(input.fullRankings, input.id);
  const expectedRanking = requiredRankingEntry(ranking, query.expectedResult);
  const top1 = requiredRankingEntry(ranking, baseline.top1ChunkKey ?? "");
  const rank3 = ranking[2];
  if (rank3 === undefined) {
    throw new Error(`Full ranking for ${input.id} has fewer than three rows.`);
  }
  const sameExpectedChunkQueries = input.dataset
    .filter((item) => item.expectedResult === query.expectedResult)
    .map((item) => comparisonQuerySummary(item, input.baselineResults, input.fullRankings));
  const baselineTop3 = [baseline.top1ChunkKey, baseline.top2ChunkKey, baseline.top3ChunkKey].map(
    (chunkKey, index) => {
      if (chunkKey === null) {
        throw new Error(`Baseline Top-${String(index + 1)} is missing for ${input.id}.`);
      }
      const chunk = requiredMapValue(input.activeChunkByKey, chunkKey);
      return {
        rank: index + 1,
        chunkKey,
        canonicalQuestion: chunk.canonicalQuestion,
        score: round([baseline.top1Score, baseline.top2Score, baseline.top3Score][index] ?? 0),
      };
    },
  );
  return {
    id: input.id,
    query: query.query,
    expectedChunk: {
      chunkKey: query.expectedResult,
      canonicalQuestion: expectedChunk.canonicalQuestion,
      relevantAnswerContent: expectedChunk.answer,
    },
    baselineTop3,
    fullRanking: {
      expectedChunkRank: expectedRanking.rank,
      expectedChunkScore: expectedRanking.score,
      top1Score: top1.score,
      top1MinusExpectedScoreGap: round(top1.score - expectedRanking.score),
      rank3MinusExpectedScoreGap: round(rank3.score - expectedRanking.score),
      orderedRanking: ranking,
    },
    sameExpectedChunkQueries,
    labelValidity: labelValidity(input.id),
    likelyCauses: likelyCauses(input.id),
    previousExperimentEvidence: previousExperimentEvidence(input.id, {
      brandChangedQueries: input.brandChangedQueries,
      brandPrimaryCanaries: input.brandPrimaryCanaries,
      gateWrongAnswerable: input.gateWrongAnswerable,
      rerankerChanged: input.rerankerChanged,
    }),
  };
}

function comparisonQuerySummary(
  item: EvaluationQuery,
  baselineResults: readonly BaselineQueryResult[],
  fullRankings: ReadonlyMap<string, readonly RankingEntry[]>,
) {
  const baseline = requiredById(baselineResults, item.id);
  const ranking = requiredMapValue(fullRankings, item.id);
  const expected =
    item.expectedResult === null ? null : requiredRankingEntry(ranking, item.expectedResult);
  return {
    id: item.id,
    category: item.category,
    query: item.query,
    baselineTop1ChunkKey: baseline.top1ChunkKey,
    baselineTop1Score: roundNullable(baseline.top1Score),
    expectedChunkRankInFullRanking: expected?.rank ?? null,
    expectedChunkScoreInFullRanking: expected?.score ?? null,
    successfulTop1: baseline.top1Correct,
  };
}

function labelValidity(id: string) {
  const rows = {
    "para-003-a": {
      expectedDirectlyAnswers: true,
      anotherChunkCouldReasonablyAnswer: false,
      ambiguousWithoutAdditionalContext: false,
      assessment:
        "The query asks where to look up the customer number; the expected Kundennummer FAQ directly answers that location. Registration and newsletter chunks do not answer it.",
      questionableLabel: false,
    },
    "para-006-a": {
      expectedDirectlyAnswers: true,
      anotherChunkCouldReasonablyAnswer: false,
      ambiguousWithoutAdditionalContext: false,
      assessment:
        "The query asks what to do after forgetting a password; the expected forgotten-password FAQ directly answers that recovery path. Registration/newsletter chunks do not answer password reset.",
      questionableLabel: false,
    },
    "para-012-b": {
      expectedDirectlyAnswers: true,
      anotherChunkCouldReasonablyAnswer: false,
      ambiguousWithoutAdditionalContext: true,
      assessment:
        "`löschen lassen` is slightly service-oriented wording, but the expected account-deletion FAQ is still the direct answer. The registration/newsletter chunks do not answer deletion.",
      questionableLabel: false,
    },
  } satisfies Record<string, Record<string, unknown>>;
  return requiredRecordValue(rows, id);
}

function likelyCauses(id: string) {
  const rows = {
    "para-003-a": [
      {
        cause: "competing chunks have stronger but misleading semantic overlap",
        evidence: [
          "Baseline Top-3 is registration/newsletter chunks, all with standalone `Manufactum` in their canonical questions.",
          "The successful same-label paraphrase `para-003-b` omits `Manufactum` and ranks the Kundennummer chunk first.",
          "Rejected brand-token normalization moved this query to the expected chunk on the frozen dataset.",
        ],
        counterevidence: [
          "The query contains the strong domain term `Kundennummer`, and the exact query for the same chunk succeeds.",
        ],
        confidence: "high",
        falsifier:
          "If full rankings for many brand-containing Kundennummer queries still preferred chunk 003 without brand removal, the brand-overlap explanation would weaken.",
      },
      {
        cause: "embedding-model limitation",
        evidence: [
          "The model ranks several semantically unrelated brand-bearing account/newsletter chunks above a chunk with the exact `Kundennummer` concept.",
        ],
        counterevidence: [
          "The same model retrieves chunk 003 for the exact query and for a paraphrase without `Manufactum`.",
        ],
        confidence: "medium",
        falsifier:
          "A second embedding model with the same unchanged query and passages showing the same displacement would make this less model-specific.",
      },
    ],
    "para-006-a": [
      {
        cause: "competing chunks have stronger but misleading semantic overlap",
        evidence: [
          "Baseline Top-3 is again brand-bearing registration/newsletter chunks, not password chunks.",
          "The exact forgotten-password query and the non-brand paraphrase both retrieve the expected chunk first.",
          "Rejected brand-token normalization moved this query to the expected chunk on the frozen dataset.",
        ],
        counterevidence: [
          "The query contains `Passwort vergessen`, which should strongly match the expected canonical FAQ question.",
        ],
        confidence: "high",
        falsifier:
          "If brand-containing forgotten-password paraphrases were added and consistently ranked chunk 006 first, the brand-token displacement diagnosis would weaken.",
      },
      {
        cause: "missing semantic signal in the query",
        evidence: [
          "The query asks broadly `Was mache ich` and includes the brand token, while the expected canonical question starts with `Ich habe mein Passwort vergessen`.",
        ],
        counterevidence: [
          "`Passwort vergessen` is still explicit and should be sufficient; the failure is not caused by absent topic vocabulary alone.",
        ],
        confidence: "low",
        falsifier:
          "A near-identical query without `Manufactum` ranking correctly would show the signal is present and the brand token is the larger issue.",
      },
    ],
    "para-012-b": [
      {
        cause: "competing chunk has stronger but misleading semantic overlap",
        evidence: [
          "Baseline Top-3 is registration/newsletter chunks with `Manufactum`; the account-deletion chunk is outside Top-3.",
          "The exact deletion query and the non-brand deletion paraphrase retrieve the expected chunk first.",
          "Rejected brand-token normalization moved this query to the expected chunk on the frozen dataset.",
        ],
        counterevidence: [
          "The query contains both `Konto` and `löschen`, matching the expected canonical question closely.",
        ],
        confidence: "high",
        falsifier:
          "If multiple `Manufactum Konto löschen` variants ranked chunk 012 first under baseline retrieval, this diagnosis would not hold.",
      },
      {
        cause: "ambiguous or underspecified user wording",
        evidence: [
          "`löschen lassen` can imply a service or human-assisted request rather than self-service account deletion.",
        ],
        counterevidence: [
          "Among the 12 active chunks, only the account-deletion FAQ directly answers deletion; registration/newsletter chunks are not reasonable answers.",
        ],
        confidence: "low",
        falsifier:
          "If an approved source later contains a separate support-assisted deletion FAQ, the current label may need reassessment.",
      },
    ],
  } satisfies Record<string, readonly Record<string, unknown>[]>;
  return requiredRecordValue(rows, id);
}

function previousExperimentEvidence(
  id: string,
  artifacts: {
    brandChangedQueries: readonly BrandComparisonQuery[];
    brandPrimaryCanaries: readonly BrandComparisonQuery[];
    gateWrongAnswerable: readonly GateQueryResult[];
    rerankerChanged: readonly RerankerChangedQuery[];
  },
) {
  const brand =
    artifacts.brandPrimaryCanaries.find((item) => item.id === id) ??
    artifacts.brandChangedQueries.find((item) => item.id === id) ??
    null;
  const gate = artifacts.gateWrongAnswerable.find((item) => item.id === id) ?? null;
  const reranker = artifacts.rerankerChanged.find((item) => item.id === id) ?? null;
  return {
    faqQuestionGate:
      gate === null
        ? null
        : {
            baselineTop1ChunkKey: gate.top1ChunkKey,
            top1QuestionMatchScore: roundNullable(gate.questionMatchScore),
            interpretation:
              "The gate scored only the unchanged wrong Top-1 candidate, so it could not promote an expected chunk that was absent from Top-3.",
          },
    top3Reranker:
      reranker === null
        ? null
        : {
            candidateTop1ChunkKey: reranker.candidate.top1ChunkKey,
            candidateTop1FaqQuestionScore: roundNullable(reranker.candidate.top1FaqQuestionScore),
            interpretation:
              "The Top-3 reranker could only reorder the original three wrong candidates; it could not recover an expected chunk absent from Top-3.",
          },
    brandTokenNormalization:
      brand === null
        ? null
        : {
            baselineTop1ChunkKey: brand.baseline.top1ChunkKey,
            baselineTop1Score: roundNullable(brand.baseline.top1Score),
            baselineExpectedRank: brand.baseline.expectedRank,
            candidateTop1ChunkKey: brand.candidate.top1ChunkKey,
            candidateTop1Score: roundNullable(brand.candidate.top1Score),
            candidateExpectedRank: brand.candidate.expectedRank,
            interpretation:
              "Brand-token normalization recovered this target on the frozen dataset, which supports brand-token displacement as a diagnosis but remains rejected because it caused regressions elsewhere.",
          },
  };
}

function crossExperimentConclusions(
  targetDiagnostics: readonly ReturnType<typeof targetDiagnosis>[],
) {
  return {
    faqGate:
      "The FAQ-question gate cannot correct these failures because it keeps baseline Top-1 fixed; it can only accept or reject the already-wrong chunk.",
    top3Reranker:
      "The Top-3 reranker cannot correct these three failures because each expected chunk is absent from the original Top-3.",
    brandTokenNormalization:
      "Brand-token normalization recovered all three target failures in the rejected experiment, weakening explanations based only on bad labels or missing answer content. It was still rejected because it regressed other answerable queries.",
    weakenedHypotheses: [
      "The expected chunks are not missing from storage: all are active and rank in the full 12-chunk list.",
      "FAQ-question reranking over only Top-3 is insufficient: the expected chunks are outside the candidate set.",
      "A pure answerability gate is the wrong mechanism for these ranking failures.",
    ],
    targetCount: targetDiagnostics.length,
  };
}

function sameExpectedChunkComparisonIds(
  dataset: readonly EvaluationQuery[],
  targetIds: readonly string[],
): string[] {
  const expectedChunks = new Set(
    targetIds.map((id) => {
      const item = requiredById(dataset, id);
      if (item.expectedResult === null) {
        throw new Error(`Target ${id} must have an expected result.`);
      }
      return item.expectedResult;
    }),
  );
  return dataset
    .filter((item) => item.expectedResult !== null && expectedChunks.has(item.expectedResult))
    .map((item) => item.id);
}

function activeChunkSummary(chunk: StoredChunk): ActiveChunkSummary {
  return {
    chunkKey: chunk.chunkKey,
    canonicalQuestion: chunk.question,
    answer: chunk.answer,
    content: chunk.content,
  };
}

function rankingEntry(entry: RelevantChunkSearchResult, index: number): RankingEntry {
  return {
    rank: index + 1,
    chunkKey: entry.chunkKey,
    canonicalQuestion: extractCanonicalFaqQuestion(entry.content),
    score: round(entry.score),
  };
}

function extractCanonicalFaqQuestion(content: string): string {
  const match = /^Frage:\s*(.*?)\n\nAntwort:/s.exec(content);
  if (match?.[1] === undefined || match[1].trim().length === 0) {
    throw new Error("Chunk content did not contain a canonical `Frage:` section.");
  }
  return match[1].trim();
}

function requiredRankingEntry(ranking: readonly RankingEntry[], chunkKey: string): RankingEntry {
  const entry = ranking.find((item) => item.chunkKey === chunkKey);
  if (entry === undefined) {
    throw new Error(`Missing chunk ${chunkKey} in full ranking.`);
  }
  return entry;
}

function requiredById<T extends { id: string }>(items: readonly T[], id: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`Missing item ${id}.`);
  }
  return item;
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing map value for ${String(key)}.`);
  }
  return value;
}

function requiredRecordValue<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`Missing record value for ${key}.`);
  }
  return value;
}

async function readJsonFile<T>(filePath: string): Promise<{ json: T; sha256: string }> {
  const raw = await fs.readFile(filePath, "utf8");
  return { json: JSON.parse(raw) as T, sha256: sha256Hex(raw) };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function roundNullable(value: number | null): number | null {
  return value === null ? null : round(value);
}

function parseOutputPath(args: string[]): string {
  const outputIndex = args.indexOf("--output");
  if (outputIndex === -1) {
    return OUTPUT_PATH;
  }
  const outputPath = args[outputIndex + 1]?.trim();
  if (outputPath === undefined || outputPath.length === 0) {
    throw new Error("--output requires a non-empty path.");
  }
  if (outputPath !== OUTPUT_PATH) {
    throw new Error(`Diagnosis output must be ${OUTPUT_PATH}.`);
  }
  return outputPath;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

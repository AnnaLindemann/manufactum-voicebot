import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from "prettier";
import {
  buildCandidatePassageRepresentation as buildAcceptedCanonicalizedRepresentation,
  countStandaloneManufactum,
} from "./evaluate-rag-passage-brand-context-canonicalization.js";
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
  faqCategory: string | null;
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

type CandidateRankedChunk = RankedChunk & {
  firstStageRank: number;
  rerankerScore: number | null;
};

/**
 * The only input the second stage consumes. Deliberately carries no query identifier, no
 * evaluation label, and no dataset field, so no target-query-specific branch can exist.
 */
export type RerankCandidate = {
  chunkKey: string;
  firstStageRank: number;
  rerankerScore: number;
};

export type ExperimentQueryResult = {
  id: string;
  query: string;
  queryType: QueryType;
  faqCategory: string | null;
  answerability: Answerability;
  answerable: boolean;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
  queryEmbeddingInputHash: string;
  controlQueryEmbeddingInputHash: string;
  queryInputByteIdenticalToControl: boolean;
  queryEmbeddingTokenCount: number;
  firstStageRanking: RankedChunk[];
  firstStageTop3ChunkKeys: string[];
  rerankerScoresForTop3: { chunkKey: string; firstStageRank: number; rerankerScore: number }[];
  candidateRanking: CandidateRankedChunk[];
  candidateTop3ChunkKeys: string[];
  top3MembershipUnchanged: boolean;
  top3OrderChanged: boolean;
  controlExpectedRank: number | null;
  candidateExpectedRank: number | null;
  controlTop1ChunkKey: string | null;
  candidateTop1ChunkKey: string | null;
  controlTop1EvidenceIds: string[];
  candidateTop1EvidenceIds: string[];
  controlTop1Correct: boolean | null;
  candidateTop1Correct: boolean | null;
  controlRecallAt3: boolean | null;
  candidateRecallAt3: boolean | null;
  controlReciprocalRank: number;
  candidateReciprocalRank: number;
  controlTopScore: number | null;
  candidateTopScore: number | null;
  classification: "correction" | "regression" | "unchanged";
  neutralRankingChange: boolean;
};

type ControlQueryResult = {
  id: string;
  queryEmbeddingInputHash: string;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  expectedScore: number | null;
  rankings: RankedChunk[];
};

type AnswerableMetrics = {
  count: number;
  top1CorrectCount: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
};

type AcceptedControlMetrics = {
  answerable: {
    count: number;
    recallAt1: number;
    recallAt3: number;
    mrr: number;
  };
};

type AcceptedBaselineArtifact = {
  schemaVersion: "rag-development-baseline-retrieval-results-v1";
  frozenInputs: {
    datasetSha256: string;
    manifestSha256: string;
    evidenceInventorySha256: string;
  };
  activeChunkSet: {
    chunkCount: number;
    orderedChunks: {
      chunkIndex: number;
      chunkKey: string;
      chunkHash: string;
    }[];
  };
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

type AcceptedControlArtifact = {
  schemaVersion: "rag-passage-brand-context-canonicalization-experiment-results-v1";
  frozenInputs: {
    datasetSha256: string;
    baselineSha256: string;
    mappingSha256: string;
  };
  candidatePassageInputs: {
    chunkKey: string;
    candidateRepresentationSha256: string;
    candidateEmbeddingInputHash: string;
  }[];
  queryInputProof: {
    allByteIdenticalToBaseline: boolean;
  };
  metrics: {
    candidate: AcceptedControlMetrics;
  };
  perQuery: ControlQueryResult[];
  decision: "experiment_passed" | "experiment_rejected";
};

type ControlPassage = {
  chunkKey: string;
  representation: string;
  canonicalizedQuestion: string;
  canonicalizedAnswer: string;
  representationSha256: string;
  embeddingInputHash: string;
  tokenCount: number;
  embedding: number[];
};

type RerankerText = {
  chunkKey: string;
  text: string;
  canonicalizedQuestion: string;
  textSha256: string;
  embeddingInputHash: string;
  tokenCount: number;
  embedding: number[];
};

const DATASET_PATH = "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json";
const BASELINE_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json";
const MAPPING_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json";
const CONTROL_PATH =
  "docs/evaluation/rag-passage-brand-context-canonicalization-experiment-results.json";
const DEFAULT_OUTPUT_PATH =
  "docs/evaluation/rag-canonical-question-top3-reranking-experiment-results.json";
const ACCEPTED_CONTROL_SHA256 = "13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d";
const EXPECTED_HEAD = "18fafd15a08fb4bce75de892d2953077b6a5067a";
const DOCUMENT_KEY = "mein-konto";
const TOP_K_FOR_RECALL = 3;
const RERANK_TOP_K = 3;
const CONTROL_RECALL_AT_1 = 0.944444;
const CONTROL_RECALL_AT_3 = 1;
const CONTROL_MRR = 0.969907;
const CONTROL_TOP_1_CORRECT_COUNT = 68;
const CONTROL_ANSWERABLE_COUNT = 72;
const CONTROL_UNANSWERABLE_COUNT = 24;

/**
 * Reporting-only identifiers. They are read after every ranking decision has already been made and
 * never reach passage construction, reranker-text construction, embedding, or ordering.
 */
const REPORTED_TARGET_IDS = [
  "mein-konto-v1-dev-015",
  "mein-konto-v1-dev-067",
  "mein-konto-v1-dev-068",
  "mein-konto-v1-dev-069",
];
const REPORTED_MERKLISTE_TARGET_IDS = [
  "mein-konto-v1-dev-067",
  "mein-konto-v1-dev-068",
  "mein-konto-v1-dev-069",
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for the canonical question Top-3 reranking run.");
  }

  const outputPath = cliValue("--output") ?? DEFAULT_OUTPUT_PATH;
  const datasetBefore = await readJsonFile<DevelopmentQuery[]>(DATASET_PATH);
  const baselineBefore = await readJsonFile<AcceptedBaselineArtifact>(BASELINE_PATH);
  const mappingBefore = await readJsonFile<EvidenceMappingArtifact>(MAPPING_PATH);
  const controlBefore = await readJsonFile<AcceptedControlArtifact>(CONTROL_PATH);
  const preflight = validateFrozenInputs(
    datasetBefore,
    baselineBefore,
    mappingBefore,
    controlBefore,
  );

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

    const controlPassages = await embedControlPassages(chunks, generator);
    validateControlRepresentations(controlPassages, controlBefore.value);
    const rerankerTexts = await embedRerankerTexts(controlPassages, generator);
    const rerankerInvariants = validateRerankerInvariants(chunks, controlPassages, rerankerTexts);

    const perQuery = (
      await evaluateQueries({
        dataset: datasetBefore.value,
        acceptedControl: controlBefore.value,
        mapping: mappingBefore.value,
        chunks,
        controlPassages,
        rerankerTexts,
        generator,
      })
    ).map(roundQueryResult);

    const controlReproduction = compareControlReproduction(controlBefore.value, perQuery);
    if (!controlReproduction.matchesAcceptedControl) {
      throw new Error(`control_mismatch: ${controlReproduction.mismatchReason ?? "unknown"}`);
    }

    const controlMetrics = computeControlMetrics(perQuery);
    const candidateMetrics = computeCandidateMetrics(perQuery);
    const retrievalInvariants = computeRetrievalInvariants(perQuery, controlBefore.value);
    const analysis = analyseChanges(perQuery);
    const targetAnalysis = analyseTargetQueries(perQuery);
    const sameIntentStability = analyseSameIntentStability(perQuery);
    const gates = evaluateAcceptanceGates({
      candidateMetrics,
      analysis,
      rerankerInvariants,
      retrievalInvariants,
    });

    const result = {
      schemaVersion: "rag-canonical-question-top3-reranking-experiment-results-v1",
      experiment: {
        id: "canonical-question-top3-reranking",
        gitCommit: git(["rev-parse", "HEAD"]),
        evaluationTimestamp: new Date().toISOString(),
        productionBehaviorChanged: false,
        databaseMutationIntended: false,
        activationIntended: false,
        thresholdTuned: false,
        thresholdProposed: false,
        baselinePromotionIntended: false,
      },
      preflight,
      frozenInputs: {
        datasetPath: DATASET_PATH,
        datasetSha256: datasetBefore.sha256,
        baselinePath: BASELINE_PATH,
        baselineSha256: baselineBefore.sha256,
        mappingPath: MAPPING_PATH,
        mappingSha256: mappingBefore.sha256,
        controlPath: CONTROL_PATH,
        controlSha256: controlBefore.sha256,
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
        changedOnly:
          "one fixed canonical-question-only reranking stage applied to the unchanged first-stage Top-3",
        controlPassageRepresentationRule:
          "Marke: Manufactum\\n\\nFrage: {canonicalizedQuestion}\\n\\nAntwort: {canonicalizedAnswer}",
        rerankerTextRule: "Marke: Manufactum\\n\\nFrage: {canonicalizedQuestion}",
        rerankerTextPersisted: false,
        firstStageChanged: false,
        firstStageRankingScope: "complete 12-chunk candidate set",
        secondStageRankingScope: "exact first-stage Top-3 only",
        rerankTopK: RERANK_TOP_K,
        tieBreaker: "descending reranker cosine, then ascending first-stage rank",
        queryTextChanged: false,
        queryEmbeddingBehaviorChanged: false,
        similarityFunction: "cosine_similarity = dot_product over normalized embeddings",
        topKForRecall: TOP_K_FOR_RECALL,
        thresholdApplied: false,
        scoreSpacesMixed: false,
        databaseWrites: false,
      },
      controlReproduction,
      controlPassageInputs: controlPassages.map((passage) => ({
        chunkKey: passage.chunkKey,
        representation: passage.representation,
        representationSha256: passage.representationSha256,
        embeddingInputHash: passage.embeddingInputHash,
        embeddingTokenCount: passage.tokenCount,
        manufactumStandaloneOccurrences: countStandaloneManufactum(passage.representation),
      })),
      rerankerTextInputs: rerankerTexts.map((text) => ({
        chunkKey: text.chunkKey,
        text: text.text,
        textSha256: text.textSha256,
        embeddingInputHash: text.embeddingInputHash,
        embeddingTokenCount: text.tokenCount,
        markeLineCount: countLinesStartingWith(text.text, "Marke: "),
        frageLineCount: countLinesStartingWith(text.text, "Frage: "),
        antwortLineCount: countLinesStartingWith(text.text, "Antwort: "),
        containsAnswerText: false,
        questionMatchesControlCanonicalizedQuestion: true,
      })),
      rerankerInvariants,
      retrievalInvariants,
      metrics: {
        control: controlMetrics,
        candidate: candidateMetrics,
        acceptedControl: {
          top1CorrectCount: CONTROL_TOP_1_CORRECT_COUNT,
          recallAt1: CONTROL_RECALL_AT_1,
          recallAt3: CONTROL_RECALL_AT_3,
          mrr: CONTROL_MRR,
        },
        deltas: {
          recallAt1: round(candidateMetrics.recallAt1 - controlMetrics.recallAt1),
          recallAt3: round(candidateMetrics.recallAt3 - controlMetrics.recallAt3),
          mrr: round(candidateMetrics.mrr - controlMetrics.mrr),
          top1CorrectCount: candidateMetrics.top1CorrectCount - controlMetrics.top1CorrectCount,
        },
      },
      analysis,
      targetAnalysis,
      sameIntentStability,
      scoreInterpretation: {
        firstStageScoreSpace:
          "cosine similarity between the query embedding and the full canonical passage embedding",
        secondStageScoreSpace:
          "cosine similarity between the same query embedding and the transient canonical-question-only text embedding",
        spacesCombined: false,
        sharedThresholdComputed: false,
        rerankerScoreTreatedAsCalibrated: false,
        productionThresholdCompatibility:
          "none: reranker cosines are not comparable to the accepted production threshold",
        evaluationBasis: ["ranks", "corrections", "regressions", "recallAt1", "recallAt3", "mrr"],
      },
      acceptanceGates: gates,
      decision: gates.allGatesPassed
        ? "experiment_candidate_accepted_for_independent_audit"
        : "experiment_rejected",
      perQuery,
    };

    await client.query("COMMIT");
    await writeJson(outputPath, result);
    console.log(
      JSON.stringify(
        {
          outputPath,
          decision: result.decision,
          control: controlMetrics,
          candidate: candidateMetrics,
          corrections: analysis.corrections.map((item) => item.id),
          regressions: analysis.regressions.map((item) => item.id),
          gates: gates.checks,
        },
        null,
        2,
      ),
    );
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
  await assertFileSha256(CONTROL_PATH, controlBefore.sha256, "Accepted control artifact");
}

/**
 * The accepted control passage representation. Delegates to the accepted canonicalization recipe so
 * this experiment cannot silently redefine it.
 */
export function buildControlPassageRepresentation(input: {
  originalQuestion: string;
  originalAnswer: string;
}): { representation: string; canonicalizedQuestion: string; canonicalizedAnswer: string } {
  const representation = buildAcceptedCanonicalizedRepresentation(input).representation;
  const match =
    /^Marke: Manufactum\n\nFrage: (?<question>[\s\S]+?)\n\nAntwort: (?<answer>[\s\S]+)$/u.exec(
      representation,
    );
  if (match?.groups === undefined) {
    throw new Error("Accepted canonicalized representation has an unexpected shape.");
  }
  return {
    representation,
    canonicalizedQuestion: match.groups.question!,
    canonicalizedAnswer: match.groups.answer!,
  };
}

/**
 * The single fixed second-stage representation: brand line plus the accepted canonicalized source
 * FAQ question, with no answer text. Applied identically to every chunk.
 */
export function buildRerankerText(input: { originalQuestion: string; originalAnswer: string }): {
  text: string;
  canonicalizedQuestion: string;
} {
  const control = buildControlPassageRepresentation(input);
  return {
    text: `Marke: Manufactum\n\nFrage: ${control.canonicalizedQuestion}`,
    canonicalizedQuestion: control.canonicalizedQuestion,
  };
}

export function countLinesStartingWith(input: string, prefix: string): number {
  return input.split("\n").filter((line) => line.startsWith(prefix)).length;
}

/**
 * Deterministic second stage: descending reranker cosine, first-stage rank as tie-breaker.
 * Consumes no query identity, so it cannot behave differently for any particular query.
 */
export function rerankTop3(candidates: RerankCandidate[]): RerankCandidate[] {
  if (candidates.length !== RERANK_TOP_K) {
    throw new Error(
      `Reranking expects exactly ${String(RERANK_TOP_K)} candidates, received ${String(
        candidates.length,
      )}.`,
    );
  }
  return [...candidates].sort(
    (left, right) =>
      right.rerankerScore - left.rerankerScore || left.firstStageRank - right.firstStageRank,
  );
}

async function evaluateQueries(input: {
  dataset: DevelopmentQuery[];
  acceptedControl: AcceptedControlArtifact;
  mapping: EvidenceMappingArtifact;
  chunks: ActiveChunk[];
  controlPassages: ControlPassage[];
  rerankerTexts: RerankerText[];
  generator: TransformersE5SmallPassageEmbeddingGenerator;
}): Promise<ExperimentQueryResult[]> {
  const controlById = new Map(input.acceptedControl.perQuery.map((query) => [query.id, query]));
  const rerankerByChunkKey = new Map(input.rerankerTexts.map((text) => [text.chunkKey, text]));
  const results: ExperimentQueryResult[] = [];
  for (const record of input.dataset) {
    const acceptedControl = controlById.get(record.id);
    if (acceptedControl === undefined) {
      throw new Error(`Accepted control artifact has no result for ${record.id}.`);
    }
    const queryEmbedding = await input.generator.embedQuery(record.query);
    const firstStageRanking = rankChunks({
      queryEmbedding: queryEmbedding.embedding,
      chunks: input.chunks,
      controlPassages: input.controlPassages,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      mapping: input.mapping,
    });

    const firstStageTop3 = firstStageRanking.slice(0, RERANK_TOP_K);
    const rerankCandidates: RerankCandidate[] = firstStageTop3.map((ranking) => {
      const rerankerText = rerankerByChunkKey.get(ranking.chunkKey);
      if (rerankerText === undefined) {
        throw new Error(`Missing reranker text embedding for ${ranking.chunkKey}.`);
      }
      return {
        chunkKey: ranking.chunkKey,
        firstStageRank: ranking.rank,
        rerankerScore: dotProduct(queryEmbedding.embedding, rerankerText.embedding),
      };
    });
    const reordered = rerankTop3(rerankCandidates);
    const firstStageByChunkKey = new Map(
      firstStageRanking.map((ranking) => [ranking.chunkKey, ranking]),
    );
    const candidateRanking: CandidateRankedChunk[] = [
      ...reordered.map((candidate, index) => ({
        ...firstStageByChunkKey.get(candidate.chunkKey)!,
        rank: index + 1,
        firstStageRank: candidate.firstStageRank,
        rerankerScore: candidate.rerankerScore,
      })),
      ...firstStageRanking.slice(RERANK_TOP_K).map((ranking) => ({
        ...ranking,
        firstStageRank: ranking.rank,
        rerankerScore: null,
      })),
    ];

    const answerable = record.answerability === "answerable";
    const controlExpectedRank = answerable ? firstAcceptableRank(firstStageRanking) : null;
    const candidateExpectedRank = answerable ? firstAcceptableRank(candidateRanking) : null;
    const controlTop1 = firstStageRanking[0];
    const candidateTop1 = candidateRanking[0];
    const controlTop1Correct = answerable
      ? (controlTop1?.acceptableEvidenceIdsWithFullCoverage.length ?? 0) > 0
      : null;
    const candidateTop1Correct = answerable
      ? (candidateTop1?.acceptableEvidenceIdsWithFullCoverage.length ?? 0) > 0
      : null;
    const firstStageTop3ChunkKeys = firstStageTop3.map((ranking) => ranking.chunkKey);
    const candidateTop3ChunkKeys = candidateRanking
      .slice(0, RERANK_TOP_K)
      .map((ranking) => ranking.chunkKey);
    const classification: ExperimentQueryResult["classification"] =
      !answerable || controlExpectedRank === candidateExpectedRank
        ? "unchanged"
        : controlExpectedRank !== 1 && candidateExpectedRank === 1
          ? "correction"
          : controlExpectedRank === 1 && candidateExpectedRank !== 1
            ? "regression"
            : "unchanged";
    const top3OrderChanged =
      JSON.stringify(firstStageTop3ChunkKeys) !== JSON.stringify(candidateTop3ChunkKeys);

    results.push({
      id: record.id,
      query: record.query,
      queryType: record.queryType,
      faqCategory: record.faqCategory,
      answerability: record.answerability,
      answerable,
      faqIntentId: record.faqIntentId,
      expectedEvidenceId: record.expectedEvidenceId,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      queryEmbeddingInputHash: queryEmbedding.inputHash,
      controlQueryEmbeddingInputHash: acceptedControl.queryEmbeddingInputHash,
      queryInputByteIdenticalToControl:
        queryEmbedding.inputHash === acceptedControl.queryEmbeddingInputHash,
      queryEmbeddingTokenCount: queryEmbedding.tokenCount,
      firstStageRanking,
      firstStageTop3ChunkKeys,
      rerankerScoresForTop3: rerankCandidates,
      candidateRanking,
      candidateTop3ChunkKeys,
      top3MembershipUnchanged:
        JSON.stringify([...firstStageTop3ChunkKeys].sort()) ===
        JSON.stringify([...candidateTop3ChunkKeys].sort()),
      top3OrderChanged,
      controlExpectedRank,
      candidateExpectedRank,
      controlTop1ChunkKey: controlTop1?.chunkKey ?? null,
      candidateTop1ChunkKey: candidateTop1?.chunkKey ?? null,
      controlTop1EvidenceIds: controlTop1?.acceptableEvidenceIdsWithFullCoverage ?? [],
      candidateTop1EvidenceIds: candidateTop1?.acceptableEvidenceIdsWithFullCoverage ?? [],
      controlTop1Correct,
      candidateTop1Correct,
      controlRecallAt3: answerable
        ? controlExpectedRank !== null && controlExpectedRank <= TOP_K_FOR_RECALL
        : null,
      candidateRecallAt3: answerable
        ? candidateExpectedRank !== null && candidateExpectedRank <= TOP_K_FOR_RECALL
        : null,
      controlReciprocalRank: controlExpectedRank === null ? 0 : 1 / controlExpectedRank,
      candidateReciprocalRank: candidateExpectedRank === null ? 0 : 1 / candidateExpectedRank,
      controlTopScore: controlTop1?.score ?? null,
      candidateTopScore: candidateTop1?.score ?? null,
      classification,
      neutralRankingChange: top3OrderChanged && classification === "unchanged",
    });
  }
  return results;
}

function firstAcceptableRank(
  rankings: { rank: number; acceptableEvidenceIdsWithFullCoverage: string[] }[],
): number | null {
  return (
    rankings.find((ranking) => ranking.acceptableEvidenceIdsWithFullCoverage.length > 0)?.rank ??
    null
  );
}

function rankChunks(input: {
  queryEmbedding: number[];
  chunks: ActiveChunk[];
  controlPassages: ControlPassage[];
  acceptableEvidenceIds: string[];
  mapping: EvidenceMappingArtifact;
}): RankedChunk[] {
  const passageByChunkKey = new Map(
    input.controlPassages.map((passage) => [passage.chunkKey, passage]),
  );
  return input.chunks
    .map((chunk) => {
      const passage = passageByChunkKey.get(chunk.chunkKey);
      if (passage === undefined) {
        throw new Error(`Missing control passage embedding for ${chunk.chunkKey}.`);
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

async function embedControlPassages(
  chunks: ActiveChunk[],
  generator: TransformersE5SmallPassageEmbeddingGenerator,
): Promise<ControlPassage[]> {
  const passages: ControlPassage[] = [];
  for (const chunk of chunks) {
    const built = buildControlPassageRepresentation({
      originalQuestion: chunk.question,
      originalAnswer: chunk.answer,
    });
    const embedding = await generator.embedPassage(built.representation);
    passages.push({
      chunkKey: chunk.chunkKey,
      representation: built.representation,
      canonicalizedQuestion: built.canonicalizedQuestion,
      canonicalizedAnswer: built.canonicalizedAnswer,
      representationSha256: sha256Hex(built.representation),
      embeddingInputHash: embedding.inputHash,
      tokenCount: embedding.tokenCount,
      embedding: embedding.embedding,
    });
  }
  return passages;
}

async function embedRerankerTexts(
  controlPassages: ControlPassage[],
  generator: TransformersE5SmallPassageEmbeddingGenerator,
): Promise<RerankerText[]> {
  const texts: RerankerText[] = [];
  for (const passage of controlPassages) {
    const text = `Marke: Manufactum\n\nFrage: ${passage.canonicalizedQuestion}`;
    const embedding = await generator.embedPassage(text);
    texts.push({
      chunkKey: passage.chunkKey,
      text,
      canonicalizedQuestion: passage.canonicalizedQuestion,
      textSha256: sha256Hex(text),
      embeddingInputHash: embedding.inputHash,
      tokenCount: embedding.tokenCount,
      embedding: embedding.embedding,
    });
  }
  return texts;
}

function validateControlRepresentations(
  controlPassages: ControlPassage[],
  acceptedControl: AcceptedControlArtifact,
): void {
  const acceptedByChunk = new Map(
    acceptedControl.candidatePassageInputs.map((passage) => [passage.chunkKey, passage]),
  );
  for (const passage of controlPassages) {
    const accepted = acceptedByChunk.get(passage.chunkKey);
    if (accepted === undefined) {
      throw new Error(`Accepted control artifact has no passage for ${passage.chunkKey}.`);
    }
    if (passage.representationSha256 !== accepted.candidateRepresentationSha256) {
      throw new Error(`Control representation hash mismatch for ${passage.chunkKey}.`);
    }
    if (passage.embeddingInputHash !== accepted.candidateEmbeddingInputHash) {
      throw new Error(`Control embedding input hash mismatch for ${passage.chunkKey}.`);
    }
    if (countStandaloneManufactum(passage.representation) !== 1) {
      throw new Error(`Control representation brand invariant failed for ${passage.chunkKey}.`);
    }
  }
}

function validateRerankerInvariants(
  chunks: ActiveChunk[],
  controlPassages: ControlPassage[],
  rerankerTexts: RerankerText[],
) {
  const chunkKeys = chunks.map((chunk) => chunk.chunkKey);
  const controlByChunk = new Map(controlPassages.map((passage) => [passage.chunkKey, passage]));
  const textProofs = rerankerTexts.map((text) => {
    const control = controlByChunk.get(text.chunkKey);
    if (control === undefined) {
      throw new Error(`Missing control passage for ${text.chunkKey}.`);
    }
    const rebuilt = buildRerankerText({
      originalQuestion: chunks.find((chunk) => chunk.chunkKey === text.chunkKey)!.question,
      originalAnswer: chunks.find((chunk) => chunk.chunkKey === text.chunkKey)!.answer,
    });
    return {
      chunkKey: text.chunkKey,
      markeLineCount: countLinesStartingWith(text.text, "Marke: "),
      frageLineCount: countLinesStartingWith(text.text, "Frage: "),
      antwortLineCount: countLinesStartingWith(text.text, "Antwort: "),
      manufactumStandaloneOccurrences: countStandaloneManufactum(text.text),
      questionMatchesControl: text.canonicalizedQuestion === control.canonicalizedQuestion,
      containsControlAnswerText: text.text.includes(control.canonicalizedAnswer),
      matchesFixedRule: text.text === rebuilt.text,
      textSha256: text.textSha256,
    };
  });
  return {
    rerankerTextCount: rerankerTexts.length,
    expectedRerankerTextCount: 12,
    exactly12RerankerTextsConstructed:
      rerankerTexts.length === 12 &&
      new Set(rerankerTexts.map((text) => text.chunkKey)).size === 12 &&
      chunkKeys.every((chunkKey) => rerankerTexts.some((text) => text.chunkKey === chunkKey)),
    everyTextHasExactlyOneMarkeLine: textProofs.every((proof) => proof.markeLineCount === 1),
    everyTextHasExactlyOneFrageLine: textProofs.every((proof) => proof.frageLineCount === 1),
    noTextHasAnAntwortLine: textProofs.every((proof) => proof.antwortLineCount === 0),
    noTextContainsControlAnswerText: textProofs.every((proof) => !proof.containsControlAnswerText),
    everyTextHasExactlyOneStandaloneManufactum: textProofs.every(
      (proof) => proof.manufactumStandaloneOccurrences === 1,
    ),
    everyQuestionMatchesAcceptedCanonicalizedQuestion: textProofs.every(
      (proof) => proof.questionMatchesControl,
    ),
    fixedRuleAppliedUniformly: textProofs.every((proof) => proof.matchesFixedRule),
    constructionInputs: ["originalQuestion"],
    queryOrLabelDataInfluencedConstruction: false,
    rerankerTextsPersisted: false,
    deterministicOrdering:
      JSON.stringify(rerankerTexts.map((text) => text.chunkKey)) === JSON.stringify(chunkKeys),
    textProofs,
  };
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

function validateFrozenInputs(
  dataset: { value: DevelopmentQuery[]; sha256: string },
  baseline: { value: AcceptedBaselineArtifact; sha256: string },
  mapping: { value: EvidenceMappingArtifact; sha256: string },
  control: { value: AcceptedControlArtifact; sha256: string },
) {
  const branch = git(["branch", "--show-current"]);
  const head = git(["rev-parse", "HEAD"]);
  const originMain = git(["rev-parse", "origin/main"]);
  const trackedChanges = git(["status", "--short", "--untracked-files=no"]);
  if (branch !== "main") {
    throw new Error("Preflight failed: branch is not main.");
  }
  if (head !== EXPECTED_HEAD) {
    throw new Error("Preflight failed: HEAD does not match the expected checkpoint.");
  }
  if (originMain !== EXPECTED_HEAD) {
    throw new Error("Preflight failed: origin/main does not match the expected checkpoint.");
  }
  if (trackedChanges !== "") {
    throw new Error("Preflight failed: tracked changes are present.");
  }
  if (control.sha256 !== ACCEPTED_CONTROL_SHA256) {
    throw new Error("Accepted control artifact SHA-256 mismatch.");
  }
  if (baseline.value.schemaVersion !== "rag-development-baseline-retrieval-results-v1") {
    throw new Error("Unexpected baseline artifact schema.");
  }
  if (mapping.value.schemaVersion !== "rag-baseline-evidence-chunk-mapping-v1") {
    throw new Error("Unexpected evidence mapping schema.");
  }
  if (
    control.value.schemaVersion !==
    "rag-passage-brand-context-canonicalization-experiment-results-v1"
  ) {
    throw new Error("Unexpected accepted control artifact schema.");
  }
  if (control.value.decision !== "experiment_passed") {
    throw new Error("Accepted control artifact is not an accepted experiment.");
  }
  if (dataset.sha256 !== baseline.value.frozenInputs.datasetSha256) {
    throw new Error("Development dataset does not match the accepted baseline artifact.");
  }
  if (dataset.sha256 !== mapping.value.frozenInputs.datasetSha256) {
    throw new Error("Development dataset does not match the accepted mapping artifact.");
  }
  if (dataset.sha256 !== control.value.frozenInputs.datasetSha256) {
    throw new Error("Development dataset does not match the accepted control artifact.");
  }
  if (baseline.sha256 !== control.value.frozenInputs.baselineSha256) {
    throw new Error("Accepted baseline artifact does not match the accepted control artifact.");
  }
  if (mapping.sha256 !== control.value.frozenInputs.mappingSha256) {
    throw new Error("Accepted mapping artifact does not match the accepted control artifact.");
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
  if (JSON.stringify(ids) !== JSON.stringify(control.value.perQuery.map((record) => record.id))) {
    throw new Error("Accepted control query order does not match the frozen dataset.");
  }
  const answerableCount = dataset.value.filter(
    (record) => record.answerability === "answerable",
  ).length;
  const unanswerableCount = dataset.value.length - answerableCount;
  if (
    answerableCount !== CONTROL_ANSWERABLE_COUNT ||
    unanswerableCount !== CONTROL_UNANSWERABLE_COUNT
  ) {
    throw new Error("Frozen dataset answerable/unanswerable split changed.");
  }
  if (!control.value.queryInputProof.allByteIdenticalToBaseline) {
    throw new Error("Accepted control did not preserve baseline query input behavior.");
  }
  if (control.value.metrics.candidate.answerable.recallAt1 !== CONTROL_RECALL_AT_1) {
    throw new Error("Accepted control Recall@1 is not the expected value.");
  }
  if (control.value.metrics.candidate.answerable.recallAt3 !== CONTROL_RECALL_AT_3) {
    throw new Error("Accepted control Recall@3 is not the expected value.");
  }
  if (control.value.metrics.candidate.answerable.mrr !== CONTROL_MRR) {
    throw new Error("Accepted control MRR is not the expected value.");
  }
  return {
    branch,
    head,
    originMain,
    expectedHead: EXPECTED_HEAD,
    headMatchesExpected: head === EXPECTED_HEAD,
    originMainMatchesExpected: originMain === EXPECTED_HEAD,
    trackedChangesAbsent: trackedChanges === "",
    acceptedControlSha256: control.sha256,
    acceptedControlSha256Matches: control.sha256 === ACCEPTED_CONTROL_SHA256,
    answerableCount,
    unanswerableCount,
    historicalDatasetsRead: [],
    heldOutDataAccessed: false,
  };
}

function validateActiveChunksAgainstBaseline(
  chunks: ActiveChunk[],
  baseline: AcceptedBaselineArtifact,
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

function compareControlReproduction(
  acceptedControl: AcceptedControlArtifact,
  reproduced: ExperimentQueryResult[],
) {
  const acceptedById = new Map(acceptedControl.perQuery.map((query) => [query.id, query]));
  const scoreDeltas: number[] = [];
  const mismatches: string[] = [];
  let rankingOrderIdenticalQueryCount = 0;
  for (const query of reproduced) {
    const accepted = acceptedById.get(query.id);
    if (accepted === undefined) {
      mismatches.push(`${query.id}: missing accepted control query`);
      continue;
    }
    const acceptedOrder = accepted.rankings.map((ranking) => ranking.chunkKey);
    const reproducedOrder = query.firstStageRanking.map((ranking) => ranking.chunkKey);
    if (JSON.stringify(acceptedOrder) === JSON.stringify(reproducedOrder)) {
      rankingOrderIdenticalQueryCount += 1;
    } else {
      mismatches.push(`${query.id}: first-stage rank ordering mismatch`);
    }
    for (const ranking of query.firstStageRanking) {
      const acceptedRanking = accepted.rankings.find((item) => item.chunkKey === ranking.chunkKey);
      if (acceptedRanking !== undefined) {
        scoreDeltas.push(Math.abs(ranking.score - acceptedRanking.score));
      }
    }
    if (query.controlExpectedRank !== accepted.firstAcceptableRank) {
      mismatches.push(`${query.id}: control expected rank mismatch`);
    }
  }
  const metrics = computeControlMetrics(reproduced);
  if (metrics.recallAt1 !== CONTROL_RECALL_AT_1) {
    mismatches.push("control Recall@1 mismatch");
  }
  if (metrics.recallAt3 !== CONTROL_RECALL_AT_3) {
    mismatches.push("control Recall@3 mismatch");
  }
  if (metrics.mrr !== CONTROL_MRR) {
    mismatches.push("control MRR mismatch");
  }
  if (metrics.top1CorrectCount !== CONTROL_TOP_1_CORRECT_COUNT) {
    mismatches.push("control Top-1 correct count mismatch");
  }
  return {
    matchesAcceptedControl: mismatches.length === 0,
    mismatchReason: mismatches[0] ?? null,
    rankingOrderIdenticalQueryCount,
    totalQueries: reproduced.length,
    reproducedMetrics: metrics,
    acceptedMetrics: {
      top1CorrectCount: CONTROL_TOP_1_CORRECT_COUNT,
      recallAt1: CONTROL_RECALL_AT_1,
      recallAt3: CONTROL_RECALL_AT_3,
      mrr: CONTROL_MRR,
    },
    acceptedIncorrectTop1Ids: reproduced
      .filter((query) => query.answerable && query.controlTop1Correct === false)
      .map((query) => query.id),
    maxAbsoluteScoreDelta: max(scoreDeltas),
    mismatches,
  };
}

function computeControlMetrics(results: ExperimentQueryResult[]): AnswerableMetrics {
  const answerable = results.filter((result) => result.answerable);
  return {
    count: answerable.length,
    top1CorrectCount: answerable.filter((result) => result.controlExpectedRank === 1).length,
    recallAt1: ratio(
      answerable.filter((result) => result.controlExpectedRank === 1).length,
      answerable.length,
    ),
    recallAt3: ratio(
      answerable.filter((result) => result.controlRecallAt3 === true).length,
      answerable.length,
    ),
    mrr: ratio(
      answerable.reduce((sum, result) => sum + result.controlReciprocalRank, 0),
      answerable.length,
    ),
  };
}

function computeCandidateMetrics(results: ExperimentQueryResult[]): AnswerableMetrics {
  const answerable = results.filter((result) => result.answerable);
  return {
    count: answerable.length,
    top1CorrectCount: answerable.filter((result) => result.candidateExpectedRank === 1).length,
    recallAt1: ratio(
      answerable.filter((result) => result.candidateExpectedRank === 1).length,
      answerable.length,
    ),
    recallAt3: ratio(
      answerable.filter((result) => result.candidateRecallAt3 === true).length,
      answerable.length,
    ),
    mrr: ratio(
      answerable.reduce((sum, result) => sum + result.candidateReciprocalRank, 0),
      answerable.length,
    ),
  };
}

function computeRetrievalInvariants(
  results: ExperimentQueryResult[],
  acceptedControl: AcceptedControlArtifact,
) {
  const acceptedById = new Map(acceptedControl.perQuery.map((query) => [query.id, query]));
  return {
    queryCount: results.length,
    expectedQueryCount: 96,
    answerableCount: results.filter((result) => result.answerable).length,
    unanswerableCount: results.filter((result) => !result.answerable).length,
    datasetOrderPreserved:
      JSON.stringify(results.map((result) => result.id)) ===
      JSON.stringify(acceptedControl.perQuery.map((query) => query.id)),
    allQueryInputsByteIdenticalToControl: results.every(
      (result) => result.queryInputByteIdenticalToControl,
    ),
    allFirstStageRankingsCoverAll12Chunks: results.every(
      (result) => result.firstStageRanking.length === 12,
    ),
    allFirstStageRankingsIdenticalToAcceptedControl: results.every((result) => {
      const accepted = acceptedById.get(result.id);
      return (
        accepted !== undefined &&
        JSON.stringify(accepted.rankings.map((ranking) => ranking.chunkKey)) ===
          JSON.stringify(result.firstStageRanking.map((ranking) => ranking.chunkKey))
      );
    }),
    allCandidateRankingsCoverAll12Chunks: results.every(
      (result) => result.candidateRanking.length === 12,
    ),
    top3MembershipUnchangedForAllQueries: results.every((result) => result.top3MembershipUnchanged),
    noChunkFromOutsideTop3EnteredCandidateTop3: results.every((result) =>
      result.candidateTop3ChunkKeys.every((chunkKey) =>
        result.firstStageTop3ChunkKeys.includes(chunkKey),
      ),
    ),
    ranksBelowTop3Unchanged: results.every((result) =>
      result.candidateRanking
        .slice(RERANK_TOP_K)
        .every(
          (ranking, index) =>
            ranking.chunkKey === result.firstStageRanking[index + RERANK_TOP_K]?.chunkKey,
        ),
    ),
    rerankerScoresPresentOnlyForTop3: results.every(
      (result) =>
        result.candidateRanking.filter((ranking) => ranking.rerankerScore !== null).length ===
        RERANK_TOP_K,
    ),
  };
}

function analyseChanges(results: ExperimentQueryResult[]) {
  const answerable = results.filter((result) => result.answerable);
  const corrections = answerable
    .filter((result) => result.classification === "correction")
    .map(changeSummary);
  const regressions = answerable
    .filter((result) => result.classification === "regression")
    .map(changeSummary);
  const expectedRankChanges = answerable
    .filter((result) => result.controlExpectedRank !== result.candidateExpectedRank)
    .map(changeSummary);
  const top1EvidenceChanges = results
    .filter((result) => result.controlTop1ChunkKey !== result.candidateTop1ChunkKey)
    .map(changeSummary);
  const neutralRankingChanges = results
    .filter((result) => result.neutralRankingChange)
    .map(changeSummary);
  const recallAt3Structural = answerable.every(
    (result) => result.controlRecallAt3 === result.candidateRecallAt3,
  );
  return {
    corrections,
    correctionCount: corrections.length,
    regressions,
    regressionCount: regressions.length,
    netCorrections: corrections.length - regressions.length,
    expectedRankChanges,
    expectedRankChangeCount: expectedRankChanges.length,
    top1EvidenceChanges,
    top1EvidenceChangeCount: top1EvidenceChanges.length,
    neutralRankingChanges,
    neutralRankingChangeCount: neutralRankingChanges.length,
    top3OrderChangedCount: results.filter((result) => result.top3OrderChanged).length,
    previouslyCorrectAnswerableLosingTop1: regressions.map((item) => item.id),
    remainingIncorrectTop1: answerable
      .filter((result) => result.candidateExpectedRank !== 1)
      .map(changeSummary),
    recallAt3UnchangedForEveryAnswerableQuery: recallAt3Structural,
    recallAt3StructuralExplanation:
      "verified from per-query results: candidate Top-3 membership equals control Top-3 membership for every query",
  };
}

function changeSummary(result: ExperimentQueryResult) {
  return {
    id: result.id,
    query: result.query,
    queryType: result.queryType,
    answerable: result.answerable,
    faqIntentId: result.faqIntentId,
    expectedEvidenceId: result.expectedEvidenceId,
    controlExpectedRank: result.controlExpectedRank,
    candidateExpectedRank: result.candidateExpectedRank,
    controlTop1ChunkKey: result.controlTop1ChunkKey,
    candidateTop1ChunkKey: result.candidateTop1ChunkKey,
    controlTop1Correct: result.controlTop1Correct,
    candidateTop1Correct: result.candidateTop1Correct,
    controlTop3: result.firstStageTop3ChunkKeys,
    candidateTop3: result.candidateTop3ChunkKeys,
    classification: result.classification,
  };
}

function analyseTargetQueries(results: ExperimentQueryResult[]) {
  return REPORTED_TARGET_IDS.map((id) => {
    const result = results.find((item) => item.id === id);
    if (result === undefined) {
      throw new Error(`Reported target query ${id} is missing from the results.`);
    }
    const firstStageTop3 = result.firstStageRanking.slice(0, RERANK_TOP_K);
    const candidateTop3 = result.candidateRanking.slice(0, RERANK_TOP_K);
    const rerankerScores = [...result.rerankerScoresForTop3].sort(
      (left, right) => right.rerankerScore - left.rerankerScore,
    );
    const expectedChunkKey =
      result.firstStageRanking.find(
        (ranking) => ranking.acceptableEvidenceIdsWithFullCoverage.length > 0,
      )?.chunkKey ?? null;
    const expectedRerankerScore =
      rerankerScores.find((item) => item.chunkKey === expectedChunkKey)?.rerankerScore ?? null;
    const bestCompetingRerankerScore =
      rerankerScores.find((item) => item.chunkKey !== expectedChunkKey)?.rerankerScore ?? null;
    const controlExpectedScore =
      result.firstStageRanking.find((ranking) => ranking.chunkKey === expectedChunkKey)?.score ??
      null;
    return {
      id: result.id,
      query: result.query,
      queryType: result.queryType,
      faqIntentId: result.faqIntentId,
      expectedEvidenceId: result.expectedEvidenceId,
      expectedChunkKey,
      controlTop3: firstStageTop3.map((ranking) => ({
        rank: ranking.rank,
        chunkKey: ranking.chunkKey,
        firstStagePassageScore: ranking.score,
        isExpected: ranking.chunkKey === expectedChunkKey,
      })),
      candidateTop3: candidateTop3.map((ranking) => ({
        rank: ranking.rank,
        chunkKey: ranking.chunkKey,
        firstStageRank: ranking.firstStageRank,
        rerankerQuestionScore: ranking.rerankerScore,
        isExpected: ranking.chunkKey === expectedChunkKey,
      })),
      competingChunkKeys: firstStageTop3
        .filter((ranking) => ranking.chunkKey !== expectedChunkKey)
        .map((ranking) => ranking.chunkKey),
      controlExpectedRank: result.controlExpectedRank,
      candidateExpectedRank: result.candidateExpectedRank,
      controlTop1ChunkKey: result.controlTop1ChunkKey,
      candidateTop1ChunkKey: result.candidateTop1ChunkKey,
      controlTop1Correct: result.controlTop1Correct,
      candidateTop1Correct: result.candidateTop1Correct,
      firstStageMarginExpectedMinusTop1:
        controlExpectedScore === null || result.controlTopScore === null
          ? null
          : round(controlExpectedScore - result.controlTopScore),
      rerankerMarginExpectedMinusBestCompetitor:
        expectedRerankerScore === null || bestCompetingRerankerScore === null
          ? null
          : round(expectedRerankerScore - bestCompetingRerankerScore),
      outcome:
        result.classification === "correction"
          ? "corrected"
          : result.classification === "regression"
            ? "harmed"
            : result.candidateExpectedRank === 1
              ? "already_correct_and_unchanged"
              : "unresolved",
    };
  });
}

function analyseSameIntentStability(results: ExperimentQueryResult[]) {
  const targetIntentIds = [
    ...new Set(
      REPORTED_TARGET_IDS.map(
        (id) => results.find((result) => result.id === id)?.faqIntentId ?? null,
      ).filter((intentId): intentId is string => intentId !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return targetIntentIds.map((faqIntentId) => {
    const members = results.filter(
      (result) => result.answerable && result.faqIntentId === faqIntentId,
    );
    const otherMembers = members.filter((result) => !REPORTED_TARGET_IDS.includes(result.id));
    return {
      faqIntentId,
      targetIds: members
        .filter((result) => REPORTED_TARGET_IDS.includes(result.id))
        .map((result) => result.id),
      otherAnswerableQueries: otherMembers.map((result) => ({
        id: result.id,
        query: result.query,
        queryType: result.queryType,
        controlExpectedRank: result.controlExpectedRank,
        candidateExpectedRank: result.candidateExpectedRank,
        controlTop1Correct: result.controlTop1Correct,
        candidateTop1Correct: result.candidateTop1Correct,
        controlTop3: result.firstStageTop3ChunkKeys,
        candidateTop3: result.candidateTop3ChunkKeys,
        top3OrderChanged: result.top3OrderChanged,
        rerankerMarginTop1MinusTop2: rerankerMargin(result),
        classification: result.classification,
      })),
      top1RegressionsWithinIntent: otherMembers
        .filter((result) => result.classification === "regression")
        .map((result) => result.id),
      marginDeteriorationWithinIntent: otherMembers
        .filter(
          (result) =>
            result.candidateExpectedRank !== null &&
            result.controlExpectedRank !== null &&
            result.candidateExpectedRank > result.controlExpectedRank,
        )
        .map((result) => result.id),
    };
  });
}

function rerankerMargin(result: ExperimentQueryResult): number | null {
  const sorted = [...result.rerankerScoresForTop3].sort(
    (left, right) => right.rerankerScore - left.rerankerScore,
  );
  const first = sorted[0]?.rerankerScore;
  const second = sorted[1]?.rerankerScore;
  return first === undefined || second === undefined ? null : round(first - second);
}

function evaluateAcceptanceGates(input: {
  candidateMetrics: AnswerableMetrics;
  analysis: ReturnType<typeof analyseChanges>;
  rerankerInvariants: ReturnType<typeof validateRerankerInvariants>;
  retrievalInvariants: ReturnType<typeof computeRetrievalInvariants>;
}) {
  const merklisteCorrected = input.analysis.corrections.filter((item) =>
    REPORTED_MERKLISTE_TARGET_IDS.includes(item.id),
  ).length;
  const checks = {
    recallAt1AboveControl: input.candidateMetrics.recallAt1 > CONTROL_RECALL_AT_1,
    recallAt3RemainsExactlyOne: input.candidateMetrics.recallAt3 === CONTROL_RECALL_AT_3,
    mrrAboveControl: input.candidateMetrics.mrr > CONTROL_MRR,
    atLeastTwoOf067_068_069BecomeTop1Correct: merklisteCorrected >= 2,
    netCorrectionsAtLeastOne: input.analysis.netCorrections >= 1,
    noMoreThanOneAnswerableTop1Regression: input.analysis.regressionCount <= 1,
    fixedRerankerAppliedUniformly:
      input.rerankerInvariants.exactly12RerankerTextsConstructed &&
      input.rerankerInvariants.everyTextHasExactlyOneMarkeLine &&
      input.rerankerInvariants.everyTextHasExactlyOneFrageLine &&
      input.rerankerInvariants.noTextHasAnAntwortLine &&
      input.rerankerInvariants.everyQuestionMatchesAcceptedCanonicalizedQuestion &&
      input.rerankerInvariants.fixedRuleAppliedUniformly,
    firstStageTop3MembershipUnchanged:
      input.retrievalInvariants.top3MembershipUnchangedForAllQueries &&
      input.retrievalInvariants.noChunkFromOutsideTop3EnteredCandidateTop3,
    retrievalAndEmbeddingInvariantsPreserved:
      input.retrievalInvariants.datasetOrderPreserved &&
      input.retrievalInvariants.allQueryInputsByteIdenticalToControl &&
      input.retrievalInvariants.allFirstStageRankingsIdenticalToAcceptedControl &&
      input.retrievalInvariants.allFirstStageRankingsCoverAll12Chunks &&
      input.retrievalInvariants.allCandidateRankingsCoverAll12Chunks &&
      input.retrievalInvariants.ranksBelowTop3Unchanged &&
      input.retrievalInvariants.answerableCount === CONTROL_ANSWERABLE_COUNT &&
      input.retrievalInvariants.unanswerableCount === CONTROL_UNANSWERABLE_COUNT,
    noLabelsSpecialRulesEnrichmentOrLeakage:
      !input.rerankerInvariants.queryOrLabelDataInfluencedConstruction &&
      input.rerankerInvariants.noTextContainsControlAnswerText &&
      JSON.stringify(input.rerankerInvariants.constructionInputs) ===
        JSON.stringify(["originalQuestion"]),
  };
  return {
    checks,
    merklisteTargetsCorrectedCount: merklisteCorrected,
    correctionCount: input.analysis.correctionCount,
    regressionCount: input.analysis.regressionCount,
    netCorrections: input.analysis.netCorrections,
    top1CorrectCount: input.candidateMetrics.top1CorrectCount,
    allGatesPassed: Object.values(checks).every(Boolean),
    thresholdProposed: false,
    productionActivationProposed: false,
    baselinePromotionProposed: false,
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
    firstStageRanking: result.firstStageRanking.map((ranking) => ({
      ...ranking,
      score: round(ranking.score),
    })),
    rerankerScoresForTop3: result.rerankerScoresForTop3.map((candidate) => ({
      ...candidate,
      rerankerScore: round(candidate.rerankerScore),
    })),
    candidateRanking: result.candidateRanking.map((ranking) => ({
      ...ranking,
      score: round(ranking.score),
      rerankerScore: nullableRound(ranking.rerankerScore),
    })),
    controlReciprocalRank: round(result.controlReciprocalRank),
    candidateReciprocalRank: round(result.candidateReciprocalRank),
    controlTopScore: nullableRound(result.controlTopScore),
    candidateTopScore: nullableRound(result.candidateTopScore),
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

function max(values: number[]): number | null {
  return values.length === 0 ? null : round(Math.max(...values));
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

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

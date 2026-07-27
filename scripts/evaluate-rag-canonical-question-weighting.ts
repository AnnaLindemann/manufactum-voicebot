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
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
  queryEmbeddingInputHash: string;
  controlQueryEmbeddingInputHash: string;
  queryInputByteIdenticalToControl: boolean;
  queryEmbeddingTokenCount: number;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  expectedScore: number | null;
  rankings: RankedChunk[];
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
  scoreDistributions: Record<string, ScoreDistribution>;
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

type AcceptedBaselineArtifact = {
  schemaVersion: "rag-development-baseline-retrieval-results-v1";
  frozenInputs: {
    datasetSha256: string;
    manifestSha256: string;
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
    candidate: Metrics;
  };
  perQuery: ControlQueryResult[];
  decision: "experiment_passed" | "experiment_rejected";
};

type PassageInput = {
  chunkKey: string;
  representation: string;
  canonicalizedQuestion: string;
  canonicalizedAnswer: string;
  representationSha256: string;
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
  "docs/evaluation/rag-canonical-question-weighting-experiment-results.json";
const ACCEPTED_CONTROL_SHA256 = "13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d";
const DOCUMENT_KEY = "mein-konto";
const TOP_K_FOR_RECALL = 3;
const TARGET_IDS = [
  "mein-konto-v1-dev-015",
  "mein-konto-v1-dev-067",
  "mein-konto-v1-dev-068",
  "mein-konto-v1-dev-069",
];
const MERKLISTE_WUNSCHLISTE_CHUNKS = ["mein-konto:v1:chunk-008", "mein-konto:v1:chunk-009"];

async function main(): Promise<void> {
  if (process.env.DATABASE_URL?.trim() === undefined || process.env.DATABASE_URL.trim() === "") {
    throw new Error("DATABASE_URL must be set for the canonical question weighting experiment.");
  }

  const outputPath = cliValue("--output") ?? DEFAULT_OUTPUT_PATH;
  const datasetBefore = await readJsonFile<DevelopmentQuery[]>(DATASET_PATH);
  const baselineBefore = await readJsonFile<AcceptedBaselineArtifact>(BASELINE_PATH);
  const mappingBefore = await readJsonFile<EvidenceMappingArtifact>(MAPPING_PATH);
  const controlBefore = await readJsonFile<AcceptedControlArtifact>(CONTROL_PATH);
  validateFrozenInputs(datasetBefore, baselineBefore, mappingBefore, controlBefore);

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
  };
  const cacheDir = process.env.TRANSFORMERS_CACHE?.trim();
  if (cacheDir !== undefined && cacheDir.length > 0) {
    generatorOptions.cacheDir = cacheDir;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const chunks = await readActiveChunks(client);
    validateActiveChunksAgainstBaseline(chunks, baselineBefore.value);

    const controlPassages = await embedPassages(chunks, generator, buildControlRepresentation);
    validateControlRepresentations(controlPassages, controlBefore.value);
    const reproducedControl = (
      await evaluateQueries({
        dataset: datasetBefore.value,
        acceptedControl: controlBefore.value,
        mapping: mappingBefore.value,
        chunks,
        passages: controlPassages,
        generator,
      })
    ).map(roundQueryResult);
    const controlReproduction = compareControlReproduction(controlBefore.value, reproducedControl);
    if (!controlReproduction.matchesAcceptedControl) {
      throw new Error(`control_mismatch: ${controlReproduction.mismatchReason ?? "unknown"}`);
    }

    const candidatePassages = await embedPassages(chunks, generator, buildCandidateRepresentation);
    const candidateInvariants = validateCandidateInvariants(
      chunks,
      controlPassages,
      candidatePassages,
    );
    const perQuery = (
      await evaluateQueries({
        dataset: datasetBefore.value,
        acceptedControl: controlBefore.value,
        mapping: mappingBefore.value,
        chunks,
        passages: candidatePassages,
        generator,
      })
    ).map(roundQueryResult);
    const metrics = computeMetrics(perQuery);
    const comparisons = compareWithControl(controlBefore.value, perQuery);
    const successCriteria = evaluateSuccessCriteria(metrics, comparisons, candidateInvariants);
    const result = {
      schemaVersion: "rag-canonical-question-weighting-experiment-results-v1",
      experiment: {
        id: "canonical-question-weighting",
        gitCommit: gitCommit(),
        evaluationTimestamp: new Date().toISOString(),
        productionBehaviorChanged: false,
        databaseMutationIntended: false,
        activationIntended: false,
        thresholdTuned: false,
      },
      preflight: {
        branch: git(["branch", "--show-current"]),
        head: git(["rev-parse", "HEAD"]),
        originMain: git(["rev-parse", "origin/main"]),
        acceptedCheckpoint: "b26dc56821cd292413234a477ab0bb468de2a510",
        acceptedControlSha256: controlBefore.sha256,
        acceptedControlSha256Matches: controlBefore.sha256 === ACCEPTED_CONTROL_SHA256,
        trackedChangesAbsent: git(["status", "--short", "--untracked-files=no"]) === "",
      },
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
          "number of byte-identical canonicalized source FAQ question occurrences in passage embedding input",
        controlRepresentationRule:
          "Marke: Manufactum\\n\\nFrage: {canonicalizedQuestion}\\n\\nAntwort: {canonicalizedAnswer}",
        candidateRepresentationRule:
          "Marke: Manufactum\\n\\nFrage: {canonicalizedQuestion}\\n\\nFrage: {canonicalizedQuestion}\\n\\nAntwort: {canonicalizedAnswer}",
        queryTextChanged: false,
        queryEmbeddingBehaviorChanged: false,
        rankingScope: "complete 12-chunk candidate set",
        similarityFunction: "cosine_similarity = dot_product over normalized embeddings",
        topKForRecall: TOP_K_FOR_RECALL,
        thresholdApplied: false,
        databaseWrites: false,
      },
      controlReproduction,
      controlPassageInputs: controlPassages.map((passage) => passageSummary(passage)),
      candidatePassageInputs: candidatePassages.map((passage) => ({
        ...passageSummary(passage),
        questionOccurrences: countExactQuestionOccurrences(
          passage.representation,
          passage.canonicalizedQuestion,
        ),
        answerOccurrences: countExactOccurrences(
          passage.representation,
          `Antwort: ${passage.canonicalizedAnswer}`,
        ),
      })),
      candidateInvariants,
      queryInputProof: {
        byteIdenticalToControlCount: perQuery.filter(
          (query) => query.queryInputByteIdenticalToControl,
        ).length,
        total: perQuery.length,
        allByteIdenticalToControl: perQuery.every(
          (query) => query.queryInputByteIdenticalToControl,
        ),
      },
      metrics: {
        control: controlBefore.value.metrics.candidate,
        candidate: metrics,
        deltas: metricDeltas(controlBefore.value.metrics.candidate, metrics),
      },
      comparisons,
      successCriteria,
      decision: successCriteria.experimentPassed ? "experiment_passed" : "experiment_rejected",
      perQuery,
    };

    await client.query("COMMIT");
    await writeJson(outputPath, result);
    console.log(
      JSON.stringify({
        outputPath,
        decision: result.decision,
        control: result.metrics.control.answerable,
        candidate: result.metrics.candidate.answerable,
        successCriteria: result.successCriteria,
      }),
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

export function buildControlRepresentation(input: {
  originalQuestion: string;
  originalAnswer: string;
}): { representation: string; canonicalizedQuestion: string; canonicalizedAnswer: string } {
  const representation = buildAcceptedCanonicalizedRepresentation(input).representation;
  const fields = parseCanonicalRepresentation(representation);
  return { representation, ...fields };
}

export function buildCandidateRepresentation(input: {
  originalQuestion: string;
  originalAnswer: string;
}): { representation: string; canonicalizedQuestion: string; canonicalizedAnswer: string } {
  const control = buildControlRepresentation(input);
  return {
    canonicalizedQuestion: control.canonicalizedQuestion,
    canonicalizedAnswer: control.canonicalizedAnswer,
    representation: `Marke: Manufactum\n\nFrage: ${control.canonicalizedQuestion}\n\nFrage: ${control.canonicalizedQuestion}\n\nAntwort: ${control.canonicalizedAnswer}`,
  };
}

export function countExactQuestionOccurrences(representation: string, question: string): number {
  return countExactOccurrences(representation, `Frage: ${question}`);
}

export function countExactOccurrences(input: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = input.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = input.indexOf(needle, index + needle.length);
  }
  return count;
}

function parseCanonicalRepresentation(representation: string): {
  canonicalizedQuestion: string;
  canonicalizedAnswer: string;
} {
  const match =
    /^Marke: Manufactum\n\nFrage: (?<question>[\s\S]+?)\n\nAntwort: (?<answer>[\s\S]+)$/u.exec(
      representation,
    );
  if (match?.groups === undefined) {
    throw new Error("Accepted canonicalized representation has an unexpected shape.");
  }
  return {
    canonicalizedQuestion: match.groups.question!,
    canonicalizedAnswer: match.groups.answer!,
  };
}

async function evaluateQueries(input: {
  dataset: DevelopmentQuery[];
  acceptedControl: AcceptedControlArtifact;
  mapping: EvidenceMappingArtifact;
  chunks: ActiveChunk[];
  passages: PassageInput[];
  generator: TransformersE5SmallPassageEmbeddingGenerator;
}): Promise<ExperimentQueryResult[]> {
  const controlById = new Map(input.acceptedControl.perQuery.map((query) => [query.id, query]));
  const results: ExperimentQueryResult[] = [];
  for (const record of input.dataset) {
    const control = controlById.get(record.id);
    if (control === undefined) {
      throw new Error(`Accepted control artifact has no result for ${record.id}.`);
    }
    const queryEmbedding = await input.generator.embedQuery(record.query);
    const rankings = rankChunks({
      queryEmbedding: queryEmbedding.embedding,
      chunks: input.chunks,
      passages: input.passages,
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
      faqIntentId: record.faqIntentId,
      expectedEvidenceId: record.expectedEvidenceId,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      queryEmbeddingInputHash: queryEmbedding.inputHash,
      controlQueryEmbeddingInputHash: control.queryEmbeddingInputHash,
      queryInputByteIdenticalToControl:
        queryEmbedding.inputHash === control.queryEmbeddingInputHash,
      queryEmbeddingTokenCount: queryEmbedding.tokenCount,
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

function rankChunks(input: {
  queryEmbedding: number[];
  chunks: ActiveChunk[];
  passages: PassageInput[];
  acceptableEvidenceIds: string[];
  mapping: EvidenceMappingArtifact;
}): RankedChunk[] {
  const passageByChunkKey = new Map(input.passages.map((passage) => [passage.chunkKey, passage]));
  return input.chunks
    .map((chunk) => {
      const passage = passageByChunkKey.get(chunk.chunkKey);
      if (passage === undefined) {
        throw new Error(`Missing passage embedding for ${chunk.chunkKey}.`);
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

async function embedPassages(
  chunks: ActiveChunk[],
  generator: TransformersE5SmallPassageEmbeddingGenerator,
  build: typeof buildControlRepresentation,
): Promise<PassageInput[]> {
  const passages: PassageInput[] = [];
  for (const chunk of chunks) {
    const built = build({ originalQuestion: chunk.question, originalAnswer: chunk.answer });
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

function validateControlRepresentations(
  controlPassages: PassageInput[],
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
    if (countStandaloneManufactum(passage.representation) !== 1) {
      throw new Error(`Control representation brand invariant failed for ${passage.chunkKey}.`);
    }
  }
}

function validateCandidateInvariants(
  chunks: ActiveChunk[],
  controlPassages: PassageInput[],
  candidatePassages: PassageInput[],
) {
  const chunkKeys = chunks.map((chunk) => chunk.chunkKey);
  const controlByChunk = new Map(controlPassages.map((passage) => [passage.chunkKey, passage]));
  const candidateByChunk = new Map(candidatePassages.map((passage) => [passage.chunkKey, passage]));
  const passageProofs = chunkKeys.map((chunkKey) => {
    const control = controlByChunk.get(chunkKey);
    const candidate = candidateByChunk.get(chunkKey);
    if (control === undefined || candidate === undefined) {
      throw new Error(`Missing control or candidate passage for ${chunkKey}.`);
    }
    return {
      chunkKey,
      containsOnlyOwnCanonicalizedQuestion:
        candidate.canonicalizedQuestion === control.canonicalizedQuestion,
      containsOnlyOwnCanonicalizedAnswer:
        candidate.canonicalizedAnswer === control.canonicalizedAnswer,
      manufactumStandaloneOccurrences: countStandaloneManufactum(candidate.representation),
      questionOccurrences: countExactQuestionOccurrences(
        candidate.representation,
        candidate.canonicalizedQuestion,
      ),
      byteIdenticalQuestionOccurrences: candidate.representation.includes(
        `Frage: ${candidate.canonicalizedQuestion}\n\nFrage: ${candidate.canonicalizedQuestion}`,
      ),
      answerOccurrences: countExactOccurrences(
        candidate.representation,
        `Antwort: ${candidate.canonicalizedAnswer}`,
      ),
    };
  });
  return {
    passageCount: candidatePassages.length,
    expectedPassageCount: 12,
    all12PassagesCoveredExactlyOnce:
      candidatePassages.length === 12 &&
      new Set(candidatePassages.map((passage) => passage.chunkKey)).size === 12 &&
      chunkKeys.every((chunkKey) => candidateByChunk.has(chunkKey)),
    everyCandidateHasExactlyOneStandaloneManufactum: passageProofs.every(
      (proof) => proof.manufactumStandaloneOccurrences === 1,
    ),
    everyCandidateHasQuestionExactlyTwice: passageProofs.every(
      (proof) => proof.questionOccurrences === 2,
    ),
    everyCandidateHasTwoByteIdenticalQuestions: passageProofs.every(
      (proof) => proof.byteIdenticalQuestionOccurrences,
    ),
    everyCandidateHasAnswerExactlyOnce: passageProofs.every(
      (proof) => proof.answerOccurrences === 1,
    ),
    noCandidateContainsContentFromAnotherChunk: passageProofs.every(
      (proof) =>
        proof.containsOnlyOwnCanonicalizedQuestion && proof.containsOnlyOwnCanonicalizedAnswer,
    ),
    constructionInputs: ["originalQuestion", "originalAnswer"],
    queryOrLabelDataInfluencedConstruction: false,
    deterministicOrdering:
      JSON.stringify(candidatePassages.map((passage) => passage.chunkKey)) ===
      JSON.stringify(chunkKeys),
    passageProofs,
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
): void {
  if (git(["branch", "--show-current"]) !== "main") {
    throw new Error("Preflight failed: branch is not main.");
  }
  const acceptedCheckpoint = "b26dc56821cd292413234a477ab0bb468de2a510";
  if (git(["rev-parse", "HEAD"]) !== acceptedCheckpoint) {
    throw new Error("Preflight failed: HEAD does not match the accepted checkpoint.");
  }
  if (git(["rev-parse", "origin/main"]) !== acceptedCheckpoint) {
    throw new Error("Preflight failed: origin/main does not match the accepted checkpoint.");
  }
  if (git(["status", "--short", "--untracked-files=no"]) !== "") {
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
  if (!control.value.queryInputProof.allByteIdenticalToBaseline) {
    throw new Error("Accepted control did not preserve baseline query input behavior.");
  }
  if (control.value.metrics.candidate.answerable.recallAt1 !== 0.944444) {
    throw new Error("Accepted control Recall@1 is not the expected value.");
  }
  if (control.value.metrics.candidate.answerable.recallAt3 !== 1) {
    throw new Error("Accepted control Recall@3 is not the expected value.");
  }
  if (control.value.metrics.candidate.answerable.mrr !== 0.969907) {
    throw new Error("Accepted control MRR is not the expected value.");
  }
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
  for (const query of reproduced) {
    const accepted = acceptedById.get(query.id);
    if (accepted === undefined) {
      mismatches.push(`${query.id}: missing accepted control query`);
      continue;
    }
    const acceptedOrder = accepted.rankings.map((ranking) => ranking.chunkKey);
    const reproducedOrder = query.rankings.map((ranking) => ranking.chunkKey);
    if (JSON.stringify(acceptedOrder) !== JSON.stringify(reproducedOrder)) {
      mismatches.push(`${query.id}: rank ordering mismatch`);
    }
    for (const ranking of query.rankings) {
      const acceptedRanking = accepted.rankings.find((item) => item.chunkKey === ranking.chunkKey);
      if (acceptedRanking !== undefined) {
        scoreDeltas.push(Math.abs(ranking.score - acceptedRanking.score));
      }
    }
    if (query.firstAcceptableRank !== accepted.firstAcceptableRank) {
      mismatches.push(`${query.id}: first acceptable rank mismatch`);
    }
  }
  const metrics = computeMetrics(reproduced);
  const metricsMatch =
    JSON.stringify(metrics.answerable) ===
    JSON.stringify(acceptedControl.metrics.candidate.answerable);
  if (!metricsMatch) {
    mismatches.push("control metrics mismatch");
  }
  return {
    matchesAcceptedControl: mismatches.length === 0,
    mismatchReason: mismatches[0] ?? null,
    rankingOrderIdenticalQueryCount:
      reproduced.length - mismatches.filter((item) => item.includes("rank ordering")).length,
    totalQueries: reproduced.length,
    metrics,
    acceptedMetrics: acceptedControl.metrics.candidate,
    maxAbsoluteScoreDelta: max(scoreDeltas),
    mismatches,
  };
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

function compareWithControl(control: AcceptedControlArtifact, candidate: ExperimentQueryResult[]) {
  const controlById = new Map(control.perQuery.map((query) => [query.id, query]));
  const answerableComparisons = candidate
    .filter((query) => query.answerability === "answerable")
    .map((query) => queryComparison(controlById.get(query.id)!, query));
  const answerableRankChanges = answerableComparisons.filter((change) => change.rankChanged);
  const changedTop1Predictions = answerableComparisons.filter((change) => change.top1Changed);
  const newlyCorrectedTop1 = answerableComparisons.filter(
    (change) =>
      change.control.firstAcceptableRank !== 1 && change.candidate.firstAcceptableRank === 1,
  );
  const previouslyCorrectTop1Regressions = answerableComparisons.filter(
    (change) =>
      change.control.firstAcceptableRank === 1 && change.candidate.firstAcceptableRank !== 1,
  );
  const remainingIncorrectTop1 = answerableComparisons.filter(
    (change) => change.candidate.firstAcceptableRank !== 1,
  );
  const targetComparisons = TARGET_IDS.map((id) =>
    queryComparison(
      controlById.get(id)!,
      candidate.find((query) => query.id === id)!,
    ),
  );
  const targetIntentIds = new Set(targetComparisons.map((change) => change.faqIntentId));
  const sameIntentAsTargets = answerableComparisons.filter((change) =>
    targetIntentIds.has(change.faqIntentId),
  );
  const merklisteWunschlistePair = answerableComparisons.filter(
    (change) =>
      MERKLISTE_WUNSCHLISTE_CHUNKS.includes(change.control.top1ChunkKey ?? "") ||
      MERKLISTE_WUNSCHLISTE_CHUNKS.includes(change.candidate.top1ChunkKey ?? "") ||
      change.faqIntentId?.includes("merkliste") === true ||
      change.faqIntentId?.includes("wunschliste") === true,
  );
  return {
    answerableRankChanges,
    changedTop1Predictions,
    newlyCorrectedTop1,
    previouslyCorrectTop1Regressions,
    remainingIncorrectTop1,
    targetFailuresBeforeAfter: targetComparisons,
    sameIntentAsTargetFailures: sameIntentAsTargets,
    merklisteWunschlistePair,
    top1ChunkSelectionCounts: {
      control: top1ChunkCounts(control.perQuery),
      candidate: top1ChunkCounts(candidate),
    },
    scoreGapsForCorrectionsAndRegressions: [
      ...newlyCorrectedTop1,
      ...previouslyCorrectTop1Regressions,
    ].map((change) => ({
      id: change.id,
      controlExpectedMinusWrongTop1:
        change.control.expectedScore === null || change.control.top1Score === null
          ? null
          : round(change.control.expectedScore - change.control.top1Score),
      candidateExpectedMinusWrongTop1:
        change.candidate.expectedScore === null || change.candidate.top1Score === null
          ? null
          : round(change.candidate.expectedScore - change.candidate.top1Score),
    })),
    unanswerableTopScores: candidate
      .filter((query) => query.answerability === "unanswerable")
      .map((query) => ({
        id: query.id,
        queryType: query.queryType,
        controlTopScore: controlById.get(query.id)?.topScore ?? null,
        candidateTopScore: query.topScore,
        delta:
          query.topScore === null || controlById.get(query.id)?.topScore === null
            ? null
            : round(query.topScore - controlById.get(query.id)!.topScore!),
      })),
    scoreScaleShift: {
      allTopScore: scoreShift(
        control.perQuery.map((query) => query.topScore),
        candidate.map((query) => query.topScore),
      ),
      answerableTopScore: scoreShift(
        control.perQuery
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
        control.perQuery
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

function queryComparison(control: ControlQueryResult, candidate: ExperimentQueryResult) {
  const controlExpectedScore =
    control.firstAcceptableRank === null
      ? null
      : (control.rankings.find((ranking) => ranking.rank === control.firstAcceptableRank)?.score ??
        null);
  return {
    id: candidate.id,
    queryType: candidate.queryType,
    faqIntentId: candidate.faqIntentId,
    rankChanged: control.firstAcceptableRank !== candidate.firstAcceptableRank,
    top1Changed: control.rankings[0]?.chunkKey !== candidate.rankings[0]?.chunkKey,
    control: {
      firstAcceptableRank: control.firstAcceptableRank,
      top1ChunkKey: control.rankings[0]?.chunkKey ?? null,
      top1Score: control.topScore,
      expectedScore: controlExpectedScore,
    },
    candidate: {
      firstAcceptableRank: candidate.firstAcceptableRank,
      top1ChunkKey: candidate.rankings[0]?.chunkKey ?? null,
      top1Score: candidate.topScore,
      expectedScore: candidate.expectedScore,
    },
  };
}

function evaluateSuccessCriteria(
  metrics: Metrics,
  comparisons: ReturnType<typeof compareWithControl>,
  candidateInvariants: ReturnType<typeof validateCandidateInvariants>,
) {
  const targetCorrected = comparisons.targetFailuresBeforeAfter.filter(
    (change) =>
      change.control.firstAcceptableRank !== 1 && change.candidate.firstAcceptableRank === 1,
  ).length;
  const corrected = comparisons.newlyCorrectedTop1.length;
  const regressed = comparisons.previouslyCorrectTop1Regressions.length;
  const top1CorrectCount = metrics.answerable.count - comparisons.remainingIncorrectTop1.length;
  const checks = {
    recallAt1AboveControl: metrics.answerable.recallAt1 > 0.944444,
    atLeast69Of72Top1Correct: top1CorrectCount >= 69,
    recallAt3RemainsPerfect: metrics.answerable.recallAt3 === 1,
    mrrAboveControl: metrics.answerable.mrr > 0.969907,
    atLeastTwoTargetFailuresCorrected: targetCorrected >= 2,
    netTop1CorrectionsAtLeastOne: corrected - regressed >= 1,
    noMoreThanOneTop1Regression: regressed <= 1,
    candidateRuleAppliedUniformly:
      candidateInvariants.all12PassagesCoveredExactlyOnce &&
      candidateInvariants.everyCandidateHasExactlyOneStandaloneManufactum &&
      candidateInvariants.everyCandidateHasQuestionExactlyTwice &&
      candidateInvariants.everyCandidateHasTwoByteIdenticalQuestions &&
      candidateInvariants.everyCandidateHasAnswerExactlyOnce,
    noLeakageOrUncontrolledChangeFound:
      !candidateInvariants.queryOrLabelDataInfluencedConstruction &&
      candidateInvariants.noCandidateContainsContentFromAnotherChunk,
  };
  return {
    checks,
    top1CorrectCount,
    targetFailuresCorrectedCount: targetCorrected,
    correctedTop1Count: corrected,
    regressedTop1Count: regressed,
    experimentPassed: Object.values(checks).every(Boolean),
  };
}

function metricDeltas(control: Metrics, candidate: Metrics) {
  return {
    answerable: {
      recallAt1: round(candidate.answerable.recallAt1 - control.answerable.recallAt1),
      recallAt3: round(candidate.answerable.recallAt3 - control.answerable.recallAt3),
      mrr: round(candidate.answerable.mrr - control.answerable.mrr),
    },
  };
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

function scoreShift(control: (number | null)[], candidate: (number | null)[]) {
  const paired = control.flatMap((controlScore, index) => {
    const candidateScore = candidate[index];
    return controlScore === null || candidateScore === undefined || candidateScore === null
      ? []
      : [candidateScore - controlScore];
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

function top1ChunkCounts(queries: { rankings: RankedChunk[] }[]) {
  const counts = new Map<string, number>();
  for (const query of queries) {
    const chunkKey = query.rankings[0]?.chunkKey ?? "none";
    counts.set(chunkKey, (counts.get(chunkKey) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function passageSummary(passage: PassageInput) {
  return {
    chunkKey: passage.chunkKey,
    representation: passage.representation,
    representationSha256: passage.representationSha256,
    embeddingInputHash: passage.embeddingInputHash,
    embeddingTokenCount: passage.tokenCount,
    manufactumStandaloneOccurrences: countStandaloneManufactum(passage.representation),
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

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitCommit(): string {
  return git(["rev-parse", "HEAD"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

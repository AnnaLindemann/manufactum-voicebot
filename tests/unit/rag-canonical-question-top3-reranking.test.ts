import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildControlPassageRepresentation,
  buildRerankerText,
  countLinesStartingWith,
  rerankTop3,
  type ExperimentQueryResult,
  type RerankCandidate,
} from "../../scripts/evaluate-rag-canonical-question-top3-reranking.js";
import { countStandaloneManufactum } from "../../scripts/evaluate-rag-passage-brand-context-canonicalization.js";

type DatasetRecord = {
  id: string;
  query: string;
  answerability: "answerable" | "unanswerable";
};

type AnswerableMetrics = {
  count: number;
  top1CorrectCount: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
};

type ChangeSummary = {
  id: string;
  controlExpectedRank: number | null;
  candidateExpectedRank: number | null;
  classification: "correction" | "regression" | "unchanged";
};

type ExperimentResult = {
  schemaVersion: string;
  experiment: {
    productionBehaviorChanged: boolean;
    databaseMutationIntended: boolean;
    activationIntended: boolean;
    thresholdTuned: boolean;
    thresholdProposed: boolean;
    baselinePromotionIntended: boolean;
  };
  frozenInputs: {
    datasetSha256: string;
    baselineSha256: string;
    mappingSha256: string;
    controlSha256: string;
  };
  controlReproduction: {
    matchesAcceptedControl: boolean;
    rankingOrderIdenticalQueryCount: number;
    totalQueries: number;
    maxAbsoluteScoreDelta: number | null;
    reproducedMetrics: AnswerableMetrics;
    acceptedIncorrectTop1Ids: string[];
  };
  controlPassageInputs: {
    chunkKey: string;
    representation: string;
    representationSha256: string;
    manufactumStandaloneOccurrences: number;
  }[];
  rerankerTextInputs: {
    chunkKey: string;
    text: string;
    textSha256: string;
    markeLineCount: number;
    frageLineCount: number;
    antwortLineCount: number;
  }[];
  rerankerInvariants: {
    exactly12RerankerTextsConstructed: boolean;
    everyTextHasExactlyOneMarkeLine: boolean;
    everyTextHasExactlyOneFrageLine: boolean;
    noTextHasAnAntwortLine: boolean;
    noTextContainsControlAnswerText: boolean;
    everyTextHasExactlyOneStandaloneManufactum: boolean;
    everyQuestionMatchesAcceptedCanonicalizedQuestion: boolean;
    fixedRuleAppliedUniformly: boolean;
    queryOrLabelDataInfluencedConstruction: boolean;
    constructionInputs: string[];
    deterministicOrdering: boolean;
    textProofs: { chunkKey: string; containsControlAnswerText: boolean }[];
  };
  retrievalInvariants: {
    queryCount: number;
    answerableCount: number;
    unanswerableCount: number;
    datasetOrderPreserved: boolean;
    allQueryInputsByteIdenticalToControl: boolean;
    allFirstStageRankingsIdenticalToAcceptedControl: boolean;
    allFirstStageRankingsCoverAll12Chunks: boolean;
    allCandidateRankingsCoverAll12Chunks: boolean;
    top3MembershipUnchangedForAllQueries: boolean;
    noChunkFromOutsideTop3EnteredCandidateTop3: boolean;
    ranksBelowTop3Unchanged: boolean;
    rerankerScoresPresentOnlyForTop3: boolean;
  };
  metrics: {
    control: AnswerableMetrics;
    candidate: AnswerableMetrics;
    acceptedControl: Omit<AnswerableMetrics, "count">;
  };
  analysis: {
    corrections: ChangeSummary[];
    correctionCount: number;
    regressions: ChangeSummary[];
    regressionCount: number;
    netCorrections: number;
    expectedRankChanges: ChangeSummary[];
    top1EvidenceChanges: ChangeSummary[];
    neutralRankingChanges: ChangeSummary[];
    neutralRankingChangeCount: number;
    recallAt3UnchangedForEveryAnswerableQuery: boolean;
  };
  scoreInterpretation: {
    spacesCombined: boolean;
    sharedThresholdComputed: boolean;
    rerankerScoreTreatedAsCalibrated: boolean;
  };
  acceptanceGates: {
    checks: Record<string, boolean>;
    merklisteTargetsCorrectedCount: number;
    allGatesPassed: boolean;
    thresholdProposed: boolean;
    productionActivationProposed: boolean;
    baselinePromotionProposed: boolean;
  };
  decision: string;
  perQuery: ExperimentQueryResult[];
};

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const DATASET_PATH = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.json",
);
const BASELINE_PATH = path.join(
  REPO_ROOT,
  "docs",
  "evaluation",
  "mein-konto-v1-development-v1-active-baseline-retrieval-results.json",
);
const MAPPING_PATH = path.join(
  REPO_ROOT,
  "docs",
  "evaluation",
  "mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json",
);
const CONTROL_PATH = path.join(
  REPO_ROOT,
  "docs",
  "evaluation",
  "rag-passage-brand-context-canonicalization-experiment-results.json",
);
const RESULT_PATH = path.join(
  REPO_ROOT,
  "docs",
  "evaluation",
  "rag-canonical-question-top3-reranking-experiment-results.json",
);
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "evaluate-rag-canonical-question-top3-reranking.ts",
);
const ACCEPTED_CONTROL_SHA256 = "13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d";
const CONTROL_RECALL_AT_1 = 0.944444;
const CONTROL_MRR = 0.969907;
const MERKLISTE_TARGET_IDS = [
  "mein-konto-v1-dev-067",
  "mein-konto-v1-dev-068",
  "mein-konto-v1-dev-069",
];

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function sha256Text(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

describe("canonical FAQ question-only Top-3 reranking experiment", () => {
  it("builds the fixed reranker text from the accepted canonicalized question and no answer text", () => {
    const input = {
      originalQuestion: "Welche Vorteile bietet mir ein Manufactum Konto?",
      originalAnswer: "Im Manufactum Konto können Sie Produkte merken.",
    };

    const control = buildControlPassageRepresentation(input);
    const reranker = buildRerankerText(input);

    expect(control.representation).toBe(
      "Marke: Manufactum\n\nFrage: Welche Vorteile bietet mir ein Konto?\n\nAntwort: Im Konto können Sie Produkte merken.",
    );
    expect(reranker.text).toBe("Marke: Manufactum\n\nFrage: Welche Vorteile bietet mir ein Konto?");
    expect(reranker.canonicalizedQuestion).toBe(control.canonicalizedQuestion);
    expect(reranker.text).not.toContain("Antwort");
    expect(reranker.text).not.toContain(control.canonicalizedAnswer);
    expect(countLinesStartingWith(reranker.text, "Marke: ")).toBe(1);
    expect(countLinesStartingWith(reranker.text, "Frage: ")).toBe(1);
    expect(countLinesStartingWith(reranker.text, "Antwort: ")).toBe(0);
    expect(countStandaloneManufactum(reranker.text)).toBe(1);
  });

  it("reranks deterministically and breaks ties by first-stage rank", () => {
    const distinct: RerankCandidate[] = [
      { chunkKey: "chunk-a", firstStageRank: 1, rerankerScore: 0.5 },
      { chunkKey: "chunk-b", firstStageRank: 2, rerankerScore: 0.9 },
      { chunkKey: "chunk-c", firstStageRank: 3, rerankerScore: 0.7 },
    ];
    const tied: RerankCandidate[] = [
      { chunkKey: "chunk-a", firstStageRank: 3, rerankerScore: 0.8 },
      { chunkKey: "chunk-b", firstStageRank: 1, rerankerScore: 0.8 },
      { chunkKey: "chunk-c", firstStageRank: 2, rerankerScore: 0.8 },
    ];

    expect(rerankTop3(distinct).map((item) => item.chunkKey)).toEqual([
      "chunk-b",
      "chunk-c",
      "chunk-a",
    ]);
    expect(rerankTop3(tied).map((item) => item.chunkKey)).toEqual([
      "chunk-b",
      "chunk-c",
      "chunk-a",
    ]);
    expect(rerankTop3([...tied].reverse()).map((item) => item.chunkKey)).toEqual([
      "chunk-b",
      "chunk-c",
      "chunk-a",
    ]);
    expect(rerankTop3(distinct)).toEqual(rerankTop3([...distinct].reverse()));
    expect(distinct.map((item) => item.chunkKey)).toEqual(["chunk-a", "chunk-b", "chunk-c"]);
    expect(() => rerankTop3(distinct.slice(0, 2))).toThrow(/exactly 3 candidates/u);
  });

  it("has no target-query-specific branch in construction or reranking", async () => {
    const source = await readFile(SCRIPT_PATH, "utf8");
    const reportingOnlyConstants =
      /const REPORTED_TARGET_IDS = \[[\s\S]*?\];\nconst REPORTED_MERKLISTE_TARGET_IDS = \[[\s\S]*?\];/u;

    expect(source).toMatch(reportingOnlyConstants);
    expect(source.replace(reportingOnlyConstants, "")).not.toMatch(/mein-konto-v1-dev-\d/u);
    for (const fn of [buildRerankerText, buildControlPassageRepresentation, rerankTop3]) {
      expect(fn.toString()).not.toMatch(/dev-\d|REPORTED_|faqIntentId|expectedEvidenceId/u);
    }
    expect(rerankTop3.length).toBe(1);
  });

  it("reproduces the accepted control exactly", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(await sha256File(CONTROL_PATH)).toBe(ACCEPTED_CONTROL_SHA256);
    expect(result.controlReproduction).toMatchObject({
      matchesAcceptedControl: true,
      rankingOrderIdenticalQueryCount: 96,
      totalQueries: 96,
      maxAbsoluteScoreDelta: 0,
    });
    expect(result.controlReproduction.reproducedMetrics).toEqual({
      count: 72,
      top1CorrectCount: 68,
      recallAt1: CONTROL_RECALL_AT_1,
      recallAt3: 1,
      mrr: CONTROL_MRR,
    });
    expect(result.controlReproduction.acceptedIncorrectTop1Ids).toEqual([
      "mein-konto-v1-dev-015",
      "mein-konto-v1-dev-067",
      "mein-konto-v1-dev-068",
      "mein-konto-v1-dev-069",
    ]);
    expect(result.metrics.control).toEqual(result.controlReproduction.reproducedMetrics);
  });

  it("proves frozen dataset, baseline, mapping, and control identities", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.frozenInputs.datasetSha256).toBe(await sha256File(DATASET_PATH));
    expect(result.frozenInputs.baselineSha256).toBe(await sha256File(BASELINE_PATH));
    expect(result.frozenInputs.mappingSha256).toBe(await sha256File(MAPPING_PATH));
    expect(result.frozenInputs.controlSha256).toBe(await sha256File(CONTROL_PATH));
    expect(result.experiment).toMatchObject({
      productionBehaviorChanged: false,
      databaseMutationIntended: false,
      activationIntended: false,
      thresholdTuned: false,
      thresholdProposed: false,
      baselinePromotionIntended: false,
    });
  });

  it("applies exactly one fixed question-only reranker text to all 12 chunks", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const controlByChunkKey = new Map(
      result.controlPassageInputs.map((passage) => [passage.chunkKey, passage]),
    );

    expect(result.rerankerTextInputs).toHaveLength(12);
    expect(new Set(result.rerankerTextInputs.map((text) => text.chunkKey)).size).toBe(12);
    for (const text of result.rerankerTextInputs) {
      const control = controlByChunkKey.get(text.chunkKey);
      expect(control).toBeDefined();
      const controlQuestion =
        /^Marke: Manufactum\n\nFrage: (?<question>[\s\S]+?)\n\nAntwort: (?<answer>[\s\S]+)$/u.exec(
          control!.representation,
        )?.groups;
      expect(controlQuestion).toBeDefined();
      expect(text.text).toBe(`Marke: Manufactum\n\nFrage: ${controlQuestion!.question!}`);
      expect(text.text).not.toContain(controlQuestion!.answer!);
      expect(text.text).not.toContain("Antwort");
      expect(sha256Text(text.text)).toBe(text.textSha256);
      expect(text.markeLineCount).toBe(1);
      expect(text.frageLineCount).toBe(1);
      expect(text.antwortLineCount).toBe(0);
      expect(countStandaloneManufactum(text.text)).toBe(1);
    }
    expect(result.rerankerInvariants).toMatchObject({
      exactly12RerankerTextsConstructed: true,
      everyTextHasExactlyOneMarkeLine: true,
      everyTextHasExactlyOneFrageLine: true,
      noTextHasAnAntwortLine: true,
      noTextContainsControlAnswerText: true,
      everyTextHasExactlyOneStandaloneManufactum: true,
      everyQuestionMatchesAcceptedCanonicalizedQuestion: true,
      fixedRuleAppliedUniformly: true,
      queryOrLabelDataInfluencedConstruction: false,
      deterministicOrdering: true,
    });
    expect(result.rerankerInvariants.constructionInputs).toEqual(["originalQuestion"]);
    expect(
      result.rerankerInvariants.textProofs.every((proof) => !proof.containsControlAnswerText),
    ).toBe(true);
  });

  it("keeps query inputs and the frozen dataset unchanged", async () => {
    const dataset = await loadJson<DatasetRecord[]>(DATASET_PATH);
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.perQuery.map((query) => query.id)).toEqual(dataset.map((query) => query.id));
    expect(result.perQuery.map((query) => query.query)).toEqual(
      dataset.map((query) => query.query),
    );
    expect(result.perQuery.every((query) => query.queryInputByteIdenticalToControl)).toBe(true);
    expect(result.retrievalInvariants).toMatchObject({
      queryCount: 96,
      answerableCount: 72,
      unanswerableCount: 24,
      datasetOrderPreserved: true,
      allQueryInputsByteIdenticalToControl: true,
    });
  });

  it("leaves the first-stage ranking and Top-3 membership untouched", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    for (const query of result.perQuery) {
      expect(query.firstStageRanking).toHaveLength(12);
      expect(query.candidateRanking).toHaveLength(12);
      expect(query.firstStageRanking.map((ranking) => ranking.rank)).toEqual(
        Array.from({ length: 12 }, (_value, index) => index + 1),
      );
      expect(query.candidateRanking.map((ranking) => ranking.rank)).toEqual(
        Array.from({ length: 12 }, (_value, index) => index + 1),
      );
      expect([...query.candidateTop3ChunkKeys].sort()).toEqual(
        [...query.firstStageTop3ChunkKeys].sort(),
      );
      expect(query.candidateRanking.slice(3).map((ranking) => ranking.chunkKey)).toEqual(
        query.firstStageRanking.slice(3).map((ranking) => ranking.chunkKey),
      );
      expect(
        query.candidateRanking.filter((ranking) => ranking.rerankerScore !== null),
      ).toHaveLength(3);
      expect(query.rerankerScoresForTop3.map((item) => item.chunkKey)).toEqual(
        query.firstStageTop3ChunkKeys,
      );
      const reordered = rerankTop3(query.rerankerScoresForTop3);
      expect(query.candidateTop3ChunkKeys).toEqual(reordered.map((item) => item.chunkKey));
    }
    expect(result.retrievalInvariants).toMatchObject({
      allFirstStageRankingsIdenticalToAcceptedControl: true,
      allFirstStageRankingsCoverAll12Chunks: true,
      allCandidateRankingsCoverAll12Chunks: true,
      top3MembershipUnchangedForAllQueries: true,
      noChunkFromOutsideTop3EnteredCandidateTop3: true,
      ranksBelowTop3Unchanged: true,
      rerankerScoresPresentOnlyForTop3: true,
    });
  });

  it("keeps the two score spaces separate", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.scoreInterpretation).toMatchObject({
      spacesCombined: false,
      sharedThresholdComputed: false,
      rerankerScoreTreatedAsCalibrated: false,
    });
    for (const query of result.perQuery) {
      for (const ranking of query.candidateRanking) {
        const firstStage = query.firstStageRanking.find(
          (item) => item.chunkKey === ranking.chunkKey,
        );
        expect(ranking.score).toBe(firstStage?.score);
        const rerankerScore = query.rerankerScoresForTop3.find(
          (item) => item.chunkKey === ranking.chunkKey,
        );
        expect(ranking.rerankerScore).toBe(rerankerScore?.rerankerScore ?? null);
      }
    }
  });

  it("recomputes candidate metrics independently from the per-query records", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const answerable = result.perQuery.filter((query) => query.answerable);

    expect(answerable).toHaveLength(72);
    expect(result.metrics.candidate).toEqual({
      count: answerable.length,
      top1CorrectCount: answerable.filter((query) => query.candidateExpectedRank === 1).length,
      recallAt1: ratio(
        answerable.filter((query) => query.candidateExpectedRank === 1).length,
        answerable.length,
      ),
      recallAt3: ratio(
        answerable.filter(
          (query) => query.candidateExpectedRank !== null && query.candidateExpectedRank <= 3,
        ).length,
        answerable.length,
      ),
      mrr: ratio(
        answerable.reduce(
          (sum, query) =>
            sum + (query.candidateExpectedRank === null ? 0 : 1 / query.candidateExpectedRank),
          0,
        ),
        answerable.length,
      ),
    });
    expect(result.metrics.candidate.mrr).toBe(
      ratio(
        answerable.reduce((sum, query) => sum + query.candidateReciprocalRank, 0),
        answerable.length,
      ),
    );
    expect(result.analysis.recallAt3UnchangedForEveryAnswerableQuery).toBe(true);
    expect(result.metrics.candidate.recallAt3).toBe(result.metrics.control.recallAt3);
  });

  it("recomputes corrections, regressions, and neutral changes independently", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const answerable = result.perQuery.filter((query) => query.answerable);
    const corrections = answerable.filter(
      (query) => query.controlExpectedRank !== 1 && query.candidateExpectedRank === 1,
    );
    const regressions = answerable.filter(
      (query) => query.controlExpectedRank === 1 && query.candidateExpectedRank !== 1,
    );

    expect(result.analysis.corrections.map((item) => item.id)).toEqual(
      corrections.map((query) => query.id),
    );
    expect(result.analysis.regressions.map((item) => item.id)).toEqual(
      regressions.map((query) => query.id),
    );
    expect(result.analysis.netCorrections).toBe(corrections.length - regressions.length);
    expect(result.analysis.expectedRankChanges.map((item) => item.id)).toEqual(
      answerable
        .filter((query) => query.controlExpectedRank !== query.candidateExpectedRank)
        .map((query) => query.id),
    );
    expect(result.analysis.top1EvidenceChanges.map((item) => item.id)).toEqual(
      result.perQuery
        .filter((query) => query.controlTop1ChunkKey !== query.candidateTop1ChunkKey)
        .map((query) => query.id),
    );
    expect(result.analysis.neutralRankingChanges.map((item) => item.id)).toEqual(
      result.perQuery
        .filter(
          (query) =>
            JSON.stringify(query.firstStageTop3ChunkKeys) !==
              JSON.stringify(query.candidateTop3ChunkKeys) && query.classification === "unchanged",
        )
        .map((query) => query.id),
    );
  });

  it("applies the predetermined acceptance gates and records the decision", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const merklisteCorrected = result.analysis.corrections.filter((item) =>
      MERKLISTE_TARGET_IDS.includes(item.id),
    ).length;
    const expectedChecks = {
      recallAt1AboveControl: result.metrics.candidate.recallAt1 > CONTROL_RECALL_AT_1,
      recallAt3RemainsExactlyOne: result.metrics.candidate.recallAt3 === 1,
      mrrAboveControl: result.metrics.candidate.mrr > CONTROL_MRR,
      atLeastTwoOf067_068_069BecomeTop1Correct: merklisteCorrected >= 2,
      netCorrectionsAtLeastOne: result.analysis.netCorrections >= 1,
      noMoreThanOneAnswerableTop1Regression: result.analysis.regressionCount <= 1,
    };

    expect(result.acceptanceGates.merklisteTargetsCorrectedCount).toBe(merklisteCorrected);
    expect(result.acceptanceGates.checks).toMatchObject(expectedChecks);
    expect(result.acceptanceGates.allGatesPassed).toBe(
      Object.values(result.acceptanceGates.checks).every(Boolean),
    );
    expect(result.acceptanceGates).toMatchObject({
      thresholdProposed: false,
      productionActivationProposed: false,
      baselinePromotionProposed: false,
    });
    expect(result.decision).toBe(
      result.acceptanceGates.allGatesPassed
        ? "experiment_candidate_accepted_for_independent_audit"
        : "experiment_rejected",
    );
  });
});

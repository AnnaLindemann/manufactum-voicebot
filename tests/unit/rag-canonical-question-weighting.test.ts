import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCandidateRepresentation,
  buildControlRepresentation,
  countExactQuestionOccurrences,
  type ExperimentQueryResult,
} from "../../scripts/evaluate-rag-canonical-question-weighting.js";
import { countStandaloneManufactum } from "../../scripts/evaluate-rag-passage-brand-context-canonicalization.js";

type DatasetRecord = {
  id: string;
  query: string;
};

type Metrics = {
  answerable: {
    count: number;
    recallAt1: number;
    recallAt3: number;
    mrr: number;
  };
};

type QueryComparison = {
  id: string;
  rankChanged: boolean;
  top1Changed: boolean;
  control: {
    firstAcceptableRank: number | null;
  };
  candidate: {
    firstAcceptableRank: number | null;
  };
};

type ExperimentResult = {
  schemaVersion: string;
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
  };
  controlPassageInputs: {
    chunkKey: string;
    representation: string;
    representationSha256: string;
    manufactumStandaloneOccurrences: number;
  }[];
  candidatePassageInputs: {
    chunkKey: string;
    representation: string;
    representationSha256: string;
    manufactumStandaloneOccurrences: number;
    questionOccurrences: number;
    answerOccurrences: number;
  }[];
  candidateInvariants: {
    all12PassagesCoveredExactlyOnce: boolean;
    everyCandidateHasExactlyOneStandaloneManufactum: boolean;
    everyCandidateHasQuestionExactlyTwice: boolean;
    everyCandidateHasTwoByteIdenticalQuestions: boolean;
    everyCandidateHasAnswerExactlyOnce: boolean;
    noCandidateContainsContentFromAnotherChunk: boolean;
    queryOrLabelDataInfluencedConstruction: boolean;
    deterministicOrdering: boolean;
  };
  queryInputProof: {
    allByteIdenticalToControl: boolean;
    byteIdenticalToControlCount: number;
    total: number;
  };
  metrics: {
    candidate: Metrics;
  };
  comparisons: {
    answerableRankChanges: QueryComparison[];
    changedTop1Predictions: QueryComparison[];
    newlyCorrectedTop1: QueryComparison[];
    previouslyCorrectTop1Regressions: QueryComparison[];
  };
  perQuery: ExperimentQueryResult[];
};

const DATASET_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.json",
);
const BASELINE_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "mein-konto-v1-development-v1-active-baseline-retrieval-results.json",
);
const MAPPING_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json",
);
const CONTROL_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "rag-passage-brand-context-canonicalization-experiment-results.json",
);
const RESULT_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "rag-canonical-question-weighting-experiment-results.json",
);
const ACCEPTED_CONTROL_SHA256 = "13a7cef2b823edaf2303ff0e2f090c8525df8723fcc15b6255dda7b67750211d";

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

describe("canonical source FAQ question weighting experiment", () => {
  it("constructs the exact accepted control and candidate representations", () => {
    const input = {
      originalQuestion: "Welche Vorteile bietet mir ein Manufactum Konto?",
      originalAnswer: "Im Manufactum Konto können Sie Produkte merken.",
    };

    const control = buildControlRepresentation(input);
    const candidate = buildCandidateRepresentation(input);

    expect(control.representation).toBe(
      "Marke: Manufactum\n\nFrage: Welche Vorteile bietet mir ein Konto?\n\nAntwort: Im Konto können Sie Produkte merken.",
    );
    expect(candidate.representation).toBe(
      "Marke: Manufactum\n\nFrage: Welche Vorteile bietet mir ein Konto?\n\nFrage: Welche Vorteile bietet mir ein Konto?\n\nAntwort: Im Konto können Sie Produkte merken.",
    );
    expect(countStandaloneManufactum(candidate.representation)).toBe(1);
    expect(
      countExactQuestionOccurrences(candidate.representation, candidate.canonicalizedQuestion),
    ).toBe(2);
  });

  it("proves control representation hashes match the accepted artifact", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const acceptedControl = await loadJson<{
      candidatePassageInputs: {
        chunkKey: string;
        candidateRepresentationSha256: string;
      }[];
    }>(CONTROL_PATH);
    const acceptedByChunk = new Map(
      acceptedControl.candidatePassageInputs.map((passage) => [passage.chunkKey, passage]),
    );

    expect(await sha256File(CONTROL_PATH)).toBe(ACCEPTED_CONTROL_SHA256);
    expect(result.controlPassageInputs).toHaveLength(12);
    for (const passage of result.controlPassageInputs) {
      expect(passage.representationSha256).toBe(
        acceptedByChunk.get(passage.chunkKey)?.candidateRepresentationSha256,
      );
      expect(sha256Text(passage.representation)).toBe(passage.representationSha256);
      expect(passage.manufactumStandaloneOccurrences).toBe(1);
    }
  });

  it("proves exact candidate representation invariants", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.candidatePassageInputs).toHaveLength(12);
    for (const passage of result.candidatePassageInputs) {
      expect(sha256Text(passage.representation)).toBe(passage.representationSha256);
      expect(passage.manufactumStandaloneOccurrences).toBe(1);
      expect(passage.questionOccurrences).toBe(2);
      expect(passage.answerOccurrences).toBe(1);
      expect(passage.representation).toMatch(
        /^Marke: Manufactum\n\nFrage: (?<question>[\s\S]+?)\n\nFrage: \k<question>\n\nAntwort: [\s\S]+$/u,
      );
    }
    expect(result.candidateInvariants).toMatchObject({
      all12PassagesCoveredExactlyOnce: true,
      everyCandidateHasExactlyOneStandaloneManufactum: true,
      everyCandidateHasQuestionExactlyTwice: true,
      everyCandidateHasTwoByteIdenticalQuestions: true,
      everyCandidateHasAnswerExactlyOnce: true,
      noCandidateContainsContentFromAnotherChunk: true,
      queryOrLabelDataInfluencedConstruction: false,
      deterministicOrdering: true,
    });
  });

  it("proves frozen dataset, accepted mapping, and accepted control identities", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.frozenInputs.datasetSha256).toBe(await sha256File(DATASET_PATH));
    expect(result.frozenInputs.baselineSha256).toBe(await sha256File(BASELINE_PATH));
    expect(result.frozenInputs.mappingSha256).toBe(await sha256File(MAPPING_PATH));
    expect(result.frozenInputs.controlSha256).toBe(await sha256File(CONTROL_PATH));
  });

  it("proves query inputs are byte-identical to control behavior", async () => {
    const dataset = await loadJson<DatasetRecord[]>(DATASET_PATH);
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.queryInputProof).toEqual({
      allByteIdenticalToControl: true,
      byteIdenticalToControlCount: 96,
      total: 96,
    });
    expect(result.perQuery.map((query) => query.id)).toEqual(dataset.map((query) => query.id));
    expect(result.perQuery.every((query) => query.queryInputByteIdenticalToControl)).toBe(true);
  });

  it("proves deterministic ordering and complete 12-chunk ranking coverage", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.perQuery.map((query) => query.id)).toEqual(
      Array.from(
        { length: 96 },
        (_value, index) => `mein-konto-v1-dev-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(result.perQuery.every((query) => query.rankings.length === 12)).toBe(true);
    expect(
      result.perQuery.every((query) =>
        query.rankings.every((ranking, index) => ranking.rank === index + 1),
      ),
    ).toBe(true);
    expect(result.controlReproduction).toMatchObject({
      matchesAcceptedControl: true,
      rankingOrderIdenticalQueryCount: 96,
      totalQueries: 96,
      maxAbsoluteScoreDelta: 0,
    });
  });

  it("mechanically recomputes metrics and changed-rank lists", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const answerable = result.perQuery.filter((query) => query.answerability === "answerable");
    const changedRanks = answerable.filter(
      (query) =>
        result.comparisons.answerableRankChanges.find((change) => change.id === query.id) !==
        undefined,
    );

    expect(result.metrics.candidate.answerable).toEqual({
      count: answerable.length,
      recallAt1: ratio(
        answerable.filter((query) => query.recallAt1 === true).length,
        answerable.length,
      ),
      recallAt3: ratio(
        answerable.filter((query) => query.recallAt3 === true).length,
        answerable.length,
      ),
      mrr: ratio(
        answerable.reduce((sum, query) => sum + query.reciprocalRank, 0),
        answerable.length,
      ),
    });
    expect(result.comparisons.answerableRankChanges.every((change) => change.rankChanged)).toBe(
      true,
    );
    expect(result.comparisons.changedTop1Predictions.every((change) => change.top1Changed)).toBe(
      true,
    );
    expect(changedRanks).toHaveLength(result.comparisons.answerableRankChanges.length);
    expect(
      result.comparisons.newlyCorrectedTop1.every(
        (change) =>
          change.control.firstAcceptableRank !== 1 && change.candidate.firstAcceptableRank === 1,
      ),
    ).toBe(true);
    expect(
      result.comparisons.previouslyCorrectTop1Regressions.every(
        (change) =>
          change.control.firstAcceptableRank === 1 && change.candidate.firstAcceptableRank !== 1,
      ),
    ).toBe(true);
  });
});

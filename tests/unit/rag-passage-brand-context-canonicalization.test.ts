import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCandidatePassageRepresentation,
  buildControlPassageRepresentation,
  countStandaloneManufactum,
  type ExperimentQueryResult,
} from "../../scripts/evaluate-rag-passage-brand-context-canonicalization.js";

type DatasetRecord = {
  id: string;
  dataset: "development";
};

type Metrics = {
  answerable: {
    count: number;
    recallAt1: number;
    recallAt3: number;
    mrr: number;
  };
};

type ExperimentResult = {
  schemaVersion: string;
  frozenInputs: {
    datasetSha256: string;
    baselineSha256: string;
    mappingSha256: string;
  };
  candidatePassageInputs: {
    manufactumStandaloneOccurrences: number;
  }[];
  queryInputProof: {
    allByteIdenticalToBaseline: boolean;
    byteIdenticalToBaselineCount: number;
    total: number;
  };
  metrics: {
    candidate: Metrics;
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
const RESULT_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "rag-passage-brand-context-canonicalization-experiment-results.json",
);

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

describe("passage brand-context canonicalization experiment", () => {
  it("constructs the exact control and candidate passage representations", () => {
    const input = {
      originalQuestion: "Wie kann ich mich bei Manufactum registrieren?",
      originalAnswer: "Im Manufactum Kundenkonto geht das. manufacturing bleibt erhalten.",
    };

    expect(buildControlPassageRepresentation(input)).toBe(
      "Frage: Wie kann ich mich bei Manufactum registrieren?\n\nAntwort: Im Manufactum Kundenkonto geht das. manufacturing bleibt erhalten.",
    );
    const candidate = buildCandidatePassageRepresentation(input);

    expect(candidate.representation).toBe(
      "Marke: Manufactum\n\nFrage: Wie kann ich mich bei registrieren?\n\nAntwort: Im Kundenkonto geht das. manufacturing bleibt erhalten.",
    );
    expect(candidate.removedStandaloneManufactumOccurrences).toBe(2);
    expect(countStandaloneManufactum(candidate.representation)).toBe(1);
  });

  it("treats only standalone case-insensitive Manufactum as removable", () => {
    const candidate = buildCandidatePassageRepresentation({
      originalQuestion: "manufactum, MANUFACTUM und Manufactum-Konto",
      originalAnswer: "PreManufactum und Manufactumwelt sind keine standalone Treffer.",
    });

    expect(candidate.representation).toBe(
      "Marke: Manufactum\n\nFrage: , und -Konto\n\nAntwort: PreManufactum und Manufactumwelt sind keine standalone Treffer.",
    );
    expect(candidate.removedStandaloneManufactumOccurrences).toBe(3);
    expect(countStandaloneManufactum(candidate.representation)).toBe(1);
  });

  it("records exactly one standalone Manufactum occurrence in every candidate passage input", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.schemaVersion).toBe(
      "rag-passage-brand-context-canonicalization-experiment-results-v1",
    );
    expect(result.candidatePassageInputs).toHaveLength(12);
    expect(
      result.candidatePassageInputs.every((input) => input.manufactumStandaloneOccurrences === 1),
    ).toBe(true);
  });

  it("proves frozen inputs and accepted mapping stayed unchanged", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.frozenInputs.datasetSha256).toBe(await sha256File(DATASET_PATH));
    expect(result.frozenInputs.baselineSha256).toBe(await sha256File(BASELINE_PATH));
    expect(result.frozenInputs.mappingSha256).toBe(await sha256File(MAPPING_PATH));
  });

  it("proves query inputs are byte-identical to baseline behavior", async () => {
    const result = await loadJson<ExperimentResult>(RESULT_PATH);

    expect(result.queryInputProof).toEqual({
      allByteIdenticalToBaseline: true,
      byteIdenticalToBaselineCount: 96,
      total: 96,
    });
    expect(result.perQuery.every((query) => query.queryInputByteIdenticalToBaseline)).toBe(true);
  });

  it("mechanically recomputes candidate metrics and deterministic 96-query ordering", async () => {
    const dataset = await loadJson<DatasetRecord[]>(DATASET_PATH);
    const result = await loadJson<ExperimentResult>(RESULT_PATH);
    const answerable = result.perQuery.filter((query) => query.answerability === "answerable");

    expect(result.perQuery.map((query) => query.id)).toEqual(dataset.map((query) => query.id));
    expect(result.perQuery.map((query) => query.id)).toEqual(
      Array.from(
        { length: 96 },
        (_value, index) => `mein-konto-v1-dev-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(result.perQuery.every((query) => query.rankings.length === 12)).toBe(true);
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
  });
});

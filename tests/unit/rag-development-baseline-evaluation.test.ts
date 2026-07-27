import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

type QueryType =
  | "exact"
  | "paraphrased"
  | "short"
  | "conversational"
  | "ambiguous_answerable"
  | "hard_negative"
  | "irrelevant";

type Answerability = "answerable" | "unanswerable";

type DatasetRecord = {
  id: string;
  dataset: "development" | "held_out_validation";
};

type Inventory = {
  intents: {
    faqIntentId: string;
    evidenceId: string;
  }[];
};

type Manifest = {
  datasetJsonSha256: string;
  semanticEvidenceInventory: {
    sha256: string;
  };
};

type BaselineResult = {
  schemaVersion: string;
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
    id: string;
    chunkCount: number;
    orderedChunks: {
      chunkIndex: number;
      chunkKey: string;
      chunkHash: string;
    }[];
  };
  retrievalConfiguration: {
    thresholdIndependentMetrics: boolean;
    productionThresholdEvaluated: number | null;
  };
  mappingArtifact: {
    path: string;
    sha256: string;
  };
  metrics: Metrics;
  perQuery: QueryResult[];
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

type QueryResult = {
  id: string;
  queryType: QueryType;
  answerability: Answerability;
  faqIntentId: string | null;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  rankings: {
    rank: number;
    chunkKey: string;
    score: number;
    acceptableEvidenceIdsWithFullCoverage: string[];
  }[];
};

type MappingArtifact = {
  schemaVersion: string;
  mappingDerivation: {
    usesRetrievalScores: boolean;
    usesChunkCountAssumption: boolean;
  };
  activeChunkSet: {
    id: string;
  };
  chunkMappings: {
    chunkKey: string;
    chunkIndex: number;
    chunkHash: string;
    evidenceCoverage: {
      evidenceId: string;
      faqIntentId: string;
      coverageStatus: "full" | "partial" | "none";
    }[];
  }[];
  evidenceMappings: {
    evidenceId: string;
    faqIntentId: string;
    fullCoverageChunkKeys: string[];
  }[];
};

const DATASET_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.json",
);
const MANIFEST_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.manifest.json",
);
const INVENTORY_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-semantic-evidence-inventory.draft.json",
);
const RESULT_PATH = path.join(
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
const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "evaluate-rag-development-baseline.ts",
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

function scoreDistribution(results: QueryResult[]): ScoreDistribution {
  const topScores = results.map((result) => result.topScore).filter((score) => score !== null);
  const margins = results.map((result) => result.topScoreMargin).filter((score) => score !== null);
  return {
    count: results.length,
    minTopScore: min(topScores),
    p50TopScore: percentile(topScores, 0.5),
    p90TopScore: percentile(topScores, 0.9),
    maxTopScore: max(topScores),
    meanTopScore: mean(topScores),
    minTopScoreMargin: min(margins),
    p50TopScoreMargin: percentile(margins, 0.5),
    meanTopScoreMargin: mean(margins),
  };
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

function groupMetrics(results: QueryResult[], keyFor: (result: QueryResult) => string) {
  const groups = new Map<string, QueryResult[]>();
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

describe("mein-konto v1 development active-baseline retrieval artifacts", () => {
  it("records the frozen dataset, manifest, and semantic-evidence identities", async () => {
    const manifest = await loadJson<Manifest>(MANIFEST_PATH);
    const result = await loadJson<BaselineResult>(RESULT_PATH);

    expect(result.schemaVersion).toBe("rag-development-baseline-retrieval-results-v1");
    expect(result.frozenInputs.datasetSha256).toBe(await sha256File(DATASET_PATH));
    expect(result.frozenInputs.datasetSha256).toBe(manifest.datasetJsonSha256);
    expect(result.frozenInputs.manifestSha256).toBe(await sha256File(MANIFEST_PATH));
    expect(result.frozenInputs.evidenceInventorySha256).toBe(await sha256File(INVENTORY_PATH));
    expect(result.frozenInputs.evidenceInventorySha256).toBe(
      manifest.semanticEvidenceInventory.sha256,
    );
    expect(result.activeDocument).toMatchObject({
      documentKey: "mein-konto",
      currentVersion: 1,
      contentHash: "ad0d265794468bcb0f7a4732973dbacc29a8512df40370c21a4e801bc93a3eba",
    });
    expect(result.mappingArtifact.sha256).toBe(await sha256File(MAPPING_PATH));
  });

  it("covers all 96 development query IDs and no held-out records", async () => {
    const dataset = await loadJson<DatasetRecord[]>(DATASET_PATH);
    const result = await loadJson<BaselineResult>(RESULT_PATH);

    expect(dataset).toHaveLength(96);
    expect(dataset.every((record) => record.dataset === "development")).toBe(true);
    expect(result.perQuery.map((record) => record.id)).toEqual(dataset.map((record) => record.id));
    expect(result.perQuery.filter((record) => record.answerability === "answerable")).toHaveLength(
      72,
    );
    expect(
      result.perQuery.filter((record) => record.answerability === "unanswerable"),
    ).toHaveLength(24);
  });

  it("validates semantic evidence to active-baseline chunk mappings without score-derived labels", async () => {
    const inventory = await loadJson<Inventory>(INVENTORY_PATH);
    const result = await loadJson<BaselineResult>(RESULT_PATH);
    const mapping = await loadJson<MappingArtifact>(MAPPING_PATH);
    const evidenceIds = new Set(inventory.intents.map((intent) => intent.evidenceId));
    const chunkKeys = new Set(result.activeChunkSet.orderedChunks.map((chunk) => chunk.chunkKey));

    expect(mapping.schemaVersion).toBe("rag-baseline-evidence-chunk-mapping-v1");
    expect(mapping.activeChunkSet.id).toBe(result.activeChunkSet.id);
    expect(mapping.mappingDerivation.usesRetrievalScores).toBe(false);
    expect(mapping.mappingDerivation.usesChunkCountAssumption).toBe(false);
    expect(mapping.chunkMappings).toHaveLength(result.activeChunkSet.chunkCount);
    expect(mapping.evidenceMappings).toHaveLength(inventory.intents.length);

    for (const evidenceMapping of mapping.evidenceMappings) {
      expect(evidenceIds.has(evidenceMapping.evidenceId)).toBe(true);
      expect(evidenceMapping.fullCoverageChunkKeys.length).toBeGreaterThan(0);
      for (const chunkKey of evidenceMapping.fullCoverageChunkKeys) {
        expect(chunkKeys.has(chunkKey)).toBe(true);
        const chunkMapping = mapping.chunkMappings.find((chunk) => chunk.chunkKey === chunkKey);
        expect(
          chunkMapping?.evidenceCoverage.some(
            (coverage) =>
              coverage.evidenceId === evidenceMapping.evidenceId &&
              coverage.coverageStatus === "full",
          ),
        ).toBe(true);
      }
    }

    const mappingText = JSON.stringify(mapping);
    expect(mappingText).not.toMatch(/"score"|"rank"|"queryEmbeddingInputHash"/);
  });

  it("recomputes reported metrics mechanically from per-query results", async () => {
    const result = await loadJson<BaselineResult>(RESULT_PATH);
    const answerable = result.perQuery.filter((record) => record.answerability === "answerable");
    const recomputed: Metrics = {
      answerable: {
        count: answerable.length,
        recallAt1: ratio(
          answerable.filter((record) => record.recallAt1 === true).length,
          answerable.length,
        ),
        recallAt3: ratio(
          answerable.filter((record) => record.recallAt3 === true).length,
          answerable.length,
        ),
        mrr: ratio(
          answerable.reduce((sum, record) => sum + record.reciprocalRank, 0),
          answerable.length,
        ),
      },
      byQueryType: groupMetrics(result.perQuery, (record) => record.queryType),
      byFaqIntentId: groupMetrics(answerable, (record) => record.faqIntentId ?? "null"),
      firstAcceptableRanks: Object.fromEntries(
        answerable.map((record) => [record.id, record.firstAcceptableRank]),
      ),
      scoreDistributions: {
        answerable: scoreDistribution(answerable),
        hard_negative: scoreDistribution(
          result.perQuery.filter((record) => record.queryType === "hard_negative"),
        ),
        irrelevant: scoreDistribution(
          result.perQuery.filter((record) => record.queryType === "irrelevant"),
        ),
      },
    };

    expect(result.metrics).toEqual(recomputed);
  });

  it("keeps result ordering deterministic", async () => {
    const result = await loadJson<BaselineResult>(RESULT_PATH);

    expect(result.activeChunkSet.orderedChunks.map((chunk) => chunk.chunkIndex)).toEqual(
      [...result.activeChunkSet.orderedChunks]
        .map((chunk) => chunk.chunkIndex)
        .sort((left, right) => left - right),
    );
    for (const [queryIndex, query] of result.perQuery.entries()) {
      expect(query.id).toBe(`mein-konto-v1-dev-${String(queryIndex + 1).padStart(3, "0")}`);
      expect(query.rankings).toHaveLength(result.activeChunkSet.chunkCount);
      expect(query.rankings.map((ranking) => ranking.rank)).toEqual(
        Array.from({ length: result.activeChunkSet.chunkCount }, (_, index) => index + 1),
      );
      for (let index = 1; index < query.rankings.length; index += 1) {
        const previous = query.rankings[index - 1]!;
        const current = query.rankings[index]!;
        expect(previous.score).toBeGreaterThanOrEqual(current.score);
      }
    }
  });

  it("keeps the evaluator read-only and independent from historical, held-out, production, and Dialfire paths", async () => {
    const source = await readFile(SCRIPT_PATH, "utf8");
    const result = await loadJson<BaselineResult>(RESULT_PATH);

    expect(source).not.toContain("tests/fixtures/rag/retrieval-evaluation-dataset.json");
    expect(source).not.toMatch(/held_out|held-out/i);
    expect(source).not.toMatch(/dialfire/i);
    expect(source).not.toMatch(/\.\.\/src\/(?:app|server|modules)\//);
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/);
    expect(source).toContain("BEGIN READ ONLY");
    expect(result.retrievalConfiguration.thresholdIndependentMetrics).toBe(true);
    expect(result.retrievalConfiguration.productionThresholdEvaluated).toBeNull();
  });
});

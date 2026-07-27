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
  datasetVersion: string;
  language: "de";
  query: string;
  queryType: QueryType;
  answerability: Answerability;
  faqCategory: string | null;
  faqIntentId: string | null;
  nearestFaqCategory: string | null;
  nearestFaqIntentId: string | null;
  nearestConfusableEvidence: string | null;
  containsManufactumToken: boolean;
  sourceUrl: string | null;
  documentKey: string | null;
  documentVersion: number | null;
  sourceContentHash: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
  supportingSourceSpanSelector: string | null;
  supportingSourceSpanHash: string | null;
  semanticEvidenceRationale: string | null;
  provenanceQuoteHash: string | null;
  unanswerableScopeHash: string | null;
  labelRationale: string;
  labeler: string;
  reviewer: string;
  reviewMethod: string;
  reviewStatus: "approved" | "rejected" | "needs_revision";
  createdAt: string;
  approvedAt: string | null;
};

type InventoryIntent = {
  faqCategory: string;
  faqIntentId: string;
  evidenceId: string;
  documentKey: string;
  documentVersion: number;
  sourceUrl: string;
  sourceSpanSelector: {
    selectorType: string;
    ariaControls: string;
  };
  normalizedSemanticEvidence: {
    question: string;
  };
  supportingSourceSpanHash: string;
};

type Inventory = {
  scope: {
    faqCategory: string;
    documentKey: string;
    documentVersion: number;
    sourceUrl: string;
    sourceDocumentContentHash: string;
  };
  intents: InventoryIntent[];
};

type DatasetManifest = {
  schemaVersion: "rag-evaluation-dataset-manifest-v1";
  datasetVersion: string;
  freezeStatus: "frozen";
  dataset: "development" | "held_out_validation";
  language: "de";
  datasetPath: string;
  datasetJsonSha256: string;
  semanticEvidenceInventory: {
    path: string;
    sha256: string;
    faqIntentCount: number;
  };
  leakageCheck: {
    reviewedRecordCount: number;
    correctedBlockerIds: string[];
    historical52QueryDatasetUsed: boolean;
    heldOutDataUsed: boolean;
    modelOutputInspectionUsed: boolean;
  };
  brandTokenComputation: {
    observedCounts: {
      total: number;
      answerable: number;
      unanswerable: number;
    };
  };
  counts: {
    queryType: Record<QueryType, number>;
    answerability: Record<Answerability, number>;
    category: Record<string, number>;
    perIntentDistribution: Record<string, Record<string, number>>;
  };
  review: {
    reviewer: string;
    reviewMethod: string;
    reviewStatus: "approved";
    approvedAt: string;
  };
};

const DATASET_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.json",
);
const INVENTORY_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-semantic-evidence-inventory.draft.json",
);
const MANIFEST_PATH = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "rag",
  "mein-konto-v1-development-evaluation-dataset.manifest.json",
);

const EXPECTED_QUERY_TYPE_COUNTS: Record<QueryType, number> = {
  exact: 12,
  paraphrased: 24,
  short: 12,
  conversational: 12,
  ambiguous_answerable: 12,
  hard_negative: 18,
  irrelevant: 6,
};

const ANSWERABLE_QUERY_TYPES = new Set<QueryType>([
  "exact",
  "paraphrased",
  "short",
  "conversational",
  "ambiguous_answerable",
]);
const UNANSWERABLE_QUERY_TYPES = new Set<QueryType>(["hard_negative", "irrelevant"]);
const DATASET_RECORD_KEYS = [
  "acceptableEvidenceIds",
  "answerability",
  "approvedAt",
  "containsManufactumToken",
  "createdAt",
  "dataset",
  "datasetVersion",
  "documentKey",
  "documentVersion",
  "expectedEvidenceId",
  "faqCategory",
  "faqIntentId",
  "id",
  "labelRationale",
  "labeler",
  "language",
  "nearestConfusableEvidence",
  "nearestFaqCategory",
  "nearestFaqIntentId",
  "provenanceQuoteHash",
  "query",
  "queryType",
  "reviewMethod",
  "reviewStatus",
  "reviewer",
  "semanticEvidenceRationale",
  "sourceContentHash",
  "sourceUrl",
  "supportingSourceSpanHash",
  "supportingSourceSpanSelector",
  "unanswerableScopeHash",
] as const;
const FORBIDDEN_FIELD_PATTERNS = [
  /chunk/i,
  /candidate/i,
  /retrieval/i,
  /^rank$/i,
  /score/i,
  /threshold/i,
];

async function loadDataset(): Promise<DatasetRecord[]> {
  return JSON.parse(await readFile(DATASET_PATH, "utf8")) as DatasetRecord[];
}

async function loadInventory(): Promise<Inventory> {
  return JSON.parse(await readFile(INVENTORY_PATH, "utf8")) as Inventory;
}

async function loadManifest(): Promise<DatasetManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as DatasetManifest;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function expectNoForbiddenFields(value: unknown, pathSegments: string[] = []): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      expectNoForbiddenFields(item, [...pathSegments, String(index)]);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(`Forbidden field ${[...pathSegments, key].join(".")}`);
    }
    expectNoForbiddenFields(nested, [...pathSegments, key]);
  }
}

function hasManufactumToken(query: string): boolean {
  return /(^|[^A-Za-zÄÖÜäöüß])Manufactum([^A-Za-zÄÖÜäöüß]|$)/u.test(query);
}

function countByQueryType(records: DatasetRecord[]): Record<QueryType, number> {
  const counts = Object.fromEntries(
    Object.keys(EXPECTED_QUERY_TYPE_COUNTS).map((queryType) => [queryType, 0]),
  ) as Record<QueryType, number>;
  for (const record of records) {
    counts[record.queryType] += 1;
  }
  return counts;
}

describe("mein-konto v1 frozen development evaluation dataset", () => {
  it("has the required deterministic development size, query-type counts, and unique IDs/texts", async () => {
    const dataset = await loadDataset();

    expect(dataset).toHaveLength(96);
    expect(countByQueryType(dataset)).toEqual(EXPECTED_QUERY_TYPE_COUNTS);
    expect(new Set(dataset.map((record) => record.id)).size).toBe(dataset.length);
    expect(new Set(dataset.map((record) => record.query)).size).toBe(dataset.length);
    expect(dataset.map((record) => record.id)).toEqual(
      dataset.map((_, index) => `mein-konto-v1-dev-${String(index + 1).padStart(3, "0")}`),
    );
    expect(dataset.every((record) => record.dataset === "development")).toBe(true);
    expect(dataset.some((record) => record.dataset === "held_out_validation")).toBe(false);
  });

  it("uses valid answerability combinations and does not include held-out records", async () => {
    const dataset = await loadDataset();

    for (const record of dataset) {
      expect(Object.keys(record).sort()).toEqual([...DATASET_RECORD_KEYS].sort());
      expect(record.language).toBe("de");
      expect(record.dataset).toBe("development");
      expect(record.datasetVersion).toBe("mein-konto-v1-development-v1");
      expect(record.query.trim()).toBe(record.query);
      expect(record.containsManufactumToken).toBe(hasManufactumToken(record.query));
      expect(record.reviewStatus).toBe("approved");
      expect(record.reviewer).toBe("codex-independent-audit-2026-07-27");
      expect(record.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

      if (ANSWERABLE_QUERY_TYPES.has(record.queryType)) {
        expect(record.answerability).toBe("answerable");
        expect(record.faqCategory).toBe("account-faq");
        expect(record.faqIntentId).not.toBeNull();
        expect(record.expectedEvidenceId).not.toBeNull();
        expect(record.acceptableEvidenceIds).not.toEqual([]);
        expect(record.unanswerableScopeHash).toBeNull();
      }

      if (UNANSWERABLE_QUERY_TYPES.has(record.queryType)) {
        expect(record.answerability).toBe("unanswerable");
        expect(record.faqIntentId).toBeNull();
        expect(record.expectedEvidenceId).toBeNull();
        expect(record.acceptableEvidenceIds).toEqual([]);
        expect(record.sourceUrl).toBeNull();
        expect(record.documentKey).toBeNull();
        expect(record.documentVersion).toBeNull();
        expect(record.sourceContentHash).toBeNull();
        expect(record.supportingSourceSpanSelector).toBeNull();
        expect(record.supportingSourceSpanHash).toBeNull();
        expect(record.semanticEvidenceRationale).toBeNull();
        expect(record.provenanceQuoteHash).toBeNull();
        expect(record.unanswerableScopeHash).toMatch(/^[a-f0-9]{64}$/);
      }

      if (record.queryType === "hard_negative") {
        expect(record.faqCategory).toBe(record.nearestFaqCategory);
        expect(record.nearestFaqIntentId).not.toBeNull();
        expect(record.nearestConfusableEvidence).not.toBeNull();
      }

      if (record.queryType === "irrelevant") {
        expect(record.faqCategory).toBeNull();
        expect(record.nearestFaqCategory).toBeNull();
        expect(record.nearestFaqIntentId).toBeNull();
        expect(record.nearestConfusableEvidence).toBeNull();
      }
    }
  });

  it("resolves every answerable evidence reference to the accepted semantic evidence inventory", async () => {
    const dataset = await loadDataset();
    const inventory = await loadInventory();
    const evidenceById = new Map(inventory.intents.map((intent) => [intent.evidenceId, intent]));
    const intentsById = new Map(inventory.intents.map((intent) => [intent.faqIntentId, intent]));
    const answerableByIntent = new Map<string, DatasetRecord[]>();

    for (const record of dataset.filter((item) => item.answerability === "answerable")) {
      const intent = intentsById.get(record.faqIntentId ?? "");
      const evidence = evidenceById.get(record.expectedEvidenceId ?? "");

      expect(intent).toBeDefined();
      expect(evidence).toBeDefined();
      expect(evidence?.faqIntentId).toBe(record.faqIntentId);
      expect(record.acceptableEvidenceIds).toEqual([record.expectedEvidenceId]);
      expect(record.sourceUrl).toBe(inventory.scope.sourceUrl);
      expect(record.documentKey).toBe(inventory.scope.documentKey);
      expect(record.documentVersion).toBe(inventory.scope.documentVersion);
      expect(record.sourceContentHash).toBe(inventory.scope.sourceDocumentContentHash);
      expect(record.supportingSourceSpanHash).toBe(evidence?.supportingSourceSpanHash);
      expect(record.provenanceQuoteHash).toBe(evidence?.supportingSourceSpanHash);
      expect(record.supportingSourceSpanSelector).toBe(
        `${evidence?.sourceSpanSelector.selectorType}#${evidence?.sourceSpanSelector.ariaControls}`,
      );

      if (record.queryType === "exact") {
        expect(record.query).toBe(intent?.normalizedSemanticEvidence.question);
      }

      const current = answerableByIntent.get(record.faqIntentId ?? "") ?? [];
      current.push(record);
      answerableByIntent.set(record.faqIntentId ?? "", current);
    }

    expect(answerableByIntent.size).toBe(inventory.intents.length);
    for (const intent of inventory.intents) {
      const records = answerableByIntent.get(intent.faqIntentId) ?? [];
      expect(records).toHaveLength(6);
      expect(records.filter((record) => record.queryType === "exact")).toHaveLength(1);
      expect(records.filter((record) => record.queryType === "paraphrased")).toHaveLength(2);
      expect(records.filter((record) => record.queryType === "short")).toHaveLength(1);
      expect(records.filter((record) => record.queryType === "conversational")).toHaveLength(1);
      expect(records.filter((record) => record.queryType === "ambiguous_answerable")).toHaveLength(
        1,
      );
    }
  });

  it("keeps hard-negative and irrelevant records free of supporting evidence claims", async () => {
    const dataset = await loadDataset();
    const inventory = await loadInventory();
    const evidenceById = new Map(inventory.intents.map((intent) => [intent.evidenceId, intent]));

    for (const record of dataset.filter((item) => item.answerability === "unanswerable")) {
      expect(record.expectedEvidenceId).toBeNull();
      expect(record.acceptableEvidenceIds).toEqual([]);
      expect(record.supportingSourceSpanHash).toBeNull();
      expect(record.provenanceQuoteHash).toBeNull();

      if (record.queryType === "hard_negative") {
        const nearestEvidence = evidenceById.get(record.nearestConfusableEvidence ?? "");
        expect(nearestEvidence).toBeDefined();
        expect(nearestEvidence?.faqIntentId).toBe(record.nearestFaqIntentId);
      }
    }
  });

  it("recursively rejects chunk, candidate, retrieval, rank, score, and threshold fields", async () => {
    const dataset = await loadDataset();

    expect(() => expectNoForbiddenFields(dataset)).not.toThrow();
    expect(() =>
      expectNoForbiddenFields([
        {
          ...dataset[0],
          nested: {
            candidate: {
              retrievalScore: 0.9,
            },
          },
        },
      ]),
    ).toThrow(/Forbidden field/);
  });

  it("matches the immediate development Manufactum brand-token distribution", async () => {
    const dataset = await loadDataset();

    expect(dataset.filter((record) => record.containsManufactumToken)).toHaveLength(24);
    expect(
      dataset.filter(
        (record) => record.answerability === "answerable" && record.containsManufactumToken,
      ),
    ).toHaveLength(18);
    expect(
      dataset.filter(
        (record) => record.answerability === "unanswerable" && record.containsManufactumToken,
      ),
    ).toHaveLength(6);
  });

  it("has a frozen manifest that matches the final dataset and evidence inventory", async () => {
    const dataset = await loadDataset();
    const inventory = await loadInventory();
    const manifest = await loadManifest();

    expect(manifest.schemaVersion).toBe("rag-evaluation-dataset-manifest-v1");
    expect(manifest.freezeStatus).toBe("frozen");
    expect(manifest.dataset).toBe("development");
    expect(manifest.language).toBe("de");
    expect(manifest.datasetVersion).toBe("mein-konto-v1-development-v1");
    expect(manifest.datasetPath).toBe(
      "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json",
    );
    expect(manifest.datasetJsonSha256).toBe(await sha256File(DATASET_PATH));
    expect(manifest.semanticEvidenceInventory.path).toBe(
      "tests/fixtures/rag/mein-konto-v1-semantic-evidence-inventory.draft.json",
    );
    expect(manifest.semanticEvidenceInventory.sha256).toBe(await sha256File(INVENTORY_PATH));
    expect(manifest.semanticEvidenceInventory.faqIntentCount).toBe(inventory.intents.length);
    expect(manifest.counts.queryType).toEqual(EXPECTED_QUERY_TYPE_COUNTS);
    expect(manifest.counts.answerability).toEqual({ answerable: 72, unanswerable: 24 });
    expect(manifest.counts.category).toEqual({ "account-faq": 90, null: 6 });
    expect(manifest.brandTokenComputation.observedCounts).toMatchObject({
      total: 24,
      answerable: 18,
      unanswerable: 6,
    });
    expect(manifest.leakageCheck.reviewedRecordCount).toBe(dataset.length);
    expect(manifest.leakageCheck.correctedBlockerIds).toEqual([
      "mein-konto-v1-dev-023",
      "mein-konto-v1-dev-053",
      "mein-konto-v1-dev-066",
    ]);
    expect(manifest.leakageCheck.historical52QueryDatasetUsed).toBe(false);
    expect(manifest.leakageCheck.heldOutDataUsed).toBe(false);
    expect(manifest.leakageCheck.modelOutputInspectionUsed).toBe(false);
    expect(manifest.review).toMatchObject({
      reviewer: "codex-independent-audit-2026-07-27",
      reviewMethod: "separate-agent review",
      reviewStatus: "approved",
    });

    for (const intent of inventory.intents) {
      expect(manifest.counts.perIntentDistribution[intent.faqIntentId]).toEqual({
        totalAnswerable: 6,
        exact: 1,
        paraphrased: 2,
        short: 1,
        conversational: 1,
        ambiguous_answerable: 1,
      });
    }
  });
});

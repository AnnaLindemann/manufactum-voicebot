import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from "prettier";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";

type QueryType =
  | "exact"
  | "paraphrased"
  | "short"
  | "conversational"
  | "ambiguous_answerable"
  | "hard_negative"
  | "irrelevant";

type Answerability = "answerable" | "unanswerable";
type CoverageStatus = "full" | "partial" | "none";

type DevelopmentQuery = {
  id: string;
  dataset: "development";
  datasetVersion: string;
  language: "de";
  query: string;
  queryType: QueryType;
  answerability: Answerability;
  faqCategory: string | null;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
};

type DatasetManifest = {
  datasetVersion: string;
  datasetPath: string;
  datasetJsonSha256: string;
  semanticEvidenceInventory: {
    path: string;
    sha256: string;
  };
};

type EvidenceIntent = {
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
    answer: string;
  };
  supportingSourceSpanHash: string;
  semanticEvidenceHash: string;
};

type EvidenceInventory = {
  schemaVersion: string;
  scope: {
    faqCategory: string;
    documentKey: string;
    documentVersion: number;
    sourceUrl: string;
    sourceDocumentContentHash: string;
  };
  intents: EvidenceIntent[];
};

type ActiveDocument = {
  documentKey: string;
  currentVersion: number;
  sourceUrl: string;
  title: string;
  documentType: string;
  language: string;
  contentHash: string;
};

type ActiveChunk = {
  documentKey: string;
  documentVersion: number;
  chunkIndex: number;
  chunkKey: string;
  question: string;
  answer: string;
  content: string;
  contentHash: string;
  sourceUrl: string;
  title: string;
  documentType: string;
  language: string;
};

type StoredEmbedding = {
  documentKey: string;
  documentVersion: number;
  chunkIndex: number;
  inputHash: string;
  chunkContentHash: string;
  createdAt: string;
};

type EvidenceCoverage = {
  evidenceId: string;
  faqIntentId: string;
  supportingSourceSpanHash: string;
  semanticEvidenceHash: string;
  coverageStatus: CoverageStatus;
  derivation: string;
};

type ChunkMapping = {
  chunkKey: string;
  chunkIndex: number;
  chunkHash: string;
  documentKey: string;
  documentVersion: number;
  sourceUrl: string;
  questionHash: string;
  answerHash: string;
  evidenceCoverage: EvidenceCoverage[];
};

type EvidenceMapping = {
  evidenceId: string;
  faqIntentId: string;
  fullCoverageChunkKeys: string[];
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

type QueryResult = {
  id: string;
  queryType: QueryType;
  answerability: Answerability;
  faqIntentId: string | null;
  expectedEvidenceId: string | null;
  acceptableEvidenceIds: string[];
  queryEmbeddingInputHash: string;
  queryEmbeddingTokenCount: number;
  firstAcceptableRank: number | null;
  recallAt1: boolean | null;
  recallAt3: boolean | null;
  reciprocalRank: number;
  topScore: number | null;
  topScoreMargin: number | null;
  rankings: RankedChunk[];
};

const DATASET_PATH = "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.json";
const MANIFEST_PATH =
  "tests/fixtures/rag/mein-konto-v1-development-evaluation-dataset.manifest.json";
const DEFAULT_RESULT_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-retrieval-results.json";
const DEFAULT_MAPPING_PATH =
  "docs/evaluation/mein-konto-v1-development-v1-active-baseline-evidence-chunk-mapping.json";
const DOCUMENT_KEY = "mein-konto";
const TOP_K_FOR_RECALL = 3;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set for the development baseline evaluation.");
  }

  const resultPath = cliValue("--output") ?? DEFAULT_RESULT_PATH;
  const mappingPath = cliValue("--mapping-output") ?? DEFAULT_MAPPING_PATH;

  const datasetFile = await readJsonFile<DevelopmentQuery[]>(DATASET_PATH);
  const manifestFile = await readJsonFile<DatasetManifest>(MANIFEST_PATH);
  const inventoryPath = manifestFile.value.semanticEvidenceInventory.path;
  const inventoryFile = await readJsonFile<EvidenceInventory>(inventoryPath);
  validateFrozenInputs(datasetFile, manifestFile, inventoryFile);

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
    const activeDocument = await readActiveDocument(client, DOCUMENT_KEY);
    const activeChunks = await readActiveChunks(client, DOCUMENT_KEY);
    const storedEmbeddings = await readStoredEmbeddings(
      client,
      activeDocument.documentKey,
      activeDocument.currentVersion,
    );
    validateActiveBaseline(activeDocument, activeChunks, storedEmbeddings, inventoryFile.value);

    const mapping = buildMapping({
      gitCommit: gitCommit(),
      datasetSha256: datasetFile.sha256,
      manifestSha256: manifestFile.sha256,
      inventorySha256: inventoryFile.sha256,
      inventory: inventoryFile.value,
      activeDocument,
      activeChunks,
      storedEmbeddings,
    });
    const perQuery = (
      await evaluateQueries(client, datasetFile.value, mapping.evidenceMappings, generator)
    ).map(roundQueryResult);
    const metrics = computeMetrics(perQuery);
    const mappingContent = await jsonFileContent(mappingPath, mapping);
    const result = buildResultArtifact({
      gitCommit: gitCommit(),
      datasetSha256: datasetFile.sha256,
      manifestSha256: manifestFile.sha256,
      inventorySha256: inventoryFile.sha256,
      manifest: manifestFile.value,
      inventory: inventoryFile.value,
      activeDocument,
      activeChunks,
      storedEmbeddings,
      mappingPath,
      mappingSha256: sha256Hex(mappingContent),
      perQuery,
      metrics,
    });

    await client.query("COMMIT");
    await writeFile(mappingPath, mappingContent);
    await writeJson(resultPath, result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  const datasetAfter = await sha256File(DATASET_PATH);
  if (datasetAfter !== datasetFile.sha256) {
    throw new Error("Development dataset changed during baseline evaluation.");
  }
  const manifestAfter = await sha256File(MANIFEST_PATH);
  if (manifestAfter !== manifestFile.sha256) {
    throw new Error("Development dataset manifest changed during baseline evaluation.");
  }
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

function validateFrozenInputs(
  datasetFile: { value: DevelopmentQuery[]; sha256: string },
  manifestFile: { value: DatasetManifest; sha256: string },
  inventoryFile: { value: EvidenceInventory; sha256: string },
): void {
  if (datasetFile.sha256 !== manifestFile.value.datasetJsonSha256) {
    throw new Error("Development dataset SHA-256 does not match the frozen manifest.");
  }
  if (inventoryFile.sha256 !== manifestFile.value.semanticEvidenceInventory.sha256) {
    throw new Error("Evidence inventory SHA-256 does not match the frozen manifest.");
  }
  if (manifestFile.value.datasetPath !== DATASET_PATH) {
    throw new Error("Unexpected development dataset path in manifest.");
  }
  if (manifestFile.value.datasetVersion !== "mein-konto-v1-development-v1") {
    throw new Error("Unexpected development dataset version.");
  }
  if (datasetFile.value.length !== 96) {
    throw new Error(`Expected 96 development queries, found ${String(datasetFile.value.length)}.`);
  }
  const ids = datasetFile.value.map((record) => record.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Development dataset query IDs are not unique.");
  }
  if (datasetFile.value.some((record) => record.dataset !== "development")) {
    throw new Error("Development baseline must contain only development records.");
  }
  const answerable = datasetFile.value.filter((record) => record.answerability === "answerable");
  if (answerable.length !== 72) {
    throw new Error(`Expected 72 answerable queries, found ${String(answerable.length)}.`);
  }
  if (datasetFile.value.length - answerable.length !== 24) {
    throw new Error("Expected 24 unanswerable development queries.");
  }
  const evidenceIds = new Set(inventoryFile.value.intents.map((intent) => intent.evidenceId));
  for (const record of answerable) {
    if (record.expectedEvidenceId === null || !evidenceIds.has(record.expectedEvidenceId)) {
      throw new Error(`Answerable query ${record.id} has unknown expected evidence.`);
    }
    for (const evidenceId of record.acceptableEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`Answerable query ${record.id} has unknown acceptable evidence.`);
      }
    }
  }
}

async function readActiveDocument(
  client: pg.PoolClient,
  documentKey: string,
): Promise<ActiveDocument> {
  const result = await client.query<{
    document_key: string;
    current_version: number;
    source_url: string;
    title: string;
    document_type: string;
    language: string;
    content_hash: string;
  }>(
    `SELECT d.document_key, d.current_version, v.source_url, v.title, v.document_type,
            v.language, v.content_hash
       FROM rag_documents d
       JOIN rag_document_versions v
         ON v.document_key = d.document_key AND v.version = d.current_version
      WHERE d.document_key = $1`,
    [documentKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No active RAG document found for ${documentKey}.`);
  }
  return {
    documentKey: row.document_key,
    currentVersion: row.current_version,
    sourceUrl: row.source_url,
    title: row.title,
    documentType: row.document_type,
    language: row.language,
    contentHash: row.content_hash,
  };
}

async function readActiveChunks(
  client: pg.PoolClient,
  documentKey: string,
): Promise<ActiveChunk[]> {
  const result = await client.query<{
    document_key: string;
    document_version: number;
    chunk_index: number;
    chunk_key: string;
    question: string;
    answer: string;
    content: string;
    content_hash: string;
    source_url: string;
    title: string;
    document_type: string;
    language: string;
  }>(
    `SELECT c.document_key, c.document_version, c.chunk_index, c.chunk_key, c.question,
            c.answer, c.content, c.content_hash, c.source_url, c.title, c.document_type, c.language
       FROM rag_chunks c
       JOIN rag_documents d ON d.document_key = c.document_key
      WHERE c.document_key = $1 AND c.document_version = d.current_version
      ORDER BY c.chunk_index ASC`,
    [documentKey],
  );
  return result.rows.map((row) => ({
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkIndex: row.chunk_index,
    chunkKey: row.chunk_key,
    question: row.question,
    answer: row.answer,
    content: row.content,
    contentHash: row.content_hash,
    sourceUrl: row.source_url,
    title: row.title,
    documentType: row.document_type,
    language: row.language,
  }));
}

async function readStoredEmbeddings(
  client: pg.PoolClient,
  documentKey: string,
  documentVersion: number,
): Promise<StoredEmbedding[]> {
  const model = embeddingProfileModelRef();
  const result = await client.query<{
    document_key: string;
    document_version: number;
    chunk_index: number;
    input_hash: string;
    chunk_content_hash: string;
    created_at: Date;
  }>(
    `SELECT document_key, document_version, chunk_index, input_hash, chunk_content_hash, created_at
       FROM rag_chunk_embeddings
      WHERE document_key = $1
        AND document_version = $2
        AND embedding_provider = $3
        AND embedding_model = $4
        AND embedding_model_version = $5
        AND embedding_artifact = $6
        AND embedding_dtype = $7
        AND embedding_runtime = $8
        AND embedding_profile_id = $9
      ORDER BY chunk_index ASC`,
    [
      documentKey,
      documentVersion,
      model.embeddingProvider,
      model.embeddingModel,
      model.embeddingModelVersion,
      model.embeddingArtifact,
      model.embeddingDtype,
      model.embeddingRuntime,
      model.embeddingProfileId,
    ],
  );
  return result.rows.map((row) => ({
    documentKey: row.document_key,
    documentVersion: row.document_version,
    chunkIndex: row.chunk_index,
    inputHash: row.input_hash,
    chunkContentHash: row.chunk_content_hash,
    createdAt: row.created_at.toISOString(),
  }));
}

function validateActiveBaseline(
  activeDocument: ActiveDocument,
  chunks: ActiveChunk[],
  embeddings: StoredEmbedding[],
  inventory: EvidenceInventory,
): void {
  if (activeDocument.documentKey !== inventory.scope.documentKey) {
    throw new Error("Active document key does not match the evidence inventory.");
  }
  if (activeDocument.currentVersion !== inventory.scope.documentVersion) {
    throw new Error("Active document version does not match the evidence inventory.");
  }
  if (activeDocument.contentHash !== inventory.scope.sourceDocumentContentHash) {
    throw new Error("Active document content hash does not match the evidence inventory.");
  }
  if (chunks.length !== 12) {
    throw new Error(`Expected 12 active baseline chunks, found ${String(chunks.length)}.`);
  }
  if (embeddings.length !== chunks.length) {
    throw new Error("Every active chunk must have one stored embedding for the active profile.");
  }
  for (const chunk of chunks) {
    const embedding = embeddings.find((item) => item.chunkIndex === chunk.chunkIndex);
    if (embedding === undefined) {
      throw new Error(`Missing active-profile embedding for ${chunk.chunkKey}.`);
    }
    if (embedding.chunkContentHash !== chunk.contentHash) {
      throw new Error(`Embedding chunk content hash mismatch for ${chunk.chunkKey}.`);
    }
  }
}

function buildMapping(input: {
  gitCommit: string;
  datasetSha256: string;
  manifestSha256: string;
  inventorySha256: string;
  inventory: EvidenceInventory;
  activeDocument: ActiveDocument;
  activeChunks: ActiveChunk[];
  storedEmbeddings: StoredEmbedding[];
}) {
  const chunkMappings: ChunkMapping[] = input.activeChunks.map((chunk) => {
    const evidenceCoverage = input.inventory.intents.map((intent) => {
      const questionMatches =
        comparable(chunk.question) === comparable(intent.normalizedSemanticEvidence.question);
      const answerMatches =
        comparable(chunk.answer) === comparable(intent.normalizedSemanticEvidence.answer);
      const coverageStatus: CoverageStatus = questionMatches && answerMatches ? "full" : "none";
      return {
        evidenceId: intent.evidenceId,
        faqIntentId: intent.faqIntentId,
        supportingSourceSpanHash: intent.supportingSourceSpanHash,
        semanticEvidenceHash: intent.semanticEvidenceHash,
        coverageStatus,
        derivation:
          coverageStatus === "full"
            ? "Exact normalized active chunk question and answer match the inventory source evidence question and answer."
            : "Active chunk question and answer do not fully match this inventory source evidence.",
      };
    });
    return {
      chunkKey: chunk.chunkKey,
      chunkIndex: chunk.chunkIndex,
      chunkHash: chunk.contentHash,
      documentKey: chunk.documentKey,
      documentVersion: chunk.documentVersion,
      sourceUrl: chunk.sourceUrl,
      questionHash: sha256Hex(chunk.question),
      answerHash: sha256Hex(chunk.answer),
      evidenceCoverage,
    };
  });

  const evidenceMappings = input.inventory.intents.map((intent) => ({
    evidenceId: intent.evidenceId,
    faqIntentId: intent.faqIntentId,
    fullCoverageChunkKeys: chunkMappings
      .filter((chunk) =>
        chunk.evidenceCoverage.some(
          (coverage) =>
            coverage.evidenceId === intent.evidenceId && coverage.coverageStatus === "full",
        ),
      )
      .map((chunk) => chunk.chunkKey)
      .sort(),
  }));

  for (const mapping of evidenceMappings) {
    if (mapping.fullCoverageChunkKeys.length === 0) {
      throw new Error(`No full baseline chunk mapping for evidence ${mapping.evidenceId}.`);
    }
  }

  return {
    schemaVersion: "rag-baseline-evidence-chunk-mapping-v1",
    candidatePackage: {
      id: "mein-konto-v1-active-baseline-chunks",
      description:
        "Current active mein-konto v1 production chunk configuration before chunk variants.",
      gitCommit: input.gitCommit,
      chunkingRecipe: "current-active-baseline-read-only",
    },
    frozenInputs: {
      datasetPath: DATASET_PATH,
      datasetSha256: input.datasetSha256,
      manifestPath: MANIFEST_PATH,
      manifestSha256: input.manifestSha256,
      evidenceInventoryPath:
        "tests/fixtures/rag/mein-konto-v1-semantic-evidence-inventory.draft.json",
      evidenceInventorySha256: input.inventorySha256,
    },
    activeDocument: input.activeDocument,
    activeChunkSet: activeChunkSetIdentity(input.activeChunks, input.storedEmbeddings),
    mappingDerivation: {
      usesRetrievalScores: false,
      usesChunkCountAssumption: false,
      method:
        "For every evidence unit, compare normalized active chunk question and answer text to the accepted inventory normalized source question and answer text. Mark coverage full only on exact source-text equality.",
    },
    chunkMappings,
    evidenceMappings,
  };
}

async function evaluateQueries(
  client: pg.PoolClient,
  dataset: DevelopmentQuery[],
  evidenceMappings: EvidenceMapping[],
  generator: TransformersE5SmallPassageEmbeddingGenerator,
): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (const record of dataset) {
    const queryEmbedding = await generator.embedQuery(record.query);
    const ranked = await rankActiveMeinKontoChunks(client, queryEmbedding.embedding);
    const rankings = ranked.map((chunk) => {
      const acceptable = record.acceptableEvidenceIds.filter((evidenceId) => {
        const mapping = evidenceMappings.find((item) => item.evidenceId === evidenceId);
        return mapping?.fullCoverageChunkKeys.includes(chunk.chunkKey) === true;
      });
      return { ...chunk, acceptableEvidenceIdsWithFullCoverage: acceptable };
    });
    const firstAcceptableRank =
      record.answerability === "answerable"
        ? (rankings.find((chunk) => chunk.acceptableEvidenceIdsWithFullCoverage.length > 0)?.rank ??
          null)
        : null;
    const topScore = rankings[0]?.score ?? null;
    const secondScore = rankings[1]?.score ?? null;
    results.push({
      id: record.id,
      queryType: record.queryType,
      answerability: record.answerability,
      faqIntentId: record.faqIntentId,
      expectedEvidenceId: record.expectedEvidenceId,
      acceptableEvidenceIds: record.acceptableEvidenceIds,
      queryEmbeddingInputHash: queryEmbedding.inputHash,
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
      rankings,
    });
  }
  return results;
}

async function rankActiveMeinKontoChunks(
  client: pg.PoolClient,
  queryEmbedding: number[],
): Promise<Omit<RankedChunk, "acceptableEvidenceIdsWithFullCoverage">[]> {
  const model = embeddingProfileModelRef();
  const result = await client.query<{
    chunk_key: string;
    content_hash: string;
    document_key: string;
    document_version: number;
    score: string | number;
  }>(
    `SELECT c.chunk_key,
            c.content_hash,
            c.document_key,
            c.document_version,
            1 - (e.embedding <=> $1::vector) AS score
       FROM rag_chunk_embeddings e
       JOIN rag_documents d
         ON d.document_key = e.document_key
        AND d.current_version = e.document_version
       JOIN rag_chunks c
         ON c.document_key = e.document_key
        AND c.document_version = e.document_version
        AND c.chunk_index = e.chunk_index
      WHERE c.document_key = $2
        AND e.embedding_provider = $3
        AND e.embedding_model = $4
        AND e.embedding_model_version = $5
        AND e.embedding_artifact = $6
        AND e.embedding_dtype = $7
        AND e.embedding_runtime = $8
        AND e.embedding_profile_id = $9
      ORDER BY score DESC, c.document_key ASC, c.document_version ASC, c.chunk_key ASC`,
    [
      formatVector(queryEmbedding),
      DOCUMENT_KEY,
      model.embeddingProvider,
      model.embeddingModel,
      model.embeddingModelVersion,
      model.embeddingArtifact,
      model.embeddingDtype,
      model.embeddingRuntime,
      model.embeddingProfileId,
    ],
  );
  return result.rows.map((row, index) => ({
    rank: index + 1,
    chunkKey: row.chunk_key,
    chunkHash: row.content_hash,
    documentKey: row.document_key,
    documentVersion: row.document_version,
    score: Number(row.score),
  }));
}

function computeMetrics(results: QueryResult[]) {
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

function scoreDistribution(results: QueryResult[]) {
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

function buildResultArtifact(input: {
  gitCommit: string;
  datasetSha256: string;
  manifestSha256: string;
  inventorySha256: string;
  manifest: DatasetManifest;
  inventory: EvidenceInventory;
  activeDocument: ActiveDocument;
  activeChunks: ActiveChunk[];
  storedEmbeddings: StoredEmbedding[];
  mappingPath: string;
  mappingSha256: string;
  perQuery: QueryResult[];
  metrics: ReturnType<typeof computeMetrics>;
}) {
  return {
    schemaVersion: "rag-development-baseline-retrieval-results-v1",
    baseline: {
      id: "mein-konto-v1-development-v1-current-active-baseline",
      description:
        "Read-only retrieval baseline for the frozen 96-query mein-konto v1 development dataset against the current active baseline chunks.",
      evaluationTimestamp: new Date().toISOString(),
      gitCommit: input.gitCommit,
      productionBehaviorChanged: false,
      databaseMutationIntended: false,
      thresholdTuned: false,
    },
    frozenInputs: {
      datasetPath: DATASET_PATH,
      datasetVersion: input.manifest.datasetVersion,
      datasetSha256: input.datasetSha256,
      manifestPath: MANIFEST_PATH,
      manifestSha256: input.manifestSha256,
      evidenceInventoryPath: input.manifest.semanticEvidenceInventory.path,
      evidenceInventorySchemaVersion: input.inventory.schemaVersion,
      evidenceInventorySha256: input.inventorySha256,
    },
    activeDocument: input.activeDocument,
    activeChunkSet: activeChunkSetIdentity(input.activeChunks, input.storedEmbeddings),
    embeddingProfile: {
      id: RAG_EMBEDDING_PROFILE.id,
      provider: RAG_EMBEDDING_PROFILE.provider,
      modelId: RAG_EMBEDDING_PROFILE.modelId,
      modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
      artifact: RAG_EMBEDDING_PROFILE.artifact,
      artifactSha256: RAG_EMBEDDING_PROFILE.artifactSha256,
      dimension: RAG_EMBEDDING_PROFILE.dimension,
      normalized: RAG_EMBEDDING_PROFILE.normalized,
      queryPrefix: RAG_EMBEDDING_PROFILE.queryPrefix,
      queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
    },
    retrievalConfiguration: {
      rankedChunkScope: "complete-current-active-mein-konto-v1-chunk-set",
      similarityFunction: "cosine_similarity = 1 - (pgvector_cosine_distance)",
      rankingOrder: "score DESC, document_key ASC, document_version ASC, chunk_key ASC",
      thresholdIndependentMetrics: true,
      productionThresholdEvaluated: null,
    },
    mappingArtifact: {
      path: input.mappingPath,
      sha256: input.mappingSha256,
    },
    metrics: input.metrics,
    perQuery: input.perQuery.map(roundQueryResult),
  };
}

function activeChunkSetIdentity(chunks: ActiveChunk[], embeddings: StoredEmbedding[]) {
  const orderedChunks = chunks.map((chunk) => {
    const embedding = embeddings.find((item) => item.chunkIndex === chunk.chunkIndex);
    return {
      chunkIndex: chunk.chunkIndex,
      chunkKey: chunk.chunkKey,
      chunkHash: chunk.contentHash,
      embeddingInputHash: embedding?.inputHash ?? null,
      embeddingChunkContentHash: embedding?.chunkContentHash ?? null,
    };
  });
  return {
    id: sha256Hex(JSON.stringify({ documentKey: DOCUMENT_KEY, orderedChunks })),
    chunkCount: chunks.length,
    orderedChunks,
  };
}

function roundQueryResult(result: QueryResult): QueryResult {
  return {
    ...result,
    reciprocalRank: round(result.reciprocalRank),
    topScore: nullableRound(result.topScore),
    topScoreMargin: nullableRound(result.topScoreMargin),
    rankings: result.rankings.map((ranking) => ({ ...ranking, score: round(ranking.score) })),
  };
}

function comparable(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function formatVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
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

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Hex(await fs.readFile(filePath));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, await jsonFileContent(filePath, value));
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function jsonFileContent(filePath: string, value: unknown): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  return await formatWithPrettier(JSON.stringify(value), { ...config, filepath: filePath });
}

function gitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

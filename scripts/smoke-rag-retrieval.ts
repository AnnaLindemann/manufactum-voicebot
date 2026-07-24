import "dotenv/config";
import pg from "pg";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";
import { retrieveRelevantChunks } from "../src/rag/retrieve-relevant-chunks.js";

const DEFAULT_MIN_SCORE = 0.8;
const MAX_CHUNKS = 3;

const probes = [
  { kind: "exact", query: "Wie kann ich mich registrieren?" },
  { kind: "paraphrased", query: "Wo lege ich ein Kundenkonto an?" },
  { kind: "irrelevant", query: "Wie repariere ich eine Kaffeemühle?" },
] as const;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set to run RAG retrieval smoke evaluation.");
  }

  const minScore = configuredMinScore();
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
    const activeChunkCount = await countActiveChunks(pool);
    const results = [];
    if (activeChunkCount === 0) {
      for (const probe of probes) {
        results.push({
          kind: probe.kind,
          query: probe.query,
          returnedChunkCount: 0,
          skippedReason: "no_active_rag_chunks",
          chunks: [],
        });
      }
    } else {
      const store = new PostgresRagDocumentStore(pool);
      const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);
      for (const probe of probes) {
        const retrieved = await retrieveRelevantChunks(store, generator, probe.query, {
          maxChunks: MAX_CHUNKS,
          minScore,
        });
        results.push({
          kind: probe.kind,
          query: probe.query,
          returnedChunkCount: retrieved.length,
          chunks: retrieved.map((chunk) => ({
            chunkKey: chunk.chunkKey,
            documentKey: chunk.documentKey,
            documentVersion: chunk.documentVersion,
            score: Number(chunk.score.toFixed(6)),
            sourceUrl: chunk.sourceUrl,
            title: chunk.title,
            documentType: chunk.documentType,
            language: chunk.language,
          })),
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          embeddingProfileId: RAG_EMBEDDING_PROFILE.id,
          modelId: RAG_EMBEDDING_PROFILE.modelId,
          modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
          artifact: RAG_EMBEDDING_PROFILE.artifact,
          dimension: RAG_EMBEDDING_PROFILE.dimension,
          queryInputRecipe: RAG_EMBEDDING_PROFILE.queryInputRecipe,
          minScore,
          thresholdStatus: activeChunkCount < 5 ? "provisional_insufficient_data" : "provisional",
          activeChunkCount,
          maxChunks: MAX_CHUNKS,
          probes: results,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

function configuredMinScore(): number {
  const raw = nonEmpty(process.env.RAG_RETRIEVAL_MIN_SCORE);
  if (raw === undefined) {
    return DEFAULT_MIN_SCORE;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("RAG_RETRIEVAL_MIN_SCORE must be a number from 0 to 1.");
  }
  return value;
}

async function countActiveChunks(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM rag_chunks c
       JOIN rag_documents d
         ON d.document_key = c.document_key
        AND d.current_version = c.document_version`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

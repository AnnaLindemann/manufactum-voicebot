import "dotenv/config";
import pg from "pg";
import { embedAndActivateStagedVersion } from "../src/rag/embed-staged-version.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set to embed staged FAQ chunks.");
  }

  const documentKey = process.argv[2]?.trim();
  if (documentKey === undefined || documentKey.length === 0) {
    throw new Error("Usage: tsx scripts/embed-staged-faq-chunks.ts <document-key>");
  }

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
  };
  const cacheDir = nonEmpty(process.env.TRANSFORMERS_CACHE);
  if (cacheDir !== undefined) {
    generatorOptions.cacheDir = cacheDir;
  }
  const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);

  const pool = new pg.Pool({ connectionString });
  try {
    const store = new PostgresRagDocumentStore(pool);
    const result = await embedAndActivateStagedVersion(store, documentKey, generator);
    console.log(
      JSON.stringify({
        documentKey: result.documentKey,
        version: result.version,
        chunkCount: result.chunkCount,
        generatedEmbeddingCount: result.generatedEmbeddingCount,
        existingEmbeddingCount: result.existingEmbeddingCount,
        activated: result.activated,
        embeddingProfileId: RAG_EMBEDDING_PROFILE.id,
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
        artifact: RAG_EMBEDDING_PROFILE.artifact,
        dtype: RAG_EMBEDDING_PROFILE.dtype,
        dimension: RAG_EMBEDDING_PROFILE.dimension,
      }),
    );
  } finally {
    await pool.end();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

import "dotenv/config";
import pg from "pg";
import {
  embedAndActivateStagedVersion,
  embedStagedVersion,
} from "../src/rag/embed-staged-version.js";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE, embeddingProfileModelRef } from "../src/rag/embedding-profile.js";
import { PostgresRagDocumentStore } from "../src/rag/postgres-document-store.js";

/**
 * Offline embedding/activation command for a staged FAQ version, wrapping the production embedding
 * service (`TransformersE5SmallPassageEmbeddingGenerator`) and store API. Modes
 * (`rag-embeddings-and-retrieval-design.md` §4):
 *
 *   default        embed the staged version and activate it (Phase B + C).
 *   --embed-only   embed the staged version only, without activating (Phase B).
 *   --activate     activate the staged version only, through the store's readiness gate (Phase C);
 *                  a no-op when there is nothing staged (already-active), so it is safely idempotent.
 *
 * The connection string is read from `DATABASE_URL` and never printed.
 */

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("DATABASE_URL must be set to embed staged FAQ chunks.");
  }

  const args = process.argv.slice(2);
  const embedOnly = args.includes("--embed-only");
  const activateOnly = args.includes("--activate");
  if (embedOnly && activateOnly) {
    throw new Error("Choose at most one of --embed-only or --activate.");
  }
  const documentKey = args.find((arg) => !arg.startsWith("--"))?.trim();
  if (documentKey === undefined || documentKey.length === 0) {
    throw new Error(
      "Usage: tsx scripts/embed-staged-faq-chunks.ts <document-key> [--embed-only | --activate]",
    );
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const store = new PostgresRagDocumentStore(pool);

    if (activateOnly) {
      // Phase C only. Idempotent: if nothing is staged, report the current active version unchanged.
      const staged = await store.getStagedVersion(documentKey);
      const doc = await store.getDocument(documentKey);
      if (staged === undefined) {
        console.log(
          JSON.stringify({
            documentKey,
            mode: "activate",
            activated: false,
            alreadyActiveVersion: doc?.currentVersion ?? null,
            note: "no staged version to activate (already active or absent); no data changed",
          }),
        );
        return;
      }
      await store.activateVersion(documentKey, staged.version, embeddingProfileModelRef());
      console.log(
        JSON.stringify({ documentKey, mode: "activate", version: staged.version, activated: true }),
      );
      return;
    }

    const generator = new TransformersE5SmallPassageEmbeddingGenerator(buildGeneratorOptions());
    const result = embedOnly
      ? await embedStagedVersion(store, documentKey, generator)
      : await embedAndActivateStagedVersion(store, documentKey, generator);

    console.log(
      JSON.stringify({
        documentKey: result.documentKey,
        mode: embedOnly ? "embed-only" : "embed-and-activate",
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

function buildGeneratorOptions(): ConstructorParameters<
  typeof TransformersE5SmallPassageEmbeddingGenerator
>[0] {
  const options: ConstructorParameters<typeof TransformersE5SmallPassageEmbeddingGenerator>[0] = {
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
  };
  const cacheDir = nonEmpty(process.env.TRANSFORMERS_CACHE);
  if (cacheDir !== undefined) {
    options.cacheDir = cacheDir;
  }
  return options;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

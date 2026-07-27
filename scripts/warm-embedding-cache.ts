import "dotenv/config";
import { performance } from "node:perf_hooks";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../src/rag/embedding-profile.js";

/**
 * Pre-warms the pinned embedding artifact into the Transformers.js cache.
 *
 * Why it exists: the ~118 MB quantized ONNX artifact is fetched or read on the **first** RAG query,
 * not at boot. On a fresh Render instance that turns the first caller's question into a multi-second
 * download, and if the platform's health check or the caller times out first, the deployment looks
 * broken on its very first real use. Running this as part of the build moves that cost to build time,
 * where it is allowed to be slow and where a failure fails the release instead of a conversation.
 *
 * What it deliberately does **not** do:
 *
 * - **No PostgreSQL.** It imports no `pg`, opens no pool, and reads no `DATABASE_URL`. A build step
 *   must not need database credentials, and a warm-up that could touch the database is one that could
 *   damage it.
 * - **No ingestion, no writes.** It stages no version, stores no embedding, and mutates no RAG record.
 *   The single vector it computes lives in memory for the length of this process and is discarded.
 * - **No retrieval configuration.** It reads neither the threshold nor the retrieval width, because it
 *   retrieves nothing.
 *
 * It is kept separate from `scripts/smoke-rag-embedding-runtime.ts` on purpose. That script is a
 * **test**: it asserts seven properties of the runtime's output and is the evidence that the profile
 * behaves as accepted. This is a **build step**: its job is to populate a cache and to fail loudly if
 * the pinned artifact cannot be loaded. Merging them would mean either a build that fails on an
 * assertion that has nothing to do with caching, or a test whose result depends on cache state.
 *
 * Exit code: `0` when the artifact loaded and produced a usable vector, `1` otherwise. A non-zero exit
 * fails the Render build, which is the intended behaviour — a release whose model cannot be loaded
 * would answer every RAG query with `INTERNAL_ERROR`.
 */

/**
 * One short, fixed German sentence. Its content is irrelevant — it exists only to force the tokenizer
 * and the ONNX session through a real inference, so a warm-up cannot report success on an artifact
 * that downloaded but cannot actually run. It is not stored anywhere.
 */
const WARM_UP_INPUT = "Warmlauf des Embedding-Modells.";

async function main(): Promise<void> {
  const cacheDir = nonEmpty(process.env.TRANSFORMERS_CACHE);

  const generatorOptions: ConstructorParameters<
    typeof TransformersE5SmallPassageEmbeddingGenerator
  >[0] = {
    // Honoured, never forced. `RAG_EMBEDDING_LOCAL_FILES_ONLY=true` would forbid the download this
    // command exists to perform, so on a first warm-up it must be off; it is respected here only so
    // that an operator verifying an already-populated cache can run the same command offline.
    localFilesOnly: process.env.RAG_EMBEDDING_LOCAL_FILES_ONLY === "true",
    ...(cacheDir === undefined ? {} : { cacheDir }),
  };

  const generator = new TransformersE5SmallPassageEmbeddingGenerator(generatorOptions);

  const loadStart = performance.now();
  await generator.load();
  const loadMs = performance.now() - loadStart;

  const inferenceStart = performance.now();
  const warmed = await generator.embedQuery(WARM_UP_INPUT);
  const inferenceMs = performance.now() - inferenceStart;

  const usable =
    warmed.embedding.length === RAG_EMBEDDING_PROFILE.dimension &&
    warmed.embedding.every(Number.isFinite);

  console.log(
    JSON.stringify(
      {
        event: "rag_embedding_cache_warmed",
        profile: {
          provider: RAG_EMBEDDING_PROFILE.provider,
          modelId: RAG_EMBEDDING_PROFILE.modelId,
          modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
          artifact: RAG_EMBEDDING_PROFILE.artifact,
          artifactSha256: RAG_EMBEDDING_PROFILE.artifactSha256,
          dtype: RAG_EMBEDDING_PROFILE.dtype,
          runtime: `${RAG_EMBEDDING_PROFILE.runtimePackage}@${RAG_EMBEDDING_PROFILE.runtimeVersion}`,
          dimension: RAG_EMBEDDING_PROFILE.dimension,
        },
        cache: {
          // Whether the variable is set, not what it points to: a cache path is host layout, and this
          // line is printed into a build log.
          transformersCacheConfigured: cacheDir !== undefined,
          localFilesOnly: generatorOptions.localFilesOnly === true,
        },
        timingsMs: {
          load: Math.round(loadMs),
          warmUpInference: Math.round(inferenceMs),
        },
        memoryBytes: {
          // Evidence from whichever machine ran this command, and nothing more. It is not a
          // prediction of Render's memory use; see `deployment-preflight.md` § Memory.
          afterWarmUp: process.memoryUsage(),
        },
        output: {
          dimension: warmed.embedding.length,
          l2Norm: warmed.l2Norm,
          usable,
        },
      },
      null,
      2,
    ),
  );

  if (!usable) {
    process.exitCode = 1;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

try {
  await main();
} catch (error) {
  // A load or inference failure is `RagEmbeddingError`, whose message is a fixed string with no path
  // and no driver detail. Anything else is reported as an unknown failure rather than printed raw,
  // because a Transformers.js filesystem error quotes the cache path.
  console.error(
    JSON.stringify({
      level: "error",
      event: "rag_embedding_cache_warm_up_failed",
      message:
        error instanceof Error && error.name === "RagEmbeddingError"
          ? error.message
          : "The pinned embedding artifact could not be loaded.",
    }),
  );

  // Non-zero, so the platform treats the build as failed rather than shipping a release whose first
  // RAG query would be its first attempt at loading the model.
  process.exit(1);
}

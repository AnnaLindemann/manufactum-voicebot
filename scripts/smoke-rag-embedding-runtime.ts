import "dotenv/config";
import { performance } from "node:perf_hooks";
import { TransformersE5SmallPassageEmbeddingGenerator } from "../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../src/rag/embedding-profile.js";

const SMOKE_PASSAGE =
  "Frage: Wie funktioniert Click & Collect?\n\nAntwort: Sie bestellen online und holen die Ware nach Benachrichtigung in der ausgewählten Filiale ab.";

async function main(): Promise<void> {
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

  const memoryBeforeLoad = process.memoryUsage();
  const loadStart = performance.now();
  await generator.load();
  const loadMs = performance.now() - loadStart;
  const memoryAfterLoad = process.memoryUsage();

  const firstStart = performance.now();
  const first = await generator.embedPassage(SMOKE_PASSAGE);
  const firstEmbeddingMs = performance.now() - firstStart;
  const memoryAfterFirstInference = process.memoryUsage();

  const secondStart = performance.now();
  const second = await generator.embedPassage(SMOKE_PASSAGE);
  const secondEmbeddingMs = performance.now() - secondStart;
  const memoryAfterSecondInference = process.memoryUsage();

  const checks = {
    prefixed: first.prefixed,
    max512Tokens: first.tokenCount <= RAG_EMBEDDING_PROFILE.tokenizerLimit,
    dimension384: first.embedding.length === RAG_EMBEDDING_PROFILE.dimension,
    finiteNumbers: first.embedding.every(Number.isFinite),
    l2Normalized: Math.abs(first.l2Norm - 1) <= 0.001,
    stableSecondDimension: second.embedding.length === RAG_EMBEDDING_PROFILE.dimension,
    stableSecondFiniteNumbers: second.embedding.every(Number.isFinite),
  };

  console.log(
    JSON.stringify(
      {
        profile: {
          provider: RAG_EMBEDDING_PROFILE.provider,
          modelId: RAG_EMBEDDING_PROFILE.modelId,
          modelRevision: RAG_EMBEDDING_PROFILE.modelRevision,
          artifact: RAG_EMBEDDING_PROFILE.artifact,
          artifactSha256: RAG_EMBEDDING_PROFILE.artifactSha256,
          artifactSizeBytes: RAG_EMBEDDING_PROFILE.artifactSizeBytes,
          dtype: RAG_EMBEDDING_PROFILE.dtype,
          runtime: `${RAG_EMBEDDING_PROFILE.runtimePackage}@${RAG_EMBEDDING_PROFILE.runtimeVersion}`,
          dimension: RAG_EMBEDDING_PROFILE.dimension,
          tokenizerLimit: RAG_EMBEDDING_PROFILE.tokenizerLimit,
        },
        timingsMs: {
          load: Math.round(loadMs),
          firstEmbedding: Math.round(firstEmbeddingMs),
          secondEmbedding: Math.round(secondEmbeddingMs),
        },
        memoryBytes: {
          beforeLoad: memoryBeforeLoad,
          afterLoad: memoryAfterLoad,
          afterFirstInference: memoryAfterFirstInference,
          afterSecondInference: memoryAfterSecondInference,
        },
        output: {
          tokenCountAfterTruncation: first.tokenCount,
          dimension: first.embedding.length,
          l2Norm: first.l2Norm,
        },
        checks,
      },
      null,
      2,
    ),
  );

  if (!Object.values(checks).every(Boolean)) {
    process.exitCode = 1;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

await main();

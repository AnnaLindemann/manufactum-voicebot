export const RAG_EMBEDDING_PROFILE = Object.freeze({
  id: "local-transformers-js:xenova-multilingual-e5-small:ae61bf0193ce3851dc8a45147e459b04ed783d8a:onnx-model-quantized:int8:v1",
  provider: "local-transformers-js",
  modelId: "Xenova/multilingual-e5-small",
  modelRevision: "ae61bf0193ce3851dc8a45147e459b04ed783d8a",
  artifact: "onnx/model_quantized.onnx",
  artifactSha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
  artifactSizeBytes: 118_000_000,
  dtype: "int8-quantized",
  runtimePackage: "@xenova/transformers",
  runtimeVersion: "2.17.2",
  dimension: 384,
  passagePrefix: "passage: ",
  queryPrefix: "query: ",
  tokenizerLimit: 512,
  passageInputRecipe: "e5:passage:v1",
  queryInputRecipe: "e5:query:v1",
  normalized: true,
} as const);

export type RagEmbeddingProfile = typeof RAG_EMBEDDING_PROFILE;

export type RagEmbeddingProfileMetadata = {
  embeddingProvider: RagEmbeddingProfile["provider"];
  embeddingModel: RagEmbeddingProfile["modelId"];
  embeddingModelVersion: RagEmbeddingProfile["modelRevision"];
  embeddingArtifact: RagEmbeddingProfile["artifact"];
  embeddingDtype: RagEmbeddingProfile["dtype"];
  embeddingRuntime: `${RagEmbeddingProfile["runtimePackage"]}@${RagEmbeddingProfile["runtimeVersion"]}`;
  embeddingProfileId: RagEmbeddingProfile["id"];
  embeddingDim: RagEmbeddingProfile["dimension"];
  inputRecipe: RagEmbeddingProfile["passageInputRecipe"];
  normalized: RagEmbeddingProfile["normalized"];
};

export function embeddingProfileMetadata(
  profile: RagEmbeddingProfile = RAG_EMBEDDING_PROFILE,
): RagEmbeddingProfileMetadata {
  return {
    embeddingProvider: profile.provider,
    embeddingModel: profile.modelId,
    embeddingModelVersion: profile.modelRevision,
    embeddingArtifact: profile.artifact,
    embeddingDtype: profile.dtype,
    embeddingRuntime: `${profile.runtimePackage}@${profile.runtimeVersion}`,
    embeddingProfileId: profile.id,
    embeddingDim: profile.dimension,
    inputRecipe: profile.passageInputRecipe,
    normalized: profile.normalized,
  };
}

export function embeddingProfileModelRef(profile: RagEmbeddingProfile = RAG_EMBEDDING_PROFILE) {
  const metadata = embeddingProfileMetadata(profile);
  return {
    embeddingProvider: metadata.embeddingProvider,
    embeddingModel: metadata.embeddingModel,
    embeddingModelVersion: metadata.embeddingModelVersion,
    embeddingArtifact: metadata.embeddingArtifact,
    embeddingDtype: metadata.embeddingDtype,
    embeddingRuntime: metadata.embeddingRuntime,
    embeddingProfileId: metadata.embeddingProfileId,
  };
}

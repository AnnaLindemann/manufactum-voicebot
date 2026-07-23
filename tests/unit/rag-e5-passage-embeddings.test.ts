import { describe, expect, it } from "vitest";
import {
  RagEmbeddingError,
  TransformersE5SmallPassageEmbeddingGenerator,
  truncatePassageInput,
  vectorL2Norm,
} from "../../src/rag/e5-passage-embeddings.js";
import { RAG_EMBEDDING_PROFILE } from "../../src/rag/embedding-profile.js";
import { sha256Hex } from "../../src/rag/prepare-document.js";

function tokenizerStub(decoded = "passage: gekuerzter Text") {
  const calls: unknown[] = [];
  return {
    calls,
    tokenizer: {
      _call: (text: string, options: unknown) => {
        calls.push({ text, options });
        return { input_ids: [101, 200, 102] };
      },
      decode: (tokenIds: number[], options: unknown) => {
        calls.push({ tokenIds, options });
        return decoded;
      },
    },
  };
}

function normalized384(): number[] {
  const value = 1 / Math.sqrt(RAG_EMBEDDING_PROFILE.dimension);
  return Array.from({ length: RAG_EMBEDDING_PROFILE.dimension }, () => value);
}

describe("local E5-small passage embedding adapter", () => {
  it("uses one immutable typed profile for the approved Render test runtime", () => {
    expect(RAG_EMBEDDING_PROFILE).toMatchObject({
      provider: "local-transformers-js",
      modelId: "Xenova/multilingual-e5-small",
      modelRevision: "ae61bf0193ce3851dc8a45147e459b04ed783d8a",
      artifact: "onnx/model_quantized.onnx",
      artifactSha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
      dtype: "int8-quantized",
      runtimePackage: "@xenova/transformers",
      runtimeVersion: "2.17.2",
      dimension: 384,
      passagePrefix: "passage: ",
      tokenizerLimit: 512,
    });
  });

  it("forwards the pinned profile revision and quantized artifact selection to tokenizer and model loaders", async () => {
    const { tokenizer } = tokenizerStub();
    const loaderCalls: unknown[] = [];
    const generator = new TransformersE5SmallPassageEmbeddingGenerator({
      importTransformers: () =>
        Promise.resolve({
          AutoTokenizer: {
            from_pretrained: (modelId, options) => {
              loaderCalls.push({ kind: "tokenizer", modelId, options });
              return Promise.resolve(tokenizer);
            },
          },
          pipeline: (task, modelId, options) => {
            loaderCalls.push({ kind: "pipeline", task, modelId, options });
            return Promise.resolve(() =>
              Promise.resolve({
                dims: [1, RAG_EMBEDDING_PROFILE.dimension],
                data: Float32Array.from(normalized384()),
              }),
            );
          },
        }),
    });

    await generator.load();
    await generator.load();

    expect(loaderCalls).toEqual([
      {
        kind: "tokenizer",
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        options: {
          revision: RAG_EMBEDDING_PROFILE.modelRevision,
          quantized: true,
          model_file_name: "model",
        },
      },
      {
        kind: "pipeline",
        task: "feature-extraction",
        modelId: RAG_EMBEDDING_PROFILE.modelId,
        options: {
          revision: RAG_EMBEDDING_PROFILE.modelRevision,
          quantized: true,
          model_file_name: "model",
        },
      },
    ]);
  });

  it("shares one in-flight loader across parallel calls", async () => {
    const { tokenizer } = tokenizerStub();
    let imports = 0;
    const generator = new TransformersE5SmallPassageEmbeddingGenerator({
      importTransformers: async () => {
        imports += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          AutoTokenizer: {
            from_pretrained: () => Promise.resolve(tokenizer),
          },
          pipeline: () =>
            Promise.resolve(() =>
              Promise.resolve({
                dims: [1, RAG_EMBEDDING_PROFILE.dimension],
                data: Float32Array.from(normalized384()),
              }),
            ),
        };
      },
    });

    await Promise.all([generator.load(), generator.load()]);
    expect(imports).toBe(1);
  });

  it("adds the required passage prefix before tokenizer-based 512-token truncation", () => {
    const { tokenizer, calls } = tokenizerStub();
    const result = truncatePassageInput(tokenizer, "FAQ Antwort");

    expect(result).toEqual({ input: "passage: gekuerzter Text", tokenCount: 3 });
    expect(calls[0]).toEqual({
      text: `${RAG_EMBEDDING_PROFILE.passagePrefix}FAQ Antwort`,
      options: {
        truncation: true,
        max_length: RAG_EMBEDDING_PROFILE.tokenizerLimit,
        return_tensor: false,
      },
    });
    expect(calls[1]).toEqual({
      tokenIds: [101, 200, 102],
      options: { skip_special_tokens: true, clean_up_tokenization_spaces: false },
    });
  });

  it("hashes the actual truncated passage input and requests mean pooled normalized embeddings", async () => {
    const { tokenizer } = tokenizerStub("passage: tatsaechlicher Modellinput");
    const extractorCalls: unknown[] = [];
    const generator = new TransformersE5SmallPassageEmbeddingGenerator({
      importTransformers: () =>
        Promise.resolve({
          AutoTokenizer: {
            from_pretrained: () => Promise.resolve(tokenizer),
          },
          pipeline: () =>
            Promise.resolve((text, options) => {
              extractorCalls.push({ text, options });
              return Promise.resolve({
                dims: [1, RAG_EMBEDDING_PROFILE.dimension],
                data: Float32Array.from(normalized384()),
              });
            }),
        }),
    });

    const result = await generator.embedPassage("langer Inhalt");

    expect(extractorCalls).toEqual([
      {
        text: "passage: tatsaechlicher Modellinput",
        options: { pooling: "mean", normalize: true },
      },
    ]);
    expect(result.inputHash).toBe(sha256Hex("passage: tatsaechlicher Modellinput"));
    expect(result.embedding).toHaveLength(RAG_EMBEDDING_PROFILE.dimension);
    expect(result.tokenCount).toBe(3);
    expect(result.l2Norm).toBeCloseTo(1, 6);
  });

  it("rejects a vector with the wrong dimension or missing L2 normalization", async () => {
    const { tokenizer } = tokenizerStub();
    const wrongDimension = new TransformersE5SmallPassageEmbeddingGenerator({
      importTransformers: () =>
        Promise.resolve({
          AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) },
          pipeline: () =>
            Promise.resolve(() =>
              Promise.resolve({ dims: [1, 3], data: Float32Array.from([0.1, 0.2, 0.3]) }),
            ),
        }),
    });

    await expect(wrongDimension.embedPassage("content")).rejects.toThrow(RagEmbeddingError);

    const unnormalized = new TransformersE5SmallPassageEmbeddingGenerator({
      importTransformers: () =>
        Promise.resolve({
          AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) },
          pipeline: () =>
            Promise.resolve(() =>
              Promise.resolve({
                dims: [1, RAG_EMBEDDING_PROFILE.dimension],
                data: Float32Array.from(
                  Array.from({ length: RAG_EMBEDDING_PROFILE.dimension }, () => 1),
                ),
              }),
            ),
        }),
    });

    await expect(unnormalized.embedPassage("content")).rejects.toThrow(RagEmbeddingError);
  });

  it("computes L2 norm without depending on model loading", () => {
    expect(vectorL2Norm([3, 4])).toBe(5);
  });
});

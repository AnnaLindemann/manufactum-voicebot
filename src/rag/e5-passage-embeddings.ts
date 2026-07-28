import { sha256Hex } from "./prepare-document.js";
import { RAG_EMBEDDING_PROFILE, type RagEmbeddingProfile } from "./embedding-profile.js";

export class RagEmbeddingError extends Error {
  constructor(
    readonly code:
      | "RAG_EMBEDDING_MODEL_LOAD_FAILED"
      | "RAG_EMBEDDING_TOKENIZATION_FAILED"
      | "RAG_EMBEDDING_INFERENCE_FAILED"
      | "RAG_EMBEDDING_INVALID_OUTPUT"
      // The two failure modes a hosted query-embedding runtime has and a local one does not: the
      // call itself failing, and the credential being refused. `RAG_EMBEDDING_INVALID_OUTPUT` is
      // shared with the local runtime on purpose — a vector of the wrong width, a non-finite
      // element, or a lost normalization is the same defect wherever it was produced.
      | "RAG_EMBEDDING_PROVIDER_REQUEST_FAILED"
      | "RAG_EMBEDDING_PROVIDER_AUTH_FAILED",
    technicalMessage: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(technicalMessage, { cause });
    this.name = "RagEmbeddingError";
  }
}

export type PassageEmbeddingResult = {
  embedding: number[];
  inputHash: string;
  tokenCount: number;
  l2Norm: number;
  prefixed: true;
};

export type QueryEmbeddingResult = PassageEmbeddingResult;

export interface PassageEmbeddingGenerator {
  embedPassage(content: string): Promise<PassageEmbeddingResult>;
}

export interface QueryEmbeddingGenerator {
  embedQuery(query: string): Promise<QueryEmbeddingResult>;
}

type TokenizerInputIds = number[] | number[][] | { tolist: () => unknown[] };

type TokenizerOutput = {
  input_ids: TokenizerInputIds;
};

type E5Tokenizer = {
  _call: (
    text: string,
    options: {
      truncation: true;
      max_length: RagEmbeddingProfile["tokenizerLimit"];
      return_tensor: false;
    },
  ) => TokenizerOutput;
  decode: (
    tokenIds: number[],
    options: { skip_special_tokens: true; clean_up_tokenization_spaces: false },
  ) => string;
};

type FeatureTensor = {
  dims: number[];
  data: ArrayLike<number>;
};

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<FeatureTensor>;

type TransformersModule = {
  AutoTokenizer: {
    from_pretrained: (
      modelId: string,
      options: {
        revision: string;
        quantized: true;
        model_file_name: "model";
        cache_dir?: string;
        local_files_only?: boolean;
      },
    ) => Promise<E5Tokenizer>;
  };
  pipeline: (
    task: "feature-extraction",
    modelId: string,
    options: {
      revision: string;
      quantized: true;
      model_file_name: "model";
      cache_dir?: string;
      local_files_only?: boolean;
    },
  ) => Promise<FeatureExtractor>;
};

type LoadedTransformers = {
  tokenizer: E5Tokenizer;
  extractor: FeatureExtractor;
};

export type TransformersE5SmallPassageEmbeddingGeneratorOptions = {
  profile?: RagEmbeddingProfile;
  cacheDir?: string;
  localFilesOnly?: boolean;
  importTransformers?: () => Promise<TransformersModule>;
};

export class TransformersE5SmallPassageEmbeddingGenerator
  implements PassageEmbeddingGenerator, QueryEmbeddingGenerator
{
  private readonly profile: RagEmbeddingProfile;
  private readonly importTransformers: () => Promise<TransformersModule>;
  private inFlightLoad: Promise<LoadedTransformers> | undefined;
  private loaded: LoadedTransformers | undefined;

  constructor(private readonly options: TransformersE5SmallPassageEmbeddingGeneratorOptions = {}) {
    this.profile = options.profile ?? RAG_EMBEDDING_PROFILE;
    this.importTransformers =
      options.importTransformers ??
      (async () => {
        return (await import("@xenova/transformers")) as TransformersModule;
      });
  }

  async load(): Promise<LoadedTransformers> {
    if (this.loaded !== undefined) {
      return this.loaded;
    }
    this.inFlightLoad ??= this.loadOnce();
    return await this.inFlightLoad;
  }

  async embedPassage(content: string): Promise<PassageEmbeddingResult> {
    return await this.embedWithPrefix(content, this.profile.passagePrefix);
  }

  async embedQuery(query: string): Promise<QueryEmbeddingResult> {
    return await this.embedWithPrefix(query, this.profile.queryPrefix);
  }

  private async embedWithPrefix(
    content: string,
    prefix: RagEmbeddingProfile["passagePrefix"] | RagEmbeddingProfile["queryPrefix"],
  ): Promise<PassageEmbeddingResult> {
    const loaded = await this.load();
    const tokenized = truncateE5Input(loaded.tokenizer, content, prefix, this.profile);
    let tensor: FeatureTensor;
    try {
      tensor = await loaded.extractor(tokenized.input, { pooling: "mean", normalize: true });
    } catch (error) {
      throw new RagEmbeddingError(
        "RAG_EMBEDDING_INFERENCE_FAILED",
        "Local embedding inference failed.",
        true,
        error,
      );
    }

    const embedding = tensorToVector(tensor, this.profile.dimension);
    const l2Norm = vectorL2Norm(embedding);
    if (Math.abs(l2Norm - 1) > 0.001) {
      throw new RagEmbeddingError(
        "RAG_EMBEDDING_INVALID_OUTPUT",
        `Expected an L2-normalized embedding, received norm ${l2Norm.toFixed(6)}.`,
        false,
      );
    }

    return {
      embedding,
      inputHash: sha256Hex(tokenized.input),
      tokenCount: tokenized.tokenCount,
      l2Norm,
      prefixed: true,
    };
  }

  private async loadOnce(): Promise<LoadedTransformers> {
    const loadOptions = loaderOptions(this.profile, this.options);
    try {
      const transformers = await this.importTransformers();
      const [tokenizer, extractor] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(this.profile.modelId, loadOptions),
        transformers.pipeline("feature-extraction", this.profile.modelId, loadOptions),
      ]);
      this.loaded = { tokenizer, extractor };
      return this.loaded;
    } catch (error) {
      this.inFlightLoad = undefined;
      throw new RagEmbeddingError(
        "RAG_EMBEDDING_MODEL_LOAD_FAILED",
        "Local embedding model load failed.",
        true,
        error,
      );
    }
  }
}

export function truncatePassageInput(
  tokenizer: E5Tokenizer,
  content: string,
  profile: RagEmbeddingProfile = RAG_EMBEDDING_PROFILE,
): { input: string; tokenCount: number } {
  return truncateE5Input(tokenizer, content, profile.passagePrefix, profile);
}

export function truncateQueryInput(
  tokenizer: E5Tokenizer,
  content: string,
  profile: RagEmbeddingProfile = RAG_EMBEDDING_PROFILE,
): { input: string; tokenCount: number } {
  return truncateE5Input(tokenizer, content, profile.queryPrefix, profile);
}

function truncateE5Input(
  tokenizer: E5Tokenizer,
  content: string,
  prefix: RagEmbeddingProfile["passagePrefix"] | RagEmbeddingProfile["queryPrefix"],
  profile: RagEmbeddingProfile,
): { input: string; tokenCount: number } {
  const prefixed = `${prefix}${content}`;
  let tokenIds: number[];
  try {
    const encoded = tokenizer._call(prefixed, {
      truncation: true,
      max_length: profile.tokenizerLimit,
      return_tensor: false,
    });
    tokenIds = flattenTokenIds(encoded.input_ids);
  } catch (error) {
    throw new RagEmbeddingError(
      "RAG_EMBEDDING_TOKENIZATION_FAILED",
      "Local embedding tokenizer failed.",
      true,
      error,
    );
  }

  const input = tokenizer.decode(tokenIds, {
    skip_special_tokens: true,
    clean_up_tokenization_spaces: false,
  });

  if (!input.startsWith(prefix)) {
    throw new RagEmbeddingError(
      "RAG_EMBEDDING_INVALID_OUTPUT",
      "Tokenized E5 input lost its required task prefix.",
      false,
    );
  }

  return { input, tokenCount: tokenIds.length };
}

export function vectorL2Norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function loaderOptions(
  profile: RagEmbeddingProfile,
  options: TransformersE5SmallPassageEmbeddingGeneratorOptions,
): {
  revision: string;
  quantized: true;
  model_file_name: "model";
  cache_dir?: string;
  local_files_only?: boolean;
} {
  const loadOptions: {
    revision: string;
    quantized: true;
    model_file_name: "model";
    cache_dir?: string;
    local_files_only?: boolean;
  } = {
    revision: profile.modelRevision,
    quantized: true,
    model_file_name: "model",
  };
  if (options.cacheDir !== undefined) {
    loadOptions.cache_dir = options.cacheDir;
  }
  if (options.localFilesOnly !== undefined) {
    loadOptions.local_files_only = options.localFilesOnly;
  }
  return loadOptions;
}

function flattenTokenIds(inputIds: TokenizerInputIds): number[] {
  if (Array.isArray(inputIds)) {
    if (inputIds.every((value): value is number => typeof value === "number")) {
      return inputIds;
    }
    const first = inputIds[0];
    if (
      Array.isArray(first) &&
      first.every((value): value is number => typeof value === "number")
    ) {
      return first;
    }
  }

  if (typeof inputIds === "object" && inputIds !== null && "tolist" in inputIds) {
    const listed = inputIds.tolist();
    return flattenTokenIds(listed as TokenizerInputIds);
  }

  throw new TypeError("Tokenizer returned unsupported input_ids shape.");
}

function tensorToVector(tensor: FeatureTensor, expectedDimension: number): number[] {
  if (tensor.dims.length !== 2 || tensor.dims[0] !== 1) {
    throw new RagEmbeddingError(
      "RAG_EMBEDDING_INVALID_OUTPUT",
      `Expected a pooled [1, dim] feature tensor, received rank ${String(tensor.dims.length)}.`,
      false,
    );
  }
  const embedding = Array.from({ length: tensor.data.length }, (_, index) =>
    Number(tensor.data[index]),
  );
  if (embedding.length !== expectedDimension) {
    throw new RagEmbeddingError(
      "RAG_EMBEDDING_INVALID_OUTPUT",
      `Expected ${String(expectedDimension)} embedding dimensions, received ${String(embedding.length)}.`,
      false,
    );
  }
  return embedding;
}

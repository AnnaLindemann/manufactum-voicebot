import { describe, expect, it } from "vitest";
import { RAG_EMBEDDING_PROFILE } from "../../src/rag/embedding-profile.js";
import { HuggingFaceQueryEmbeddingProvider } from "../../src/rag/huggingface-query-embedding-provider.js";
import {
  LocalQueryEmbeddingProvider,
  createQueryEmbeddingProvider,
} from "../../src/rag/query-embedding-provider.js";
import { retrieveRelevantChunks } from "../../src/rag/retrieve-relevant-chunks.js";
import {
  createRecordingRagDocumentStore,
  createStubQueryEmbeddingGenerator,
  searchResult,
} from "../helpers/rag-test-doubles.js";
import { createRecordingLogger } from "../helpers/test-doubles.js";

/**
 * Provider selection and the local provider's transparency.
 *
 * The local provider is the accepted baseline and must remain byte-identical to what the retrieval
 * path saw before this abstraction existed, so the case that matters most here is the one asserting
 * it forwards its generator's result rather than reshaping it.
 */

const TOKEN = "hf_selection-test-token-never-real";

describe("LocalQueryEmbeddingProvider", () => {
  it("forwards the query to the existing generator unchanged", async () => {
    const generator = createStubQueryEmbeddingGenerator();
    const provider = new LocalQueryEmbeddingProvider(generator);

    await provider.embedQuery("Wie kann ich mich registrieren?");

    // The E5 query prefix is applied inside the generator, exactly as before: the provider must not
    // prepend, trim, or normalize anything on the way in.
    expect(generator.embeddedQueries).toEqual(["Wie kann ich mich registrieren?"]);
  });

  it("returns the generator's result object untouched", async () => {
    const generator = createStubQueryEmbeddingGenerator();
    const provider = new LocalQueryEmbeddingProvider(generator);

    const direct = await generator.embedQuery("Frage");
    const throughProvider = await provider.embedQuery("Frage");

    expect(throughProvider).toEqual(direct);
  });

  it("satisfies the retrieval path without any adaptation", async () => {
    const store = createRecordingRagDocumentStore([
      searchResult({ chunkKey: "mein-konto:v1:chunk-001", score: 0.91 }),
    ]);
    const provider = new LocalQueryEmbeddingProvider(createStubQueryEmbeddingGenerator());

    const chunks = await retrieveRelevantChunks(store, provider, "Frage", {
      maxChunks: 3,
      minScore: 0.8,
    });

    expect(chunks).toHaveLength(1);
    expect(store.searchCalls[0]?.queryEmbedding).toHaveLength(RAG_EMBEDDING_PROFILE.dimension);
  });
});

describe("createQueryEmbeddingProvider", () => {
  it("builds the local provider for the local configuration", () => {
    const provider = createQueryEmbeddingProvider(
      { provider: "local" },
      { logger: createRecordingLogger() },
    );

    expect(provider).toBeInstanceOf(LocalQueryEmbeddingProvider);
  });

  it("builds the hosted provider for the Hugging Face configuration", () => {
    const provider = createQueryEmbeddingProvider(
      {
        provider: "huggingface",
        token: TOKEN,
        model: "intfloat/multilingual-e5-small",
        timeoutMs: 10_000,
      },
      { logger: createRecordingLogger() },
    );

    expect(provider).toBeInstanceOf(HuggingFaceQueryEmbeddingProvider);
  });

  it("records which runtime a release chose, without recording the credential", () => {
    const logger = createRecordingLogger();

    createQueryEmbeddingProvider(
      {
        provider: "huggingface",
        token: TOKEN,
        model: "intfloat/multilingual-e5-small",
        timeoutMs: 10_000,
      },
      { logger },
    );

    // One line, at construction, so an operator can confirm from the log which runtime is running.
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.event).toBe("rag_query_embedding_provider_selected");
    expect(logger.entries[0]?.fields.message).toContain("huggingface");
    expect(JSON.stringify(logger.entries)).not.toContain(TOKEN);
  });

  it("selects once and returns a provider that cannot change afterwards", () => {
    const logger = createRecordingLogger();

    const first = createQueryEmbeddingProvider({ provider: "local" }, { logger });
    const second = createQueryEmbeddingProvider({ provider: "local" }, { logger });

    // Two calls build two providers; nothing here reads the environment, so a request path holding
    // one instance can never be handed the other runtime.
    expect(first).not.toBe(second);
    expect(first).toBeInstanceOf(LocalQueryEmbeddingProvider);
    expect(second).toBeInstanceOf(LocalQueryEmbeddingProvider);
  });
});

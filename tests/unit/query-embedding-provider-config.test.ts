import { describe, expect, it } from "vitest";
import {
  DEFAULT_HF_EMBEDDING_MODEL,
  DEFAULT_HF_EMBEDDING_TIMEOUT_MS,
  MAX_HF_EMBEDDING_TIMEOUT_MS,
  MIN_HF_EMBEDDING_TIMEOUT_MS,
  resolveQueryEmbeddingProviderConfig,
} from "../../src/config/query-embedding-provider-config.js";

/**
 * Provider selection is operator configuration and nothing else. These cases pin the two properties
 * that make that safe: an unset variable keeps the accepted local baseline, and anything the code
 * cannot honour fails the load instead of being guessed at.
 */

/** Deliberately distinctive, so a test can assert it never reaches a message. */
const TOKEN = "hf_config-test-token-never-real";

describe("resolveQueryEmbeddingProviderConfig", () => {
  it("defaults to the local runtime when the variable is unset", () => {
    // The accepted baseline must be what a release that changed nothing keeps running.
    expect(resolveQueryEmbeddingProviderConfig({})).toEqual({
      ok: true,
      config: { provider: "local" },
    });
  });

  it("treats an empty or blank value as unset, like every other optional variable here", () => {
    expect(resolveQueryEmbeddingProviderConfig({ RAG_QUERY_EMBEDDING_PROVIDER: "   " })).toEqual({
      ok: true,
      config: { provider: "local" },
    });
  });

  it("accepts the local runtime explicitly", () => {
    expect(resolveQueryEmbeddingProviderConfig({ RAG_QUERY_EMBEDDING_PROVIDER: "local" })).toEqual({
      ok: true,
      config: { provider: "local" },
    });
  });

  it("rejects an unknown provider by name instead of falling back to one", () => {
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "openai",
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("RAG_QUERY_EMBEDDING_PROVIDER");
    expect(resolution.ok ? "" : resolution.message).toContain("local, huggingface");
  });

  it("is case sensitive rather than guessing at a near miss", () => {
    expect(
      resolveQueryEmbeddingProviderConfig({ RAG_QUERY_EMBEDDING_PROVIDER: "HuggingFace" }).ok,
    ).toBe(false);
  });

  it("ignores the Hugging Face variables entirely on the local branch", () => {
    // A deployment rolling back to the local runtime must not be blocked by a stale credential or a
    // stale timeout it no longer uses.
    expect(
      resolveQueryEmbeddingProviderConfig({
        RAG_QUERY_EMBEDDING_PROVIDER: "local",
        HF_EMBEDDING_TIMEOUT_MS: "not a number",
        HF_EMBEDDING_MODEL: "../../etc/passwd",
      }),
    ).toEqual({ ok: true, config: { provider: "local" } });
  });

  it("resolves the hosted runtime with the documented defaults", () => {
    expect(
      resolveQueryEmbeddingProviderConfig({
        RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
        HF_TOKEN: TOKEN,
      }),
    ).toEqual({
      ok: true,
      config: {
        provider: "huggingface",
        token: TOKEN,
        model: DEFAULT_HF_EMBEDDING_MODEL,
        timeoutMs: DEFAULT_HF_EMBEDDING_TIMEOUT_MS,
      },
    });
  });

  it("carries an overridden model and timeout through", () => {
    expect(
      resolveQueryEmbeddingProviderConfig({
        RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
        HF_TOKEN: TOKEN,
        HF_EMBEDDING_MODEL: "sentence-transformers/all-MiniLM-L6-v2",
        HF_EMBEDDING_TIMEOUT_MS: "4000",
      }),
    ).toEqual({
      ok: true,
      config: {
        provider: "huggingface",
        token: TOKEN,
        model: "sentence-transformers/all-MiniLM-L6-v2",
        timeoutMs: 4000,
      },
    });
  });

  it("fails when the hosted runtime is requested without a credential", () => {
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
    });

    // Otherwise the release boots, reports healthy, and answers every retrieval call with a 500.
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("HF_TOKEN");
  });

  it("treats a blank credential as missing rather than sending an empty bearer header", () => {
    expect(
      resolveQueryEmbeddingProviderConfig({
        RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
        HF_TOKEN: "  ",
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["a word", "bald"],
    ["a fraction", "1500.5"],
    ["below the floor", String(MIN_HF_EMBEDDING_TIMEOUT_MS - 1)],
    ["above the ceiling", String(MAX_HF_EMBEDDING_TIMEOUT_MS + 1)],
    ["zero", "0"],
    ["a negative", "-1000"],
  ])("fails when the timeout is %s", (_label, value) => {
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
      HF_TOKEN: TOKEN,
      HF_EMBEDDING_TIMEOUT_MS: value,
    });

    // A malformed timeout must not silently take the default: the call would then be bounded by a
    // number nobody chose.
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("HF_EMBEDDING_TIMEOUT_MS");
  });

  it.each([
    ["a bare name with no owner", "multilingual-e5-small"],
    ["a traversal", "intfloat/.."],
    ["a nested path", "intfloat/e5/small"],
    ["an absolute URL", "https://evil.test/model"],
    ["a query string", "intfloat/e5?revision=main"],
    ["whitespace", "intfloat/e5 small"],
  ])("rejects a model identifier that is %s", (_label, value) => {
    // The value is interpolated into the request URL, so an unchecked one could walk out of the
    // models path or append parameters of its own.
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
      HF_TOKEN: TOKEN,
      HF_EMBEDDING_MODEL: value,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("HF_EMBEDDING_MODEL");
  });

  it("reports every offending Hugging Face variable in one message", () => {
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
      HF_EMBEDDING_MODEL: "not-a-repo",
      HF_EMBEDDING_TIMEOUT_MS: "sofort",
    });

    // Otherwise an operator fixes one variable, redeploys, and discovers the next one only then.
    const message = resolution.ok ? "" : resolution.message;
    expect(message).toContain("HF_TOKEN");
    expect(message).toContain("HF_EMBEDDING_MODEL");
    expect(message).toContain("HF_EMBEDDING_TIMEOUT_MS");
  });

  it("never puts the credential into a failure message", () => {
    const resolution = resolveQueryEmbeddingProviderConfig({
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
      HF_TOKEN: TOKEN,
      HF_EMBEDDING_TIMEOUT_MS: "gleich",
    });

    // The startup log is where a configuration message lands in a platform's retained log stream.
    expect(resolution.ok ? "" : resolution.message).not.toContain(TOKEN);
  });
});

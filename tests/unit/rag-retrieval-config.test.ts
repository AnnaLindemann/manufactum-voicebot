import { describe, expect, it } from "vitest";
import { loadRagRetrievalConfig } from "../../src/config/rag-retrieval-config.js";

/**
 * Covers only what the transport configuration added: that TLS is resolved as part of the retrieval
 * configuration, and that its failures behave like every other configuration failure. Threshold,
 * width, and embedding behaviour are unchanged and are covered where they already were.
 */

const CA_BUNDLE =
  "-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----\n";

const DATABASE_URL = "postgres://rag:config-test-password-never-real@db.invalid:5432/rag";

describe("loadRagRetrievalConfig transport configuration", () => {
  it("resolves to the unset mode when no TLS mode is configured", () => {
    const config = loadRagRetrievalConfig({ DATABASE_URL });

    expect(config.ssl).toEqual({ mode: "unset" });
  });

  it("carries the verified TLS configuration through to the pool options", () => {
    const config = loadRagRetrievalConfig(
      {
        DATABASE_URL,
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_CA_CERT_PATH: "/etc/secrets/supabase-ca.crt",
      },
      () => CA_BUNDLE,
    );

    expect(config.ssl).toEqual({
      mode: "verify-full",
      ssl: { rejectUnauthorized: true, ca: CA_BUNDLE },
    });
  });

  it("fails the load when verified TLS is requested and the CA cannot be read", () => {
    expect(() =>
      loadRagRetrievalConfig(
        {
          DATABASE_URL,
          DATABASE_SSL_MODE: "verify-full",
          DATABASE_CA_CERT_PATH: "/etc/secrets/missing.crt",
        },
        () => {
          throw new Error("ENOENT");
        },
      ),
    ).toThrow(/DATABASE_CA_CERT_PATH/);
  });

  it("reports a transport failure and a missing connection string in the same message", () => {
    // Otherwise an operator fixes the certificate, redeploys, and only then learns the connection
    // string was missing too.
    expect(() => loadRagRetrievalConfig({ DATABASE_SSL_MODE: "verify-full" })).toThrow(
      /DATABASE_URL.*DATABASE_CA_CERT_PATH|DATABASE_CA_CERT_PATH.*DATABASE_URL/s,
    );
  });

  it("never includes the connection string or the certificate in a failure message", () => {
    let message = "";

    try {
      loadRagRetrievalConfig(
        {
          DATABASE_URL,
          DATABASE_SSL_MODE: "verify-full",
          DATABASE_CA_CERT_PATH: "/etc/secrets/prod-ca-2021.crt",
        },
        () => "not a certificate",
      );
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("DATABASE_CA_CERT_PATH");
    expect(message).not.toContain("config-test-password-never-real");
    expect(message).not.toContain("/etc/secrets/");
  });
});

/**
 * The query-embedding provider is resolved as part of the retrieval configuration, so that the
 * existing startup check validates it without a second entry point. Selection semantics themselves
 * live in `query-embedding-provider-config.test.ts`; these cases cover only the integration.
 */
describe("loadRagRetrievalConfig query embedding provider", () => {
  it("carries the local runtime when nothing selects a provider", () => {
    const config = loadRagRetrievalConfig({ DATABASE_URL });

    expect(config.queryEmbedding).toEqual({ provider: "local" });
  });

  it("carries the resolved hosted provider through to the dependency builder", () => {
    const config = loadRagRetrievalConfig({
      DATABASE_URL,
      RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
      HF_TOKEN: "hf_retrieval-config-test-token-never-real",
      HF_EMBEDDING_TIMEOUT_MS: "5000",
    });

    expect(config.queryEmbedding).toMatchObject({ provider: "huggingface", timeoutMs: 5000 });
  });

  it("fails the load for an unknown provider instead of falling back to one", () => {
    expect(() =>
      loadRagRetrievalConfig({ DATABASE_URL, RAG_QUERY_EMBEDDING_PROVIDER: "openai" }),
    ).toThrow(/RAG_QUERY_EMBEDDING_PROVIDER/);
  });

  it("reports a missing credential alongside a missing connection string", () => {
    // Otherwise an operator fixes the token, redeploys, and only then learns the connection string
    // was missing too.
    expect(() => loadRagRetrievalConfig({ RAG_QUERY_EMBEDDING_PROVIDER: "huggingface" })).toThrow(
      /DATABASE_URL.*HF_TOKEN|HF_TOKEN.*DATABASE_URL/s,
    );
  });

  it("never includes the credential in a failure message", () => {
    let message = "";

    try {
      loadRagRetrievalConfig({
        DATABASE_URL,
        RAG_QUERY_EMBEDDING_PROVIDER: "huggingface",
        HF_TOKEN: "hf_retrieval-config-secret-never-real",
        HF_EMBEDDING_TIMEOUT_MS: "sofort",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("HF_EMBEDDING_TIMEOUT_MS");
    expect(message).not.toContain("hf_retrieval-config-secret-never-real");
  });
});

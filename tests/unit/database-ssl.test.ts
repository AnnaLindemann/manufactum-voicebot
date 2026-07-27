import { describe, expect, it } from "vitest";
import {
  databaseSslPoolOptions,
  resolveDatabaseSslConfig,
  type ReadCertificate,
} from "../../src/config/database-ssl.js";

/**
 * The certificate reader is injected, so these tests cover an unreadable path, a wrong file, and a
 * valid bundle without writing anything to disk and without shipping a certificate in the repository.
 */

const CA_BUNDLE =
  "-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----\n";

const readBundle: ReadCertificate = () => CA_BUNDLE;

const unreadable: ReadCertificate = (path) => {
  throw new Error(`ENOENT: no such file or directory, open '${path}'`);
};

function resolve(env: NodeJS.ProcessEnv, readCertificate: ReadCertificate = readBundle) {
  return resolveDatabaseSslConfig(env, readCertificate);
}

describe("resolveDatabaseSslConfig", () => {
  it("passes no ssl option at all when the mode is unset, leaving today's behaviour untouched", () => {
    const resolution = resolve({});

    expect(resolution).toEqual({ ok: true, config: { mode: "unset" } });
    // An explicit `ssl` key would override whatever `sslmode` DATABASE_URL carries, which would
    // silently change an existing deployment that never asked for anything.
    expect(databaseSslPoolOptions({ mode: "unset" })).toEqual({});
  });

  it("treats an empty or whitespace-only mode as unset rather than as an error", () => {
    // Clearing a variable in a platform's environment editor leaves an empty value behind.
    expect(resolve({ DATABASE_SSL_MODE: "   " })).toEqual({ ok: true, config: { mode: "unset" } });
  });

  it("configures plaintext explicitly under disable", () => {
    const resolution = resolve({ DATABASE_SSL_MODE: "disable" });

    expect(resolution).toEqual({ ok: true, config: { mode: "disable", ssl: false } });
    expect(databaseSslPoolOptions({ mode: "disable", ssl: false })).toEqual({ ssl: false });
  });

  it("encrypts without verifying under require, and never falls back to plaintext", () => {
    const resolution = resolve({ DATABASE_SSL_MODE: "require" });

    expect(resolution).toEqual({
      ok: true,
      config: { mode: "require", ssl: { rejectUnauthorized: false } },
    });
  });

  it("verifies against the supplied CA bundle under verify-full", () => {
    const resolution = resolve({
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_CA_CERT_PATH: "/etc/secrets/supabase-ca.crt",
    });

    expect(resolution).toEqual({
      ok: true,
      config: { mode: "verify-full", ssl: { rejectUnauthorized: true, ca: CA_BUNDLE } },
    });
  });

  it("fails when verify-full is requested without a CA path", () => {
    const resolution = resolve({ DATABASE_SSL_MODE: "verify-full" });

    // The alternative — quietly downgrading to an unverified connection — is the exact failure this
    // configuration exists to make impossible.
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("DATABASE_CA_CERT_PATH");
  });

  it("fails when the CA file cannot be read, rather than at the first TLS handshake", () => {
    const resolution = resolve(
      { DATABASE_SSL_MODE: "verify-full", DATABASE_CA_CERT_PATH: "/etc/secrets/missing.crt" },
      unreadable,
    );

    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("unreadable");
  });

  it("fails when the CA path points at something that is not a PEM bundle", () => {
    const resolution = resolve(
      { DATABASE_SSL_MODE: "verify-full", DATABASE_CA_CERT_PATH: "/etc/secrets/wrong.txt" },
      () => "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n",
    );

    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("PEM");
  });

  it("rejects an unknown mode instead of guessing what was meant", () => {
    const resolution = resolve({ DATABASE_SSL_MODE: "prefer" });

    // `prefer` and `allow` are "encrypt if it happens to work", which is the silent downgrade this
    // module exists to prevent, so they are not offered.
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.message).toContain("DATABASE_SSL_MODE");
  });

  it("never puts the certificate, its path, or the connection string into a failure message", () => {
    const resolutions = [
      resolve({ DATABASE_SSL_MODE: "sehr-sicher" }),
      resolve({ DATABASE_SSL_MODE: "verify-full" }),
      resolve(
        {
          DATABASE_SSL_MODE: "verify-full",
          DATABASE_CA_CERT_PATH: "/etc/secrets/prod-ca-2021.crt",
          DATABASE_URL: "postgres://rag:ssl-test-password-never-real@db.invalid:5432/rag",
        },
        unreadable,
      ),
    ];

    for (const resolution of resolutions) {
      const message = resolution.ok ? "" : resolution.message;
      expect(message).not.toContain("BEGIN CERTIFICATE");
      expect(message).not.toContain("/etc/secrets/");
      expect(message).not.toContain("ssl-test-password-never-real");
      expect(message).not.toContain("postgres://");
    }
  });
});

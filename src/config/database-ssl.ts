import { readFileSync } from "node:fs";

/**
 * Explicit TLS configuration for the RAG PostgreSQL connection.
 *
 * `DATABASE_URL` alone does not say how the connection is protected. `pg` decides that from whatever
 * `sslmode` the connection string happens to carry, which means a managed database reached over the
 * public internet can end up on an unverified — or entirely unencrypted — connection because one
 * query parameter was forgotten, and nothing in the process says so. A retrieval query carries no
 * secret, but the connection carries the database password on every handshake, so the transport is
 * worth configuring deliberately rather than inheriting.
 *
 * The mode is therefore its own variable, validated like every other piece of configuration, and the
 * CA certificate is supplied as a **path** rather than inline: Render mounts secret files at a path,
 * and a certificate pasted into an environment variable tends to lose its line breaks.
 *
 * Nothing here is ever logged. The error messages name variables, never a value, never the connection
 * string, and never a byte of the certificate.
 */

/**
 * `[D]` Deliberately the PostgreSQL `sslmode` vocabulary rather than a new spelling, so an operator
 * who knows `psql` or a managed provider's console already knows what these mean. The middle ground
 * (`prefer`, `allow`) is **not** offered: both are "encrypt if it happens to work", which is exactly
 * the silent downgrade this module exists to prevent.
 */
export const DATABASE_SSL_MODES = ["disable", "require", "verify-full"] as const;

export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

/**
 * What `pg` is told, as a discriminated union so a caller cannot construct a half-configured mode.
 *
 * `unset` is not a fourth mode — it is the absence of the variable, and it means "pass no `ssl`
 * option at all", which leaves the driver's own reading of `DATABASE_URL` exactly as it is today.
 * That is what keeps a local development database, reached over a loopback socket with no TLS at
 * all, working without a new mandatory variable.
 */
export type DatabaseSslConfig =
  | { mode: "unset" }
  | { mode: "disable"; ssl: false }
  | { mode: "require"; ssl: { rejectUnauthorized: false } }
  | { mode: "verify-full"; ssl: { rejectUnauthorized: true; ca: string } };

export type DatabaseSslResolution =
  | { ok: true; config: DatabaseSslConfig }
  /** Names the offending variables only, in the same style as the other configuration loaders. */
  | { ok: false; message: string };

/** Injectable so a test can drive an unreadable path without creating one on disk. */
export type ReadCertificate = (path: string) => string;

/**
 * A PEM bundle must contain at least one certificate block. Checking for the header catches the
 * common misconfiguration — a path pointing at a private key, an empty secret file, or an HTML error
 * page saved by a browser — at startup rather than at the first connection attempt, where it would
 * surface as an opaque TLS handshake failure inside a request.
 */
const PEM_CERTIFICATE_HEADER = "-----BEGIN CERTIFICATE-----";

export function resolveDatabaseSslConfig(
  env: NodeJS.ProcessEnv = process.env,
  readCertificate: ReadCertificate = (path) => readFileSync(path, "utf8"),
): DatabaseSslResolution {
  const mode = nonEmpty(env.DATABASE_SSL_MODE);
  const caCertPath = nonEmpty(env.DATABASE_CA_CERT_PATH);

  if (mode === undefined) {
    return { ok: true, config: { mode: "unset" } };
  }

  if (!isDatabaseSslMode(mode)) {
    return {
      ok: false,
      message: `DATABASE_SSL_MODE (must be one of ${DATABASE_SSL_MODES.join(", ")})`,
    };
  }

  if (mode === "disable") {
    return { ok: true, config: { mode, ssl: false } };
  }

  if (mode === "require") {
    // Encrypted but **not** authenticated: the server certificate is accepted without being checked
    // against a CA, so this stops passive eavesdropping and not an active man in the middle. It is a
    // documented stopgap for a provider whose CA bundle is not yet on the host, never a production
    // setting. It is still an unambiguous request for TLS, so it never falls back to plaintext.
    return { ok: true, config: { mode, ssl: { rejectUnauthorized: false } } };
  }

  if (caCertPath === undefined) {
    return {
      ok: false,
      message: "DATABASE_CA_CERT_PATH (required when DATABASE_SSL_MODE is verify-full)",
    };
  }

  let certificate: string;

  try {
    certificate = readCertificate(caCertPath);
  } catch {
    // The thrown error is swallowed on purpose: its message quotes the path, and a path is operator
    // configuration that has no business in a startup log line that platforms retain.
    return {
      ok: false,
      message: "DATABASE_CA_CERT_PATH (file is missing or unreadable)",
    };
  }

  if (!certificate.includes(PEM_CERTIFICATE_HEADER)) {
    return {
      ok: false,
      message: "DATABASE_CA_CERT_PATH (file is not a PEM certificate bundle)",
    };
  }

  return { ok: true, config: { mode, ssl: { rejectUnauthorized: true, ca: certificate } } };
}

/**
 * The `pg.Pool` options fragment for a resolved mode, spread by the caller.
 *
 * Returns an **empty** object for `unset`, rather than `{ ssl: undefined }`: an explicit `ssl` key
 * overrides whatever `sslmode` the connection string carries, so passing one when no mode was chosen
 * would silently change the behaviour of an existing deployment.
 */
export function databaseSslPoolOptions(
  config: DatabaseSslConfig,
): Record<string, never> | { ssl: false | { rejectUnauthorized: boolean; ca?: string } } {
  return config.mode === "unset" ? {} : { ssl: config.ssl };
}

function isDatabaseSslMode(value: string): value is DatabaseSslMode {
  return (DATABASE_SSL_MODES as readonly string[]).includes(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

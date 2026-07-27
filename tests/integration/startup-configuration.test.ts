import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Startup configuration validation, added for the Test Deployment checkpoint.
 *
 * `process.exit` cannot be observed in-process, so these tests run the real entry point as a child
 * process. `DOTENV_CONFIG_PATH` points at a file that does not exist, so a developer's local `.env`
 * cannot supply the very variables a test is asserting are missing.
 */

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

/**
 * The connection string is never opened: the startup check validates presence and shape only, so a
 * host that does not exist is exactly what this test wants. Its password is deliberately distinctive
 * so a test can assert it never reaches the startup log.
 */
const TEST_DATABASE_URL = "postgres://rag:test-db-password-never-real@db.invalid:5432/rag_startup";

const COMPLETE_ENV = {
  MANUFACTUM_API_BASE_URL: "https://upstream.test",
  MANUFACTUM_API_KEY: "test-api-key-never-real",
  MANUFACTUM_API_KEY_HEADER: "x-api-key",
  DATABASE_URL: TEST_DATABASE_URL,
} satisfies NodeJS.ProcessEnv;

type StartupResult = { exitCode: number | null; output: string };

/**
 * A port the OS has just confirmed is free.
 *
 * `PORT=0` would be the obvious way to say "any free port", and it is what this suite used to pass —
 * but `0` is now a rejected configuration value, deliberately: it is how a cleared or malformed
 * `PORT` used to slip through and produce a service listening where nothing could reach it. Binding a
 * throwaway server and reading back the assigned number gives the same collision-free behaviour while
 * passing the kind of value a real deployment passes.
 */
function reserveFreePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();

      if (address === null || typeof address === "string") {
        probe.close(() => {
          reject(new Error("Could not reserve a free port for the startup test."));
        });
        return;
      }

      probe.close(() => {
        resolve(String(address.port));
      });
    });
  });
}

/** A PEM-shaped file on disk, so the verified-TLS success path is exercised without shipping a CA. */
function writeCertificateFixture(contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "rag-startup-ca-"));
  const file = path.join(directory, "ca.crt");
  writeFileSync(file, contents);
  return file;
}

const CA_BUNDLE_FIXTURE =
  "-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----\n";

async function startServer(env: NodeJS.ProcessEnv): Promise<StartupResult> {
  // Supplied first, so a case that is *about* `PORT` can override it with the offending value.
  return await spawnServer({ PORT: await reserveFreePort(), ...env });
}

function spawnServer(env: NodeJS.ProcessEnv): Promise<StartupResult> {
  return new Promise((resolve) => {
    const child = spawn(TSX, ["src/server.ts"], {
      cwd: REPO_ROOT,
      // `tsx` runs the real work in a child of its own. Its own process group lets a successful
      // start be torn down as a whole; killing only `tsx` would leave that grandchild holding the
      // stdout pipe open, and `close` would never fire.
      detached: true,
      env: {
        PATH: process.env.PATH,
        // A path that cannot exist, so no local `.env` is read.
        DOTENV_CONFIG_PATH: path.join(REPO_ROOT, "does-not-exist.env"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;

    function settle(exitCode: number | null): void {
      if (!settled) {
        settled = true;
        resolve({ exitCode, output });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();

      // A server that starts successfully never exits on its own, so resolve on the listening line
      // and tear the whole process group down rather than waiting for an exit that will not come.
      if (output.includes("listening") && child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
        settle(null);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    // A failing start exits on its own, taking its group with it.
    child.on("close", (exitCode) => {
      settle(exitCode);
    });
  });
}

describe("server startup configuration check", () => {
  it.each([
    "MANUFACTUM_API_BASE_URL",
    "MANUFACTUM_API_KEY",
    "MANUFACTUM_API_KEY_HEADER",
    "DATABASE_URL",
  ])(
    "exits non-zero when %s is missing, rather than booting and reporting healthy",
    async (variable) => {
      const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV };
      delete env[variable];

      const { exitCode, output } = await startServer(env);

      // Before this check a misconfigured release booted, answered /health with 200, and the
      // platform called it healthy; the fault surfaced only on the first caller's INTERNAL_ERROR.
      expect(exitCode).toBe(1);
      expect(output).toContain("startup_configuration_invalid");
      expect(output).toContain(variable);
      expect(output).not.toContain("listening");
    },
    20_000,
  );

  it("exits non-zero when the timeout is set but malformed", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      MANUFACTUM_API_TIMEOUT_MS: "soon",
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("MANUFACTUM_API_TIMEOUT_MS");
  }, 20_000);

  it("exits non-zero when the retrieval threshold is set but malformed", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      RAG_RETRIEVAL_MIN_SCORE: "very-relevant",
    });

    // A malformed threshold must not silently fall back to the default: retrieval would then run at
    // a relevance bar nobody chose, and every answer it accepted would look normal.
    expect(exitCode).toBe(1);
    expect(output).toContain("RAG_RETRIEVAL_MIN_SCORE");
  }, 20_000);

  it("exits non-zero when the retrieval threshold is out of range", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      RAG_RETRIEVAL_MIN_SCORE: "1.5",
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("RAG_RETRIEVAL_MIN_SCORE");
  }, 20_000);

  it("reports every misconfigured capability at once, not just the first", async () => {
    const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV, RAG_RETRIEVAL_MIN_SCORE: "sehr" };
    delete env.MANUFACTUM_API_BASE_URL;

    const { exitCode, output } = await startServer(env);

    // Otherwise an operator fixes one variable, redeploys, and discovers the next one only then.
    expect(exitCode).toBe(1);
    expect(output).toContain("MANUFACTUM_API_BASE_URL");
    expect(output).toContain("RAG_RETRIEVAL_MIN_SCORE");
  }, 20_000);

  it("never prints a secret while reporting a configuration failure", async () => {
    const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV };
    delete env.MANUFACTUM_API_BASE_URL;

    const { output } = await startServer(env);

    // The startup log is the newest place a secret could escape into a platform's log stream. The
    // connection string matters as much as the API key: it carries a database password.
    expect(output).not.toContain(COMPLETE_ENV.MANUFACTUM_API_KEY);
    expect(output).not.toContain("test-db-password-never-real");
  }, 20_000);

  it("never prints the connection string when the database configuration is what failed", async () => {
    const { output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_URL: "   ",
      RAG_RETRIEVAL_MIN_SCORE: "nope",
    });

    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain("test-db-password-never-real");
  }, 20_000);

  it("starts and listens when the configuration is complete", async () => {
    const { output } = await startServer(COMPLETE_ENV);

    expect(output).toContain("listening");
    expect(output).not.toContain("startup_configuration_invalid");
  }, 20_000);
});

describe("server startup PORT validation", () => {
  it.each([
    ["zero", "0"],
    ["a negative port", "-1"],
    ["a port above the TCP range", "65536"],
    ["a typo with a letter O", "8O80"],
    // An empty value is deliberately *not* here: it is treated as unset and takes the documented
    // default, exactly like every other optional variable in this codebase. See `port-config.ts`.
  ])(
    "exits non-zero when PORT is %s",
    async (_label, value) => {
      const { exitCode, output } = await startServer({ ...COMPLETE_ENV, PORT: value });

      // `0` and `NaN` both mean "bind an OS-assigned ephemeral port" to Node, so each of these used to
      // produce a live process listening where nothing was configured to reach it.
      expect(exitCode).toBe(1);
      expect(output).toContain("startup_configuration_invalid");
      expect(output).toContain("PORT");
      expect(output).not.toContain("listening");
    },
    20_000,
  );

  it("still reports the other misconfigured variables alongside an invalid PORT", async () => {
    const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV, PORT: "auto" };
    delete env.MANUFACTUM_API_KEY;

    const { exitCode, output } = await startServer(env);

    expect(exitCode).toBe(1);
    expect(output).toContain("PORT");
    expect(output).toContain("MANUFACTUM_API_KEY");
  }, 20_000);
});

describe("server startup database TLS validation", () => {
  it("exits non-zero when verified TLS is requested without a CA path", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_SSL_MODE: "verify-full",
    });

    // The alternative is a release that boots and connects unverified, which is precisely what
    // asking for `verify-full` was meant to rule out.
    expect(exitCode).toBe(1);
    expect(output).toContain("DATABASE_CA_CERT_PATH");
  }, 20_000);

  it("exits non-zero when the CA file cannot be read", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_CA_CERT_PATH: path.join(REPO_ROOT, "does-not-exist-ca.crt"),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("DATABASE_CA_CERT_PATH");
  }, 20_000);

  it("exits non-zero for an unknown SSL mode instead of guessing", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_SSL_MODE: "prefer",
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("DATABASE_SSL_MODE");
  }, 20_000);

  it("starts with verified TLS configured and a readable CA bundle", async () => {
    const { output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_CA_CERT_PATH: writeCertificateFixture(CA_BUNDLE_FIXTURE),
    });

    // Still no connection is opened: the check reads the certificate and stops there.
    expect(output).toContain("listening");
    expect(output).not.toContain("startup_configuration_invalid");
  }, 20_000);

  it("never prints the certificate or the connection string while validating TLS", async () => {
    const { output } = await startServer({
      ...COMPLETE_ENV,
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_CA_CERT_PATH: writeCertificateFixture("this file is not a certificate"),
    });

    expect(output).toContain("DATABASE_CA_CERT_PATH");
    expect(output).not.toContain("this file is not a certificate");
    expect(output).not.toContain("test-db-password-never-real");
  }, 20_000);
});

describe("server startup RAG rate-limit validation", () => {
  it.each(["RAG_RATE_LIMIT_MAX_REQUESTS", "RAG_RATE_LIMIT_WINDOW_MS"])(
    "exits non-zero when %s is set but malformed",
    async (variable) => {
      const { exitCode, output } = await startServer({ ...COMPLETE_ENV, [variable]: "viel" });

      // Read lazily at the first request, so without this check a malformed limit would surface as an
      // INTERNAL_ERROR on someone's first RAG query rather than as a failed deploy.
      expect(exitCode).toBe(1);
      expect(output).toContain(variable);
    },
    20_000,
  );

  it("exits non-zero when the limit is set to zero, which would switch the control off", async () => {
    const { exitCode, output } = await startServer({
      ...COMPLETE_ENV,
      RAG_RATE_LIMIT_MAX_REQUESTS: "0",
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("RAG_RATE_LIMIT_MAX_REQUESTS");
  }, 20_000);

  it("starts with a tightened but valid limit", async () => {
    const { output } = await startServer({
      ...COMPLETE_ENV,
      RAG_RATE_LIMIT_MAX_REQUESTS: "5",
      RAG_RATE_LIMIT_WINDOW_MS: "30000",
    });

    expect(output).toContain("listening");
  }, 20_000);
});

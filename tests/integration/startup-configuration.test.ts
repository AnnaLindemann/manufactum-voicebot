import { spawn } from "node:child_process";
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

const COMPLETE_ENV = {
  MANUFACTUM_API_BASE_URL: "https://upstream.test",
  MANUFACTUM_API_KEY: "test-api-key-never-real",
  MANUFACTUM_API_KEY_HEADER: "x-api-key",
} satisfies NodeJS.ProcessEnv;

type StartupResult = { exitCode: number | null; output: string };

function startServer(env: NodeJS.ProcessEnv): Promise<StartupResult> {
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
        // Port 0 asks the OS for a free port, so a successful start cannot collide with a
        // development server already listening on 3000.
        PORT: "0",
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
  it.each(["MANUFACTUM_API_BASE_URL", "MANUFACTUM_API_KEY", "MANUFACTUM_API_KEY_HEADER"])(
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

  it("never prints the API key while reporting a configuration failure", async () => {
    const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV };
    delete env.MANUFACTUM_API_BASE_URL;

    const { output } = await startServer(env);

    // The startup log is the newest place a secret could escape into a platform's log stream.
    expect(output).not.toContain(COMPLETE_ENV.MANUFACTUM_API_KEY);
  }, 20_000);

  it("starts and listens when the configuration is complete", async () => {
    const { output } = await startServer(COMPLETE_ENV);

    expect(output).toContain("listening");
    expect(output).not.toContain("startup_configuration_invalid");
  }, 20_000);
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  loadManufactumConfig,
} from "../../src/config/manufactum-config.js";

const VALID_ENV = {
  MANUFACTUM_API_BASE_URL: "https://upstream.test",
  MANUFACTUM_API_KEY: "test-api-key-never-real",
  MANUFACTUM_API_KEY_HEADER: "x-api-key",
} satisfies NodeJS.ProcessEnv;

describe("loadManufactumConfig", () => {
  it("defaults the upstream timeout to 8 seconds", () => {
    // Raised from 5 s in the Phase 3 review: an observed cold upstream call took 4431 ms.
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(8_000);
    expect(loadManufactumConfig(VALID_ENV).timeoutMs).toBe(8_000);
  });

  it.each(["", "   "])("falls back to the default when the timeout variable is %o", (value) => {
    expect(loadManufactumConfig({ ...VALID_ENV, MANUFACTUM_API_TIMEOUT_MS: value }).timeoutMs).toBe(
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    );
  });

  it("allows an environment to override the timeout", () => {
    expect(
      loadManufactumConfig({ ...VALID_ENV, MANUFACTUM_API_TIMEOUT_MS: "12000" }).timeoutMs,
    ).toBe(12_000);
  });

  it.each(["abc", "0", "-1", "1.5"])(
    "rejects the malformed timeout %o rather than silently defaulting",
    (value) => {
      expect(() =>
        loadManufactumConfig({ ...VALID_ENV, MANUFACTUM_API_TIMEOUT_MS: value }),
      ).toThrowError(/MANUFACTUM_API_TIMEOUT_MS/);
    },
  );

  it.each(["MANUFACTUM_API_BASE_URL", "MANUFACTUM_API_KEY", "MANUFACTUM_API_KEY_HEADER"])(
    "names the missing variable %s without revealing any value",
    (variable) => {
      const env: NodeJS.ProcessEnv = { ...VALID_ENV };
      delete env[variable];

      try {
        loadManufactumConfig(env);
        expect.unreachable("expected a configuration error");
      } catch (error) {
        const message = (error as Error).message;

        expect(message).toContain(variable);
        // The API key must never appear in a configuration error message.
        expect(message).not.toContain(VALID_ENV.MANUFACTUM_API_KEY);
      }
    },
  );
});

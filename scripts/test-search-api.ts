import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_QUERY = "senf";
const DEFAULT_WAREHOUSE = "493024033844";
const DEFAULT_LIMIT = "2";
const TIMEOUT_MS = 10_000;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        const isSensitive = /api.?key|authorization|token|cookie|password/i.test(key);

        return [key, isSensitive ? "[REDACTED]" : redact(entryValue)];
      }),
    );
  }

  return value;
}

async function main(): Promise<void> {
  const baseUrl = getRequiredEnv("MANUFACTUM_API_BASE_URL");
  const apiKey = getRequiredEnv("MANUFACTUM_API_KEY");
  const apiKeyHeader = getRequiredEnv("MANUFACTUM_API_KEY_HEADER");

  const query = process.argv[2] ?? DEFAULT_QUERY;
  const warehouse = process.argv[3] ?? DEFAULT_WAREHOUSE;
  const limit = process.argv[4] ?? DEFAULT_LIMIT;

  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("warehouse", warehouse);
  url.searchParams.set("limit", limit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        [apiKeyHeader]: apiKey,
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();

    let body: unknown;

    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error("The API response was not valid JSON.");
    }

    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(JSON.stringify(body, null, 2));

    const sample = {
      request: {
        method: "GET",
        url: url.toString(),
        headers: {
          [apiKeyHeader]: "[REDACTED]",
        },
      },
      response: {
        status: response.status,
        body: redact(body),
      },
    };

    const samplesDirectory = path.join("docs", "api-samples");
    const samplePath = path.join(samplesDirectory, "search-response.redacted.json");

    await mkdir(samplesDirectory, { recursive: true });
    await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);

    console.log(`Redacted sample saved: ${samplePath}`);
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown API discovery error.";

  console.error(`Discovery request failed: ${message}`);
  process.exitCode = 1;
});

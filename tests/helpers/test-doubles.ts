import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type ManufactumConfig,
} from "../../src/config/manufactum-config.js";
import type { LogFields, Logger } from "../../src/logging/logger.js";
import {
  createRequestContext,
  type RequestContext,
} from "../../src/observability/request-context.js";

/** Captures log entries so tests can assert on what is logged and, crucially, on what is not. */
export type RecordingLogger = Logger & {
  entries: { level: string; event: string; fields: LogFields }[];
};

export function createRecordingLogger(): RecordingLogger {
  const entries: RecordingLogger["entries"] = [];

  return {
    entries,
    info: (event, fields) => entries.push({ level: "info", event, fields }),
    warn: (event, fields) => entries.push({ level: "warn", event, fields }),
    error: (event, fields) => entries.push({ level: "error", event, fields }),
  };
}

export const TEST_CONFIG: ManufactumConfig = {
  baseUrl: "https://upstream.test",
  apiKey: "test-api-key-never-real",
  apiKeyHeader: "x-api-key",
  timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
};

/** A request context that captures every upstream latency the integration layer reports. */
export type RecordingContext = RequestContext & { recordedUpstreamLatencies: number[] };

export function createRecordingContext(correlationId = "cid"): RecordingContext {
  const recordedUpstreamLatencies: number[] = [];

  return {
    ...createRequestContext(correlationId, (ms) => recordedUpstreamLatencies.push(ms)),
    recordedUpstreamLatencies,
  };
}

/** A `fetch` stand-in that records its calls and returns a canned response. */
export function createFetchStub(response: Response | (() => Promise<Response>)): {
  fetchImplementation: typeof fetch;
  calls: { url: URL; init: RequestInit | undefined }[];
} {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];

  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });

    // Cloned per call: a Response body can only be consumed once.
    return typeof response === "function" ? await response() : response.clone();
  }) as typeof fetch;

  return { fetchImplementation, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RedactedSample = {
  response: { status: number; body: unknown };
};

/** The stored redacted Phase 1 sample, used by the contract tests. */
export async function loadRedactedSample(): Promise<RedactedSample> {
  const samplePath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "docs",
    "api-samples",
    "search-response.redacted.json",
  );

  return JSON.parse(await readFile(samplePath, "utf8")) as RedactedSample;
}

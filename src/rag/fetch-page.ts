import { FaqFetchError } from "./errors.js";

/**
 * Downloads one approved public page over a plain HTTP GET using native `fetch`.
 *
 * Networking only: it returns the raw HTML string and knows nothing about FAQ structure, so the
 * pure extraction logic in `extract-faq.ts` stays network-free and its tests need no HTTP. The PoC
 * confirmed the target pages are server-rendered and reachable with an ordinary GET, so no headless
 * browser is involved.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A realistic browser `User-Agent` and `Accept-Language: de-DE` were confirmed sufficient in the
 * PoC; no cookies, tokens, or JavaScript execution are required.
 */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9",
};

export type FetchPageDependencies = {
  /** Injectable so tests can drive the fetch without a real network call. */
  fetchImplementation: typeof fetch;
  timeoutMs: number;
};

export async function fetchPage(
  url: string,
  dependencies: Partial<FetchPageDependencies> = {},
): Promise<string> {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;

  try {
    response = await fetchImplementation(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // A timeout and a connection failure are indistinguishable here and neither is a page-structure
    // problem, so they share one transport error with no status.
    throw new FaqFetchError(cause instanceof Error ? cause.message : `Failed to fetch ${url}.`);
  }

  if (!response.ok) {
    throw new FaqFetchError(
      `Unexpected HTTP status ${response.status} for ${url}.`,
      response.status,
    );
  }

  // A 200 response carrying a non-HTML body (a JSON error page, a PDF, a redirect stub) is a
  // controlled failure for an ingestion job: fail here deterministically rather than hand non-HTML
  // to the extractor. `text/html; charset=utf-8` and other parameterised values are accepted.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new FaqFetchError(
      `Unexpected content-type "${contentType}" for ${url}; expected text/html.`,
      response.status,
    );
  }

  return response.text();
}

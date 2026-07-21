/**
 * Errors for the RAG extraction pipeline.
 *
 * This is offline ingestion, not a customer-facing request, so it deliberately does **not** reuse
 * `AppError` from `src/errors/app-error.ts`: that model carries HTTP statuses and spoken German
 * customer messages that have no meaning for a crawl job. Keeping a separate error type also leaves
 * the product-search error model untouched.
 */

/** A page could not be extracted because its structure was missing or unsupported. */
export class FaqExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqExtractionError";
  }
}

/** A page could not be downloaded. Networking concern only, kept out of the extraction logic. */
export class FaqFetchError extends Error {
  /** The upstream HTTP status when the failure was a non-2xx response; `null` for transport errors. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "FaqFetchError";
    this.status = status;
  }
}

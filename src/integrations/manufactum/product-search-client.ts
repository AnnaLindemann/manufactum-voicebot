import { loadManufactumConfig, type ManufactumConfig } from "../../config/manufactum-config.js";
import type { ProductSearchQuery, ProductSearchResult } from "../../domain/product-search.js";
import { AppError } from "../../errors/app-error.js";
import type { Logger } from "../../logging/logger.js";
import type { RequestContext } from "../../observability/request-context.js";
import { mapSearchResponse } from "./mapper.js";
import { upstreamSearchResponseSchema } from "./upstream-schema.js";

/**
 * Client for the one observed upstream endpoint, `GET /search`.
 *
 * It fetches, validates, and maps, so no raw upstream type leaves this layer. Upstream status codes
 * and upstream bodies are translated into the agreed error codes and never forwarded.
 */

export type ProductSearchClient = (
  request: ProductSearchQuery,
  context: RequestContext,
) => Promise<ProductSearchResult>;

type ClientDependencies = {
  loadConfig?: () => ManufactumConfig;
  fetchImplementation?: typeof fetch;
  logger: Logger;
};

function buildUrl(config: ManufactumConfig, request: ProductSearchQuery): URL {
  const url = new URL("/search", config.baseUrl);

  url.searchParams.set("q", request.q);
  // Always sent explicitly, including at its default, so the result count never depends on an
  // unobserved upstream default.
  url.searchParams.set("limit", String(request.limit));

  if (request.warehouseId !== undefined) {
    // Passed through verbatim; the MVP performs no phone-number normalization.
    url.searchParams.set("warehouse", request.warehouseId);
  }

  return url;
}

/**
 * Translates an upstream HTTP status into the agreed internal error code. The upstream status is
 * logged, never forwarded: the internal status set is fixed at {200, 400, 404, 500, 502, 504}.
 */
function errorForUpstreamStatus(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError("UPSTREAM_AUTH_FAILED", `Upstream rejected authentication (${status}).`);
  }

  if (status === 400) {
    // Should be unreachable: internal validation is stricter than the observed upstream validation.
    // If it happens, the internal schema and the upstream contract have diverged — a backend defect.
    return new AppError(
      "UPSTREAM_REJECTED_REQUEST",
      "Upstream returned 400; internal request validation and the upstream contract have diverged.",
    );
  }

  return new AppError("UPSTREAM_UNAVAILABLE", `Unexpected upstream status ${status}.`);
}

export function createProductSearchClient({
  loadConfig = loadManufactumConfig,
  fetchImplementation = fetch,
  logger,
}: ClientDependencies): ProductSearchClient {
  return async function searchProducts(request, context) {
    const { correlationId } = context;
    const config = loadConfig();
    const url = buildUrl(config, request);
    const startedAt = Date.now();

    let response: Response;

    try {
      response = await fetchImplementation(url, {
        headers: { [config.apiKeyHeader]: config.apiKey },
        // The one timeout value, taken from configuration; see `DEFAULT_UPSTREAM_TIMEOUT_MS`.
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (cause) {
      // A timeout and a connection failure are indistinguishable to a caller and are both
      // retryable, so they share one code.
      const error = new AppError(
        "UPSTREAM_TIMEOUT",
        cause instanceof Error ? cause.message : "Upstream request failed.",
      );

      const upstreamLatencyMs = Date.now() - startedAt;
      context.recordUpstreamLatency(upstreamLatencyMs);

      logger.warn("upstream_request_failed", {
        correlationId,
        endpoint: "GET /search",
        upstreamLatencyMs,
        errorCode: error.code,
        message: error.message,
      });

      throw error;
    }

    // Measured at response headers: the body read, schema validation, and mapping that follow are
    // backend time, not upstream time, and are reflected in requestLatencyMs instead.
    const upstreamLatencyMs = Date.now() - startedAt;
    context.recordUpstreamLatency(upstreamLatencyMs);

    if (!response.ok) {
      const error = errorForUpstreamStatus(response.status);

      // The upstream body is deliberately neither read into the log nor forwarded.
      logger.warn("upstream_request_rejected", {
        correlationId,
        endpoint: "GET /search",
        upstreamStatus: response.status,
        upstreamLatencyMs,
        errorCode: error.code,
        message: error.message,
      });

      throw error;
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      const error = new AppError("UPSTREAM_INVALID_RESPONSE", "Upstream body was not valid JSON.");

      logger.error("upstream_invalid_response", {
        correlationId,
        endpoint: "GET /search",
        upstreamStatus: response.status,
        upstreamLatencyMs,
        errorCode: error.code,
        message: error.message,
      });

      throw error;
    }

    // Validated, never cast. A missing or wrongly typed mapped field rejects the whole response
    // rather than emitting a partially populated product.
    const parsed = upstreamSearchResponseSchema.safeParse(body);

    if (!parsed.success) {
      const error = new AppError(
        "UPSTREAM_INVALID_RESPONSE",
        "Upstream body failed the upstream schema.",
      );

      logger.error("upstream_invalid_response", {
        correlationId,
        endpoint: "GET /search",
        upstreamStatus: response.status,
        upstreamLatencyMs,
        errorCode: error.code,
        message: error.message,
      });

      throw error;
    }

    const { result, unmappedUpstreamStatuses } = mapSearchResponse(parsed.data);

    if (unmappedUpstreamStatuses.length > 0) {
      logger.warn("upstream_status_unmapped", {
        correlationId,
        endpoint: "GET /search",
        upstreamStatus: response.status,
        unmappedUpstreamStatuses,
        message: "Unrecognized upstream availability status mapped to unknown.",
      });
    }

    logger.info("upstream_request_completed", {
      correlationId,
      endpoint: "GET /search",
      upstreamStatus: response.status,
      upstreamLatencyMs,
      resultCount: result.resultCount,
    });

    return result;
  };
}

import type { NextFunction, Request, Response } from "express";
import { getCorrelationId } from "./correlation-id.js";
import type { Logger } from "../logging/logger.js";

/**
 * One structured line per completed request: correlation ID, endpoint, total handling time, and —
 * when the request failed — the error code recorded by the error middleware.
 *
 * `requestLatencyMs` covers request entry to response completion. When an upstream call was made,
 * `upstreamLatencyMs` is reported alongside it, so one line shows both the Manufactum portion and
 * the whole, and their difference is the backend's own overhead.
 *
 * Query values are deliberately not logged. `q` is caller-spoken text, and the contract keeps
 * personal data out of logs.
 */
export function createRequestLogger(logger: Logger) {
  return function requestLogger(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();

    response.on("finish", () => {
      const { errorCode, upstreamLatencyMs } = response.locals;

      logger.info("request_completed", {
        correlationId: getCorrelationId(response),
        endpoint: `${request.method} ${request.path}`,
        requestLatencyMs: Date.now() - startedAt,
        ...(upstreamLatencyMs === undefined ? {} : { upstreamLatencyMs }),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    });

    next();
  };
}

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import "./locals.js";

/**
 * Correlation-ID handling, required with the first API route by `D-012`.
 *
 * The ID is taken from the inbound `x-correlation-id` header when present and generated otherwise,
 * and it is echoed in the response header and in the error envelope so a customer-reported failure
 * is traceable to its logs.
 */

/**
 * Exactly one inbound header is honoured. `x-request-id` was also accepted in the first draft; the
 * Phase 3 review removed it, because two accepted spellings mean two things a caller can send and
 * two things an operator must check when tracing a reported failure.
 */
const INBOUND_HEADER = "x-correlation-id";
const MAX_INBOUND_LENGTH = 128;

/** An inbound value is bounded and stripped of control characters before it reaches a log line. */
function readInboundCorrelationId(request: Request): string | null {
  const value = request.get(INBOUND_HEADER)?.trim();

  if (value === undefined || value.length === 0 || value.length > MAX_INBOUND_LENGTH) {
    return null;
  }

  const sanitized = value.replace(/[^\w.:-]/g, "");

  return sanitized.length > 0 ? sanitized : null;
}

export function correlationIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const correlationId = readInboundCorrelationId(request) ?? randomUUID();

  response.locals.correlationId = correlationId;
  response.setHeader(INBOUND_HEADER, correlationId);

  next();
}

/** Falls back to a generated ID so a log line or envelope is never left without one. */
export function getCorrelationId(response: Response): string {
  return response.locals.correlationId ?? randomUUID();
}

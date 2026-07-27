import type { NextFunction, Request, Response } from "express";
import { AppError, toErrorEnvelope } from "../errors/app-error.js";
import { getCorrelationId } from "./correlation-id.js";
import type { Logger } from "../logging/logger.js";
import "./locals.js";

/**
 * The 404 handler and the central error middleware required with the first API route by `D-012`.
 *
 * Every non-2xx response leaves through here, so the envelope shape is enforced in one place and no
 * upstream status code, upstream body, or internal stack trace can reach a caller.
 */

export function notFoundHandler(_request: Request, _response: Response, next: NextFunction): void {
  next(new AppError("NOT_FOUND", "Unknown internal route."));
}

/**
 * The closed set of `body-parser` failure types. A request body that is unparseable, oversized, or
 * unsupported is a **caller** mistake, so it must produce `INVALID_REQUEST` with HTTP `400` like every
 * other rejected input — not the `INTERNAL_ERROR` it would otherwise become by falling through as an
 * unrecognized throw, which would blame the backend for a malformed request and mark it non-retryable
 * for the wrong reason.
 */
const BODY_PARSER_ERROR_TYPES = new Set([
  "encoding.unsupported",
  "entity.parse.failed",
  "entity.too.large",
  "entity.verify.failed",
  "parameters.too.many",
  "request.aborted",
  "request.size.invalid",
  "stream.encoding.set",
  "stream.not.readable",
]);

/**
 * Only the fixed `type` discriminator is used. The parser's own message can quote the offending body
 * text, so it is never carried into the technical message and never logged.
 */
function bodyParserRejection(error: unknown): AppError | null {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return null;
  }

  const { type } = error;

  return typeof type === "string" && BODY_PARSER_ERROR_TYPES.has(type)
    ? new AppError("INVALID_REQUEST", `Malformed request body (${type}).`)
    : null;
}

export function createErrorMiddleware(logger: Logger) {
  return function errorMiddleware(
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    // Express cannot amend a response whose headers are already sent; delegating lets it close the
    // connection rather than throwing on a second write.
    if (response.headersSent) {
      next(error);
      return;
    }

    // An unexpected throw becomes INTERNAL_ERROR. Its message stays in logs only.
    const appError =
      error instanceof AppError
        ? error
        : (bodyParserRejection(error) ??
          new AppError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Unhandled internal exception.",
          ));

    const correlationId = getCorrelationId(response);

    response.locals.errorCode = appError.code;

    // Only errors not already logged at their source are logged here with a technical message.
    logger.error("request_failed", {
      correlationId,
      errorCode: appError.code,
      message: appError.message,
    });

    response.status(appError.status).json(toErrorEnvelope(appError, correlationId));
  };
}

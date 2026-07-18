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
        : new AppError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Unhandled internal exception.",
          );

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

import express, { type Express } from "express";
import { correlationIdMiddleware } from "./http/correlation-id.js";
import { createErrorMiddleware, notFoundHandler } from "./http/error-middleware.js";
import { createProductSearchRouter } from "./http/product-search-route.js";
import { createRequestLogger } from "./http/request-logger.js";
import { createProductSearchClient } from "./integrations/manufactum/product-search-client.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import {
  createProductSearchService,
  type ProductSearchService,
} from "./services/product-search-service.js";

export type AppDependencies = {
  logger?: Logger;
  /** Injectable so integration tests can drive the route without a real upstream call. */
  productSearchService?: ProductSearchService;
};

export function createApp({
  logger = consoleLogger,
  productSearchService,
}: AppDependencies = {}): Express {
  const searchProducts =
    productSearchService ?? createProductSearchService(createProductSearchClient({ logger }));

  const app = express();

  // Correlation ID first, so every log line and every error envelope carries one.
  app.use(correlationIdMiddleware);
  app.use(createRequestLogger(logger));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.use(createProductSearchRouter(searchProducts));

  // Last: an unmatched route becomes the NOT_FOUND envelope rather than Express's HTML default.
  app.use(notFoundHandler);
  app.use(createErrorMiddleware(logger));

  return app;
}

export const app = createApp();

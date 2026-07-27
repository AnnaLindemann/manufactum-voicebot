import express, { type Express, type RequestHandler } from "express";
import { correlationIdMiddleware } from "./http/correlation-id.js";
import { createErrorMiddleware, notFoundHandler } from "./http/error-middleware.js";
import { createProductSearchRouter } from "./http/product-search-route.js";
import { createRagQueryRouter } from "./http/rag-query-route.js";
import { createRateLimiter } from "./http/rate-limit.js";
import { createRequestLogger } from "./http/request-logger.js";
import { createProductSearchClient } from "./integrations/manufactum/product-search-client.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import { createDefaultRagRetrievalDependencies } from "./rag/rag-retrieval-dependencies.js";
import {
  createProductSearchService,
  type ProductSearchService,
} from "./services/product-search-service.js";
import { createRagQueryService, type RagQueryService } from "./services/rag-query-service.js";

export type AppDependencies = {
  logger?: Logger;
  /** Injectable so integration tests can drive the route without a real upstream call. */
  productSearchService?: ProductSearchService;
  /** Injectable so integration tests can drive the route without a database or an embedding model. */
  ragQueryService?: RagQueryService;
  /** Injectable so tests can drive the limiter on a controlled clock. */
  rateLimiter?: RequestHandler;
};

export function createApp({
  logger = consoleLogger,
  productSearchService,
  ragQueryService,
  rateLimiter = createRateLimiter(),
}: AppDependencies = {}): Express {
  const searchProducts =
    productSearchService ?? createProductSearchService(createProductSearchClient({ logger }));

  // The dependency factory only memoizes; it opens no pool and loads no model until the first query,
  // so constructing the app still needs neither a database nor the embedding artifact.
  const answerRagQuery =
    ragQueryService ?? createRagQueryService(createDefaultRagRetrievalDependencies(), logger);

  const app = express();

  // Correlation ID first, so every log line and every error envelope carries one.
  app.use(correlationIdMiddleware);
  app.use(createRequestLogger(logger));

  // Registered before the limiter, so a platform health probe is never rate-limited into failure
  // and never consumes a caller's budget.
  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  // Path-scoped: the limit protects the one route that costs a real upstream call per request.
  app.use("/api/products/search", rateLimiter);
  app.use(createProductSearchRouter(searchProducts));

  // Retrieval only: it returns recorded FAQ evidence and never generates an answer. Deliberately not
  // behind the limiter above, which exists because each product search costs one paid upstream call
  // against our Manufactum credential; a RAG query costs local CPU and one read of our own database.
  app.use(createRagQueryRouter(answerRagQuery));

  // Last: an unmatched route becomes the NOT_FOUND envelope rather than Express's HTML default.
  app.use(notFoundHandler);
  app.use(createErrorMiddleware(logger));

  return app;
}

export const app = createApp();

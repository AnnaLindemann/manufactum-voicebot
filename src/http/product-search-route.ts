import { Router, type Request, type Response } from "express";
import { getCorrelationId } from "./correlation-id.js";
import { parseProductSearchRequest } from "./validation/product-search-request.js";
import "./locals.js";
import { createRequestContext } from "../observability/request-context.js";
import type { ProductSearchService } from "../services/product-search-service.js";

/**
 * `GET /api/products/search` — the single internal route of the MVP.
 *
 * The handler stays thin: validate, delegate, serialize. Express 5 forwards a rejected promise to
 * the error middleware, so failures need no handling here.
 */
export function createProductSearchRouter(searchProducts: ProductSearchService): Router {
  const router = Router();

  router.get("/api/products/search", async (request: Request, response: Response) => {
    // Spread into a plain object: the parsed query has a null prototype.
    const query = parseProductSearchRequest({ ...request.query });

    // The context lets the integration layer report its own timing without knowing about Express.
    const context = createRequestContext(getCorrelationId(response), (upstreamLatencyMs) => {
      response.locals.upstreamLatencyMs = upstreamLatencyMs;
    });

    const result = await searchProducts(query, context);

    response.status(200).json(result);
  });

  return router;
}

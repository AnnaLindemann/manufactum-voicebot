import express, { Router, type Request, type Response } from "express";
import { getCorrelationId } from "./correlation-id.js";
import { parseRagQueryRequest } from "./validation/rag-query-request.js";
import "./locals.js";
import { createRequestContext } from "../observability/request-context.js";
import type { RagQueryService } from "../services/rag-query-service.js";

/**
 * `POST /api/rag/query` — the retrieval boundary an external agent calls.
 *
 * The handler stays thin: parse, validate, delegate, serialize. It holds no database handle, builds
 * no embedding, and contains no SQL. Express 5 forwards a rejected promise to the error middleware,
 * so failures need no handling here.
 */

/**
 * `[D]` The body is one short question, so the parser is capped far below the Express default of
 * 100 kB. A body that cannot possibly be valid is rejected before it is buffered or parsed.
 */
const MAX_BODY_BYTES = "8kb";

export function createRagQueryRouter(answerRagQuery: RagQueryService): Router {
  const router = Router();

  // JSON parsing is mounted on this route alone: it is the only route with a body, and a parser
  // applied globally would accept bodies on routes that have no use for one.
  router.post(
    "/api/rag/query",
    express.json({ limit: MAX_BODY_BYTES }),
    async (request: Request, response: Response) => {
      // `request.body` is `any` from the Express types; validation is the only thing allowed to
      // interpret it, so it enters as `unknown`.
      const query = parseRagQueryRequest(request.body as unknown);

      const context = createRequestContext(getCorrelationId(response));

      const result = await answerRagQuery(query, context);

      response.status(200).json(result);
    },
  );

  return router;
}

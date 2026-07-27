import { z } from "zod";
import type { RagQuery } from "../../domain/rag-query.js";
import { AppError } from "../../errors/app-error.js";

/**
 * Request validation for `POST /api/rag/query`, per `api-contracts.md`.
 *
 * All validation happens at the internal boundary, before any embedding is computed and before any
 * database query is issued. An invalid request becomes `INVALID_REQUEST` and costs no retrieval work.
 */

/**
 * `[D]` The ceiling is ours. A spoken FAQ question is short, and the active embedding profile
 * truncates its input at 512 tokens anyway, so a longer body could only be silently cut — better to
 * reject it than to retrieve against a quietly truncated question. It is higher than the 200 used for
 * the product-search `q`, because that field is a search term and this one is a whole sentence.
 */
export const MAX_RAG_QUERY_LENGTH = 500;

/**
 * Strict: exactly one property, `query`.
 *
 * The strictness is the security control, not a style choice. A caller must not be able to influence
 * retrieval — `maxChunks`, `minScore`, the embedding model or revision, the document filter, the
 * active version, or anything resembling SQL. An unknown property is therefore rejected outright
 * rather than ignored, so a caller that believes it is tuning retrieval is told plainly that it is
 * not, instead of receiving a normal-looking answer produced under settings it did not get.
 */
const ragQueryRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(MAX_RAG_QUERY_LENGTH),
});

/**
 * @throws {AppError} `INVALID_REQUEST` when the body does not satisfy the contract. That includes a
 * missing body, a non-object body, a missing, non-string, empty, whitespace-only, or over-long
 * `query`, and any additional property.
 */
export function parseRagQueryRequest(body: unknown): RagQuery {
  const result = ragQueryRequestSchema.safeParse(body);

  if (!result.success) {
    // The technical detail goes to logs only; the caller receives the safe customer message.
    throw new AppError("INVALID_REQUEST", z.prettifyError(result.error));
  }

  // Trimmed by the schema, so retrieval and the echoed `query` always agree on what was searched.
  return { query: result.data.query };
}

import { z } from "zod";
import type { ProductSearchQuery } from "../../domain/product-search.js";
import { AppError } from "../../errors/app-error.js";

/**
 * Request validation for `GET /api/products/search`, per `api-contracts.md`.
 *
 * All validation happens at the internal boundary, before any upstream call. Invalid input becomes
 * `INVALID_REQUEST` and never reaches upstream: the backend does not use upstream as a validator.
 */

export const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5;

/**
 * Query values arrive as strings. Only a plain integer literal is accepted, so `abc` and `1.5` are
 * rejected as malformed rather than coerced. `0`, `-1`, and values above 5 are then rejected by the
 * range, which keeps the undocumented upstream normalization of `0` and negatives unreachable.
 */
const limitSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(MIN_LIMIT).max(MAX_LIMIT));

const productSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  warehouseId: z.string().trim().min(1).max(64).optional(),
  limit: limitSchema.optional(),
});

/**
 * @throws {AppError} `INVALID_REQUEST` when the query string does not satisfy the contract.
 */
export function parseProductSearchRequest(query: unknown): ProductSearchQuery {
  const result = productSearchQuerySchema.safeParse(query);

  if (!result.success) {
    // The technical detail goes to logs only; the caller receives the safe customer message.
    throw new AppError("INVALID_REQUEST", z.prettifyError(result.error));
  }

  const { q, warehouseId, limit } = result.data;

  return {
    q,
    ...(warehouseId === undefined ? {} : { warehouseId }),
    limit: limit ?? DEFAULT_LIMIT,
  };
}

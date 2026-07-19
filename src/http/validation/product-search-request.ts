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

const MAX_STORE_QUERY_LENGTH = 120;
const MAX_STORE_ID_LENGTH = 64;

const productSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    store: z.string().trim().min(1).max(MAX_STORE_QUERY_LENGTH).optional(),
    storeId: z.string().trim().min(1).max(MAX_STORE_ID_LENGTH).optional(),
    /**
     * Deprecated compatibility alias for `storeId`, validated identically so an existing caller
     * cannot get a laxer rule by using the older spelling. New clients must send `storeId`.
     */
    warehouseId: z.string().trim().min(1).max(MAX_STORE_ID_LENGTH).optional(),
    limit: limitSchema.optional(),
  })
  // At most one store selector. They express the same intent by different means, and honouring one
  // silently would make the response answer a question the caller did not ask. Rejected outright
  // rather than ranked — including `storeId` with its own alias, where a caller sending both
  // conflicting values has no defensible winner.
  .refine(
    ({ store, storeId, warehouseId }) =>
      [store, storeId, warehouseId].filter((selector) => selector !== undefined).length <= 1,
    {
      message:
        "store, storeId, and warehouseId are mutually exclusive; supply at most one. " +
        "warehouseId is a deprecated alias for storeId.",
    },
  );

/**
 * @throws {AppError} `INVALID_REQUEST` when the query string does not satisfy the contract.
 */
export function parseProductSearchRequest(query: unknown): ProductSearchQuery {
  const result = productSearchQuerySchema.safeParse(query);

  if (!result.success) {
    // The technical detail goes to logs only; the caller receives the safe customer message.
    throw new AppError("INVALID_REQUEST", z.prettifyError(result.error));
  }

  const { q, store, storeId, warehouseId, limit } = result.data;

  // The alias collapses into `storeId` here, at the boundary. Nothing downstream knows the older
  // spelling exists, so the deprecated name has exactly one place to be removed from later.
  const resolvedStoreId = storeId ?? warehouseId;

  return {
    q,
    ...(store === undefined ? {} : { store }),
    ...(resolvedStoreId === undefined ? {} : { storeId: resolvedStoreId }),
    limit: limit ?? DEFAULT_LIMIT,
  };
}

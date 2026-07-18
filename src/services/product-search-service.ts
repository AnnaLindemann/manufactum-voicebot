import type { ProductSearchQuery, ProductSearchResponse } from "../domain/product-search.js";
import type { ProductSearchClient } from "../integrations/manufactum/product-search-client.js";
import type { RequestContext } from "../observability/request-context.js";

/**
 * Application service for product search.
 *
 * The upstream client already returns the internal model, so the only thing added here is
 * `warehouseFilterApplied`, which is an internal signal with no upstream counterpart.
 */
export function createProductSearchService(searchProducts: ProductSearchClient) {
  return async function searchProductsForCaller(
    query: ProductSearchQuery,
    context: RequestContext,
  ): Promise<ProductSearchResponse> {
    const result = await searchProducts(query, context);

    return {
      ...result,
      // Records only that a warehouse was supplied and sent upstream. It asserts nothing about
      // whether upstream recognized it, and an empty availability list never means out of stock.
      warehouseFilterApplied: query.warehouseId !== undefined,
    };
  };
}

export type ProductSearchService = ReturnType<typeof createProductSearchService>;

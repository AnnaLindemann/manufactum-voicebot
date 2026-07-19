import type { ProductSearchQuery, ProductSearchResponse } from "../domain/product-search.js";
import { filterAvailabilityToStore, resolveStoreSelection } from "../domain/store-resolution.js";
import type { ProductSearchClient } from "../integrations/manufactum/product-search-client.js";
import type { RequestContext } from "../observability/request-context.js";

/**
 * Application service for product search.
 *
 * The upstream client returns the internal model with every store's availability. This layer
 * resolves the caller's store selection against it and adds `storeResolution`, which is an internal
 * signal with no upstream counterpart.
 */
export function createProductSearchService(searchProducts: ProductSearchClient) {
  return async function searchProductsForCaller(
    query: ProductSearchQuery,
    context: RequestContext,
  ): Promise<ProductSearchResponse> {
    const result = await searchProducts(query, context);

    const { resolution, selectedStoreId } = resolveStoreSelection(result.products, {
      ...(query.store === undefined ? {} : { store: query.store }),
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
    });

    return {
      ...result,
      // Only a resolved selection narrows availability. An ambiguous or unmatched selection leaves
      // the full list intact: emptying it would fabricate the "no entries returned" signal, and
      // silently keeping it under a `matched` status would attribute every store's stock to one
      // branch. `storeResolution` says which of those actually happened.
      products:
        selectedStoreId === null
          ? result.products
          : filterAvailabilityToStore(result.products, selectedStoreId),
      // resultCount stays the upstream product count. Store selection narrows availability within a
      // product; it never removes a product, so `limit` still bounds exactly what it did before.
      storeResolution: resolution,
    };
  };
}

export type ProductSearchService = ReturnType<typeof createProductSearchService>;

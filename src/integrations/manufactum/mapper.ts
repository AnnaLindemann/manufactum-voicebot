import type {
  Availability,
  AvailabilityStatus,
  Product,
  ProductSearchResult,
} from "../../domain/product-search.js";
import type { UpstreamSearchResponse } from "./upstream-schema.js";

/**
 * Pure mapper from the validated raw upstream response to the internal model.
 *
 * Total and pure: it does not throw, does not perform I/O, and does not read the clock. It is the
 * only place where a snake_case upstream field becomes a camelCase internal one.
 */

export type MappedSearchResponse = {
  result: ProductSearchResult;
  /**
   * Raw upstream `status` values that were not recognized and therefore mapped to `unknown`. The
   * caller logs these with the correlation ID; the mapper itself stays free of I/O.
   */
  unmappedUpstreamStatuses: string[];
};

/**
 * `AVAILABLE` and `OUT_OF_STOCK` are the only observed values. Anything else degrades a single
 * availability entry to `unknown` instead of failing the response or being coerced into `in_stock`.
 */
function mapStatus(upstreamStatus: string): AvailabilityStatus | null {
  switch (upstreamStatus) {
    case "AVAILABLE":
      return "in_stock";
    case "OUT_OF_STOCK":
      return "out_of_stock";
    default:
      return null;
  }
}

export function mapSearchResponse(upstream: UpstreamSearchResponse): MappedSearchResponse {
  const unmappedUpstreamStatuses: string[] = [];

  const products: Product[] = upstream.products.map((upstreamProduct) => {
    const availability: Availability[] = upstreamProduct.warehouse_availability.map((entry) => {
      const status = mapStatus(entry.status);

      if (status === null) {
        unmappedUpstreamStatuses.push(entry.status);
      }

      return {
        warehouseId: entry.warehouse_id,
        warehouseName: entry.warehouse,
        address: entry.address,
        phone: entry.phone,
        openingHours: entry.opening_hours,
        status: status ?? "unknown",
        // Carried through unchanged even when the status could not be interpreted.
        stock: entry.stock,
      };
    });

    return {
      sku: upstreamProduct.sku,
      name: upstreamProduct.name,
      // Verbatim and unparsed. `manufacturer` and `status_text` stop here by design.
      priceText: upstreamProduct.price,
      description: upstreamProduct.description,
      highlights: upstreamProduct.highlights,
      productUrl: upstreamProduct.product_url,
      availability,
    };
  });

  return {
    result: {
      query: upstream.query,
      resultCount: upstream.result_count,
      products,
    },
    unmappedUpstreamStatuses,
  };
}

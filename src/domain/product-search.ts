/**
 * Internal domain models for product search, as contracted in `api-contracts.md`.
 *
 * These are camelCase and carry a closed `status` enum. Raw snake_case upstream types live in
 * `src/integrations/manufactum/` and never appear in a route, controller, or service signature.
 */

/** A validated search request. Only this shape reaches the application service and the client. */
export type ProductSearchQuery = {
  q: string;
  /** Opaque; passed through verbatim as the upstream `warehouse` parameter. */
  warehouseId?: string;
  /** Always resolved during validation, so `limit` is sent upstream explicitly even at its default. */
  limit: number;
};

/**
 * `unknown` means "availability could not be interpreted". It is neither available nor unavailable
 * and must never be spoken as stock information. See `D-015`.
 */
export type AvailabilityStatus = "in_stock" | "out_of_stock" | "unknown";

export type Availability = {
  warehouseId: string;
  warehouseName: string;
  address: string | null;
  phone: string | null;
  openingHours: Record<string, string>;
  status: AvailabilityStatus;
  stock: number | null;
};

export type Product = {
  sku: string;
  name: string;
  /** Verbatim localized upstream price string, never parsed into an amount. See `D-015`. */
  priceText: string | null;
  description: string | null;
  highlights: string[];
  productUrl: string | null;
  /**
   * An empty array means only that no availability entries were returned. It never means "out of
   * stock", which is expressed solely by a present entry with `status: "out_of_stock"`.
   */
  availability: Availability[];
};

/** What the integration layer returns: the mapped upstream payload and nothing added. */
export type ProductSearchResult = {
  query: string;
  resultCount: number;
  products: Product[];
};

/** The public response body, adding only the internal `warehouseFilterApplied` signal. */
export type ProductSearchResponse = ProductSearchResult & {
  /**
   * Records only whether a `warehouseId` was supplied and therefore sent upstream. It asserts
   * nothing about whether upstream recognized it.
   */
  warehouseFilterApplied: boolean;
};

/**
 * Internal domain models for product search, as contracted in `api-contracts.md`.
 *
 * These are camelCase and carry a closed `status` enum. Raw snake_case upstream types live in
 * `src/integrations/manufactum/` and never appear in a route, controller, or service signature.
 */

/** A validated search request. Only this shape reaches the application service and the client. */
export type ProductSearchQuery = {
  q: string;
  /**
   * A human-readable store or city query, e.g. `"Berlin"`. Resolved locally against the availability
   * entries of the upstream response; never sent upstream. Mutually exclusive with `storeId`.
   */
  store?: string;
  /**
   * An exact `warehouseId`. Resolved locally against the availability entries of the upstream
   * response; never sent upstream. Mutually exclusive with `store`.
   */
  storeId?: string;
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

/**
 * The minimal identity of a store, projected from the availability entries of the upstream
 * response. It carries no stock information: a store is a place, not a stock claim.
 */
export type Store = {
  /** The `warehouseId` of the availability entries this store was projected from. */
  storeId: string;
  warehouseName: string;
  address: string | null;
};

/** The query text a resolution was attempted with. Present only when `store` was supplied. */
type ResolutionQuery = { query?: string };

/**
 * The outcome of resolving the caller's store selection against the stores actually present in this
 * response. Each status is a distinct, non-overlapping situation, and only `matched` licenses
 * filtering `availability` down to one store.
 */
export type StoreResolution =
  /** Neither `store` nor `storeId` was supplied; `availability` lists every store as before. */
  | { status: "not_requested" }
  /** Exactly one store matched. `availability` is filtered to it. */
  | ({ status: "matched"; selectedStore: Store } & ResolutionQuery)
  /** More than one store matched. No store is selected, so nothing is filtered. */
  | { status: "ambiguous"; query: string; candidates: Store[] }
  /** No store matched. No store is selected, so nothing is filtered. */
  | ({ status: "not_found" } & ResolutionQuery);

/** The public response body, adding only the internal `storeResolution` signal. */
export type ProductSearchResponse = ProductSearchResult & {
  storeResolution: StoreResolution;
};
